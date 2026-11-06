// Container build guarantees that must not regress (issue #38). Files are read as text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLines } from "./workflow.js";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const DIGEST = /@sha256:[0-9a-f]{64}\b/u;

describe("container workflow", () => {
  const workflow = read(".github/workflows/container.yml");

  it("uses no emulator: each architecture builds on its own native runner", () => {
    expect(workflow).not.toMatch(/setup-qemu-action|binfmt/u);
    expect(workflow).not.toMatch(/platforms: linux\/amd64,linux\/arm64/u);
    expect(workflow).toContain("runner: ubuntu-24.04-arm");
    expect(workflow).toContain("platforms: linux/${{ matrix.arch }}");
  });

  it("pins the BuildKit builder image by digest for every buildx setup", () => {
    const pinned = /BUILDKIT_IMAGE: moby\/buildkit:v[\d.]+(@sha256:[0-9a-f]{64})$/mu.exec(workflow);
    expect(pinned).not.toBeNull();
    const setups = workflow.split("docker/setup-buildx-action@").length - 1;
    const withImage = workflow.split("driver-opts: image=${{ env.BUILDKIT_IMAGE }}").length - 1;
    expect(setups).toBeGreaterThan(0);
    expect(withImage).toBe(setups);
  });

  it("verifies Trivy downloads against a pinned SHA-256 for each architecture", () => {
    for (const asset of ["Linux-64bit", "Linux-ARM64"]) {
      expect(workflow).toMatch(
        new RegExp(`trivy: ${asset}\\n\\s+trivy_sha256: [0-9a-f]{64}\\n`, "u"),
      );
    }
    expect(workflow).toContain("sha256sum --check --strict");
  });

  it("pushes by digest, then tags and signs the merged image by digest", () => {
    expect(workflow).toContain("push-by-digest=true");
    expect(workflow).toContain("docker buildx imagetools create");
    expect(workflow).toContain('cosign sign --yes --recursive "${IMAGE}@${DIGEST}"');
  });

  it("keeps ${{ }} expressions out of run steps", () => {
    for (const { line, text } of runLines(workflow)) {
      expect(text, `line ${String(line)}`).not.toContain("${{");
    }
  });
});

describe("Dockerfile", () => {
  const dockerfile = read("Dockerfile");

  it("pulls no unpinned frontend or base image", () => {
    expect(dockerfile).not.toMatch(/^#\s*syntax=/mu);
    const froms = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    expect(froms.length).toBeGreaterThan(0);
    for (const from of froms) {
      if (/^FROM \w+ AS /u.test(from)) continue; // a previous stage, not an image
      expect(from, from).toMatch(DIGEST);
    }
  });

  it("has a health check that needs no shell", () => {
    expect(dockerfile).toMatch(
      /^HEALTHCHECK .*\\\n {2}CMD \["\/nodejs\/bin\/node", "-e", ".*\/healthz/mu,
    );
  });
});

describe("deploy/", () => {
  it("never builds over a published image name in the main Compose file", () => {
    const compose = read("deploy/docker-compose.yml");
    expect(compose).not.toMatch(/^\s+build:/mu);
    const build = read("deploy/docker-compose.build.yml");
    expect(build).toMatch(/^\s+build:/mu);
    expect(build).toContain("image: nz-legislation-mcp:local");
  });

  it("starts Caddy only once the server is healthy", () => {
    expect(read("deploy/docker-compose.yml")).toMatch(
      /depends_on:\n\s+mcp:\n\s+condition: service_healthy/u,
    );
  });
});
