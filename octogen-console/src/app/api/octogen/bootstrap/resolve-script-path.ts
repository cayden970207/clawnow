import fsSync from "node:fs";
import path from "node:path";

function uniqueCandidates(candidates: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function resolveBundledBootstrapScriptPath(
  scriptName: string,
  cwd: string = process.cwd(),
): string | null {
  const candidates = uniqueCandidates([
    // Canonical source when a dev server is started from the repo root.
    path.resolve(cwd, "octogen-console", "scripts", scriptName),
    // Canonical source when running from the OCTOGEN CONSOLE package (deployed/slim package).
    path.resolve(cwd, "scripts", scriptName),
    path.resolve(cwd, "..", "octogen-console", "scripts", scriptName),
    // Compatibility fallbacks for older repo layouts / copied helper scripts.
    path.resolve(cwd, "..", "scripts", scriptName),
    path.resolve(cwd, "..", "..", "scripts", scriptName),
  ]);
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
