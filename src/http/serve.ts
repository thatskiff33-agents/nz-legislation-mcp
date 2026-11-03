/**
 * Starts HTTP (remote) mode: configuration checks, authorization-server discovery, token
 * verifier, listener and graceful shutdown.
 */
import type { Server } from "node:http";
import type { OAuthMetadata } from "@modelcontextprotocol/server";
import { ConfigError } from "../config.js";
import { buildDeps, type MainIo } from "../main.js";
import { SERVER_NAME } from "../version.js";
import {
  createJwtVerifier,
  discoverAuthorizationServer,
  isSecureKeyUrl,
  remoteKeys,
} from "./auth.js";
import { createHttpApp } from "./app.js";
import { loadHttpConfig, MCP_PATH } from "./config.js";
import type { listen } from "./node.js";

export interface HttpIo extends MainIo {
  readonly listen: typeof listen;
  readonly fetch: typeof fetch;
}

/** Starts the HTTP server. Returns an exit code for start-up failures, else undefined. */
export async function serveHttp(io: HttpIo): Promise<number | undefined> {
  const fail = (message: string): number => {
    io.stderr(`${SERVER_NAME}: ${message}\n`);
    return 1;
  };

  let deps;
  let config;
  try {
    deps = buildDeps(io.env, io.stderr);
    config = loadHttpConfig(io.env);
  } catch (error) {
    if (error instanceof ConfigError) return fail(error.message);
    throw error;
  }
  const { logger } = deps;

  let auth;
  if (config.oauth !== undefined) {
    let metadata;
    try {
      metadata = await discoverAuthorizationServer(config.oauth.issuer, io.fetch);
    } catch (error) {
      return fail((error as Error).message);
    }
    const jwks =
      config.oauth.jwksUrl ??
      (metadata.jwks_uri === undefined ? undefined : new URL(metadata.jwks_uri));
    if (jwks === undefined) {
      return fail(
        "The authorization server publishes no jwks_uri; set LEGISLATION_NZ_OAUTH_JWKS_URL.",
      );
    }
    if (!isSecureKeyUrl(jwks)) {
      return fail(`Refusing to fetch signing keys over plain http (${jwks.href}).`);
    }
    if (config.oauth.audience !== config.resourceUrl.href) {
      logger.warn("token audience differs from the public URL", {
        audience: config.oauth.audience,
        publicUrl: config.resourceUrl.href,
        note: "Use this audience only for this server, or tokens issued for other services could be accepted.",
      });
    }
    auth = {
      verifier: createJwtVerifier({
        issuer: metadata.issuer,
        audience: config.oauth.audience,
        requireAtJwt: config.oauth.requireAtJwt,
        resource: config.resourceUrl,
        keys: remoteKeys(jwks),
      }),
      authorizationServer: metadata as unknown as OAuthMetadata,
    };
  }

  const app = createHttpApp({ config, deps, logger, ...(auth === undefined ? {} : { auth }) });
  let server: Server;
  try {
    server = await io.listen(app.fetch, { host: config.host, port: config.port, logger });
  } catch (error) {
    return fail(
      `Could not listen on ${config.host}:${String(config.port)} (${(error as Error).message}).`,
    );
  }
  logger.info("listening", {
    address: `http://${config.host}:${String(config.port)}${MCP_PATH}`,
    publicUrl: config.resourceUrl.href,
    oauth: auth !== undefined,
  });
  if (auth === undefined) {
    logger.warn("no authentication: HTTP mode is bound to loopback only and must not be exposed");
  }

  io.onUnhandledRejection((reason) => {
    logger.error("unhandled promise rejection", { reason });
  });
  const stop = (): void => {
    logger.info("shutting down");
    server.close();
    // A rejection here is logged by the unhandled-rejection handler above.
    void app.close();
  };
  io.onSignal("SIGINT", stop);
  io.onSignal("SIGTERM", stop);
  return undefined;
}
