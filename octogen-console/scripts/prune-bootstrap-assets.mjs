import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const bootstrapDir = path.join(packageDir, "public", "bootstrap");
const manifestPath = path.join(bootstrapDir, "control-ui-manifest.json");

function parseArgs(argv) {
  return {
    apply: argv.includes("--apply"),
  };
}

function getAssetBasename(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }
  try {
    return path.basename(new URL(rawUrl).pathname);
  } catch {
    return path.basename(rawUrl);
  }
}

function loadManifestKeepSet() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const keep = new Set(["control-ui-manifest.json"]);
  const controlUiAsset = getAssetBasename(manifest.url);
  if (controlUiAsset) {
    keep.add(controlUiAsset);
  }
  const backendAsset = getAssetBasename(manifest.backendPackageUrl);
  if (backendAsset) {
    keep.add(backendAsset);
  }
  return { manifest, keep };
}

function isPrunableAsset(fileName, keep) {
  if (keep.has(fileName)) {
    return false;
  }
  return /^control-ui-.*\.tar\.gz$/.test(fileName) || /^openclaw-.*\.tar\.gz$/.test(fileName);
}

function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const { manifest, keep } = loadManifestKeepSet();
  const prunable = fs
    .readdirSync(bootstrapDir)
    .filter((fileName) => isPrunableAsset(fileName, keep))
    .toSorted();

  if (prunable.length === 0) {
    console.log("No obsolete bootstrap assets found.");
    return;
  }

  if (apply) {
    for (const fileName of prunable) {
      fs.rmSync(path.join(bootstrapDir, fileName), { force: true });
    }
    console.log(
      `Removed ${prunable.length} obsolete bootstrap assets. Kept manifest ${manifest.version} assets: ${Array.from(
        keep,
      ).join(", ")}`,
    );
    return;
  }

  console.log(
    `Would remove ${prunable.length} obsolete bootstrap assets. Active manifest ${manifest.version} keeps: ${Array.from(
      keep,
    ).join(", ")}`,
  );
  for (const fileName of prunable) {
    console.log(fileName);
  }
}

main();
