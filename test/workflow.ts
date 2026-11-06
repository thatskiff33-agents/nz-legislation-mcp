// Helpers for tests that read GitHub Actions workflow files as text.

/**
 * Every line of every `run:` step (the one-line form and each line of a `run: |` block), with its
 * 1-based line number, so tests can check what shell code a workflow runs.
 */
export function runLines(workflow: string): { readonly line: number; readonly text: string }[] {
  const lines = workflow.split("\n");
  const found: { line: number; text: string }[] = [];
  lines.forEach((line, i) => {
    const run = /^(\s+)(?:- )?run: (.*)$/u.exec(line);
    if (run === null) return;
    found.push({ line: i + 1, text: run[2] ?? "" });
    if (run[2] !== "|") return;
    // The block body is every following line indented deeper than the "run:" key.
    const keyIndent = (run[1] ?? "").length + (line.trimStart().startsWith("- ") ? 2 : 0);
    for (let j = i + 1; j < lines.length; j += 1) {
      const body = lines[j] ?? "";
      if (body.trim() !== "" && body.length - body.trimStart().length <= keyIndent) break;
      found.push({ line: j + 1, text: body });
    }
  });
  return found;
}
