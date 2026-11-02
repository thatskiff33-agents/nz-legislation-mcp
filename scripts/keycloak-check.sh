#!/usr/bin/env bash
# Reproducible check of the Keycloak recipe in docs/self-hosting.md (run manually; needs Docker).
#
# Starts a throwaway Keycloak, creates a realm with an audience mapper, a key-holder user and a
# second user, then runs this server (HTTP mode, OAuth) against it and checks that:
#   1. the key holder's token gets MCP access (tools listed through the official client);
#   2. a valid token for another user gets 403;
#   3. no token, and a tampered token, get 401 with resource_metadata.
# No Legislation API calls are made (a dummy key is used). Everything is removed afterwards.
set -euo pipefail

KC_IMAGE="quay.io/keycloak/keycloak:26.4.5@sha256:653852bfdea2be6e958b9e90a976eff1c6de34edd55f2f679bdc48ef16bc528e"
KC_PORT=18180
MCP_PORT=18080
NAME="nzlm-keycloak-check-$$"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "Starting Keycloak..."
docker run -d --name "$NAME" -p "127.0.0.1:${KC_PORT}:8080" \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=local-check-only \
  "$KC_IMAGE" start-dev >/dev/null
KC="http://127.0.0.1:${KC_PORT}"
for _ in $(seq 1 90); do curl -sf "$KC/realms/master" >/dev/null && break; sleep 2; done

ADMIN=$(curl -sf -d client_id=admin-cli -d username=admin -d password=local-check-only \
  -d grant_type=password "$KC/realms/master/protocol/openid-connect/token" | jq -r .access_token)
api() { curl -sf -X POST -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' "$KC/admin/realms$1" -d "$2"; }

RESOURCE="http://localhost:${MCP_PORT}/mcp"
api "" '{"realm":"nzlm","enabled":true}'
# A test client (password grant, for this check only) with an Audience mapper: aud = this server.
api "/nzlm/clients" "{\"clientId\":\"mcp-check\",\"publicClient\":true,\"directAccessGrantsEnabled\":true,\"standardFlowEnabled\":false,\"protocolMappers\":[{\"name\":\"mcp-audience\",\"protocol\":\"openid-connect\",\"protocolMapper\":\"oidc-audience-mapper\",\"config\":{\"included.custom.audience\":\"$RESOURCE\",\"access.token.claim\":\"true\",\"id.token.claim\":\"false\"}}]}"
for user in keyholder other; do
  api "/nzlm/users" "{\"username\":\"$user\",\"enabled\":true,\"emailVerified\":true,\"firstName\":\"T\",\"lastName\":\"U\",\"email\":\"$user@example.com\",\"credentials\":[{\"type\":\"password\",\"value\":\"local-check-only\",\"temporary\":false}]}"
done
SUBJECT=$(curl -sf -H "Authorization: Bearer $ADMIN" "$KC/admin/realms/nzlm/users?username=keyholder&exact=true" | jq -r '.[0].id')
token() { curl -sf -d client_id=mcp-check -d "username=$1" -d password=local-check-only -d grant_type=password -d scope=openid "$KC/realms/nzlm/protocol/openid-connect/token" | jq -r .access_token; }
token keyholder > "$WORK/keyholder"
token other > "$WORK/other"
ISSUER=$(curl -sf "$KC/realms/nzlm/.well-known/openid-configuration" | jq -r .issuer)

echo "Building and starting the server (issuer $ISSUER)..."
(cd "$REPO" && pnpm build >/dev/null)
LEGISLATION_NZ_API_KEY=dummy-key-for-tests-only-xxxxxxxx \
LEGISLATION_NZ_HTTP_PORT=$MCP_PORT \
LEGISLATION_NZ_PUBLIC_URL="$RESOURCE" \
LEGISLATION_NZ_OAUTH_ISSUER="$ISSUER" \
LEGISLATION_NZ_OAUTH_ALLOWED_SUBJECTS="$SUBJECT" \
  node "$REPO/dist/cli.js" http 2>"$WORK/server.log" &
SERVER_PID=$!
sleep 2

cat > "$WORK/check.mjs" <<JS
import { readFileSync } from "node:fs";
const { Client, StreamableHTTPClientTransport } = await import("${REPO}/node_modules/@modelcontextprotocol/client/dist/index.mjs");
const url = new URL("${RESOURCE}");
const read = (f) => readFileSync("${WORK}/" + f, "utf8").trim();
const keyholder = read("keyholder");
const client = new Client({ name: "keycloak-check", version: "0" });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer " + keyholder } } }));
const tools = (await client.listTools()).tools.length;
await client.close();
const post = (token) => fetch(url, { method: "POST", headers: { ...(token ? { authorization: "Bearer " + token } : {}), "content-type": "application/json" }, body: "{}" });
const tampered = keyholder.slice(0, -4) + (keyholder.endsWith("AAAA") ? "BBBB" : "AAAA");
const results = { tools, other: (await post(read("other"))).status, none: (await post()).status, tampered: (await post(tampered)).status };
console.log(JSON.stringify(results));
process.exit(tools > 0 && results.other === 403 && results.none === 401 && results.tampered === 401 ? 0 : 1);
JS
if node "$WORK/check.mjs"; then
  echo "PASS: key holder served; other user 403; missing and tampered tokens 401."
  if grep -q "$(head -c 24 "$WORK/keyholder")" "$WORK/server.log"; then echo "FAIL: token fragment found in server log"; exit 1; fi
else
  echo "FAIL"; cat "$WORK/server.log"; exit 1
fi
