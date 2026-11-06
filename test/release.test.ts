// Release pipeline guarantees that must not regress (issue #36). The workflow is read as text:
// each top-level job is the block from its "  <name>:" line to the next one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFileInfo } from "prettier";
import { describe, expect, it } from "vitest";
import { runLines } from "./workflow.js";

const ROOT = join(import.meta.dirname, "..");
const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");

/** Top-level jobs of release.yml, by name, without comment lines (comments are not commands). */
function jobs(): Map<string, string> {
  const body = workflow
    .slice(workflow.indexOf("\njobs:\n"))
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
  const result = new Map<string, string>();
  const starts = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):\n/gmu)];
  starts.forEach((match, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]?.index : body.length;
    result.set(String(match[1]), body.slice(match.index, end));
  });
  return result;
}

/** Artifact names a job uploads (upload-artifact) or downloads (download-artifact). */
function artifacts(job: string, action: "upload" | "download"): string[] {
  const steps = job.split(/\n {6}- /u).filter((s) => s.includes(`actions/${action}-artifact@`));
  return steps.map((s) => /\n {10}name: (\S+)/u.exec(s)?.[1] ?? "?");
}

describe("release workflow", () => {
  const all = jobs();
  const job = (name: string): string => {
    const text = all.get(name);
    if (text === undefined) throw new Error(`release.yml has no job "${name}"`);
    return text;
  };

  it("has the expected jobs", () => {
    expect([...all.keys()]).toEqual([
      "release-please",
      "sync-release-pr",
      "pack",
      "bundle-build",
      "npm",
      "bundle",
      "container",
      "publish-release",
    ]);
  });

  it("packs the npm tarball in a job that starts nothing after packing but the upload", () => {
    const pack = job("pack");
    expect(pack).toContain("pnpm pack");
    expect(pack).not.toMatch(/npx|mcpb/u);
    // The packing step is the last run step; only the artifact upload may follow it.
    const steps = pack.split(/\n {6}- /u);
    const packStep = steps.findIndex((s) => s.startsWith("id: pack"));
    expect(packStep).toBeGreaterThan(0);
    const after = steps.slice(packStep + 1);
    expect(after).toHaveLength(1);
    expect(after[0]?.startsWith("uses: actions/upload-artifact@")).toBe(true);
    // Within the packing step, nothing runs after `pnpm pack` except shell built-ins and hashing.
    const packLines = (steps[packStep] ?? "").split("\n");
    const afterPack = packLines.slice(packLines.findIndex((l) => l.includes("pnpm pack")) + 1);
    expect(afterPack.length).toBeGreaterThan(0);
    for (const line of afterPack.map((l) => l.trim()).filter((l) => l !== "")) {
      expect(line).toMatch(/^(?:tarball=|sha=|echo )/u);
      // No tool may be started in command position (line start, after ; & | or inside $( ).
      expect(line).not.toMatch(/(?:^|[;&|]|\$\()\s*(?:node|npx|pnpm|npm|bash|sh)\b/u);
    }
    expect(artifacts(pack, "upload")).toEqual(["npm-tarball"]);
    expect(pack).toContain("tarball: ${{ steps.pack.outputs.tarball }}");
    expect(pack).toContain("sha256: ${{ steps.pack.outputs.sha256 }}");
  });

  it("builds the bundle only in a job that cannot produce the npm tarball", () => {
    for (const [name, text] of all) {
      if (name !== "bundle-build") expect(text, name).not.toMatch(/build-mcpb|mcpb@/u);
    }
    const build = job("bundle-build");
    expect(build).toContain("scripts/build-mcpb.sh");
    expect(build).not.toContain("pnpm pack");
    expect(artifacts(build, "upload")).toEqual(["desktop-bundle"]);
  });

  it("runs no third-party bundle tool anywhere in a release (issue #37)", () => {
    const commands = (text: string): string =>
      text
        .split("\n")
        .filter((line) => !/^\s*#/u.test(line))
        .join("\n");
    expect(commands(workflow)).not.toMatch(/npx|bunx|pnpm dlx|npm exec|yarn dlx|mcpb@|check-mcpb/u);
    const build = commands(readFileSync(join(ROOT, "scripts/build-mcpb.sh"), "utf8"));
    expect(build).not.toMatch(/npx|mcpb@|pnpm dlx|npm exec/u);
    expect(build).toContain("zip -q -r -9 -X -D");
    // The official CLI checks the bundle in CI only (the claude desktop bundle job).
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("- run: scripts/check-mcpb.sh");
  });

  it("uploads the npm tarball from the pack job only", () => {
    for (const [name, text] of all) {
      if (name !== "pack") expect(artifacts(text, "upload"), name).not.toContain("npm-tarball");
    }
  });

  it("verifies every downloaded artefact against a job output, not a file in the artefact", () => {
    for (const name of ["bundle-build", "npm"]) {
      const text = job(name);
      expect(artifacts(text, "download"), name).toEqual(["npm-tarball"]);
      expect(text, name).toContain("SHA256: ${{ needs.pack.outputs.sha256 }}");
      expect(text, name).toContain("sha256sum --check --strict");
    }
    const bundle = job("bundle");
    expect(artifacts(bundle, "download")).toEqual(["npm-tarball", "desktop-bundle"]);
    expect(bundle).toContain("NPM_SHA256: ${{ needs.pack.outputs.sha256 }}");
    expect(bundle).toContain("BUNDLE_SHA256: ${{ needs.bundle-build.outputs.sha256 }}");
    expect(bundle).toContain("sha256sum --check --strict SHA256SUMS");
    // A job output cannot smuggle extra lines into SHA256SUMS.
    expect(bundle).toContain("^[0-9a-f]{64}$");
  });

  it("stops npm and the container if the bundle build fails", () => {
    expect(job("npm")).toContain("needs: [release-please, pack, bundle-build]");
    expect(job("container")).toContain("needs: [release-please, pack, bundle-build]");
  });

  it("publishes the tarball by local path, and CI dry-runs the same command (#77)", () => {
    // npm reads a bare "dir/file.tgz" as a GitHub user/repo, so a local tarball needs "./".
    const publish = (text: string): string[] =>
      runLines(text)
        .map(({ text: line }) => line.trim())
        .filter((line) => line.startsWith("npm publish "));
    const release = publish(workflow);
    expect(release).toEqual([
      'npm publish "./npm-tarball/$TARBALL" --access public --provenance --ignore-scripts',
    ]);
    const ci = publish(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));
    expect(ci).toHaveLength(1);
    // The dry run is the release command without --provenance (it needs the release OIDC token).
    const words = (line: string): string[] => line.split(" ").sort();
    expect(words(ci[0] ?? "")).toEqual(
      words(`${(release[0] ?? "").replace(" --provenance", "")} --dry-run`),
    );
  });

  it("dry-runs a version npm has not published, so CI passes between releases (#82)", () => {
    // npm refuses even a dry run of a published version; the CI job moves to the next patch
    // version (without a git tag or scripts) before packing, and only there.
    const ci = runLines(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")).map(
      ({ text }) => text.trim(),
    );
    const at = (prefix: string): number => ci.findIndex((line) => line.startsWith(prefix));
    expect(ci).toContain("npm version patch --no-git-tag-version --ignore-scripts");
    expect(at("npm version patch")).toBeGreaterThanOrEqual(0);
    expect(at("npm version patch")).toBeLessThan(at("pnpm pack"));
    expect(at("pnpm pack")).toBeLessThan(at("npm publish "));
    expect(workflow).not.toMatch(/npm version|npm pkg set/u);
  });

  it("publishes npm with no install, no scripts and provenance", () => {
    const npm = job("npm");
    expect(npm).toContain("environment: release");
    expect(npm).toContain("--ignore-scripts");
    expect(npm).toContain("--provenance");
    expect(npm).not.toMatch(/pnpm|npm (?:install|ci)|npx/u);
  });

  it("writes release branches, pull requests and tags with the release App, not GITHUB_TOKEN (#53)", () => {
    const appStep =
      "uses: actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0";
    const rp = job("release-please");
    expect(rp).toContain(appStep);
    expect(rp).toContain("client-id: ${{ vars.RELEASE_APP_CLIENT_ID }}");
    expect(rp).toContain("private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}");
    expect(rp).toContain("token: ${{ steps.app-token.outputs.token }}");
    expect(rp).toMatch(/permissions:\n {6}contents: read\n/u);
    // No job-level write permission (the App's own permission-* inputs are indented further).
    expect(rp).not.toMatch(/^ {6}(?:contents|pull-requests): write$/mu);
    // The App token is narrowed to what release-please needs.
    expect(rp).toContain("permission-contents: write");
    expect(rp).toContain("permission-pull-requests: write");

    const sync = job("sync-release-pr");
    expect(sync).toContain(appStep);
    expect(sync).toContain("client-id: ${{ vars.RELEASE_APP_CLIENT_ID }}");
    expect(sync).toContain("private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}");
    expect(sync).toContain("token: ${{ steps.app-token.outputs.token }}");
    expect(sync).toMatch(/permissions:\n {6}contents: read\n/u);
    expect(sync).not.toContain("permission-pull-requests");
    expect(sync).not.toContain("github-actions[bot]");
    // The commit is attributed to the App's bot account: <id>+<slug>[bot]@users.noreply.github.com.
    expect(sync).toContain(
      'git config user.email "${bot_id}+${APP_SLUG}[bot]@users.noreply.github.com"',
    );
  });

  it("keeps the App key in a main-only environment and never in a shell step (#53)", () => {
    for (const name of ["release-please", "sync-release-pr"]) {
      expect(job(name), name).toContain("    environment: release-pr\n");
    }
    // The key appears exactly twice, each as the private-key input of an app-token step.
    const uses = workflow.split("secrets.RELEASE_APP_PRIVATE_KEY").length - 1;
    expect(uses).toBe(2);
    expect(workflow.split("private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}").length - 1).toBe(
      2,
    );
    for (const { line, text } of runLines(workflow)) {
      expect(text, `line ${String(line)}`).not.toContain("RELEASE_APP_PRIVATE_KEY");
    }
  });

  it("publishes the draft GitHub release only after every artefact is out", () => {
    const publish = job("publish-release");
    expect(publish).toContain("needs: [release-please, npm, bundle, container]");
    expect(publish).toContain('gh release edit "$TAG" --draft=false');
  });

  it("keeps ${{ }} expressions out of run steps, including multi-line bodies", () => {
    const lines = runLines(workflow);
    expect(lines.length).toBeGreaterThan(20);
    for (const { line, text } of lines) expect(text, `line ${String(line)}`).not.toContain("${{");
  });

  it("lets a re-run replace partly uploaded release assets", () => {
    expect(job("bundle")).toContain("gh release upload");
    expect(job("bundle")).toContain("--clobber");
  });
});

describe("release-please configuration", () => {
  const config = JSON.parse(readFileSync(join(ROOT, "release-please-config.json"), "utf8")) as {
    packages: Record<string, Record<string, unknown>>;
  };

  it("creates draft releases with their tags created at once", () => {
    expect(config.packages["."]).toMatchObject({ draft: true, "force-tag-creation": true });
  });

  it("leaves the generated CHANGELOG.md to release-please (Prettier ignores it)", async () => {
    const info = await getFileInfo(join(ROOT, "CHANGELOG.md"), {
      ignorePath: join(ROOT, ".prettierignore"),
    });
    expect(info.ignored).toBe(true);
  });
});
