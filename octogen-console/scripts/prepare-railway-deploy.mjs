import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertStandalonePackageLock } from "./package-lock-guard.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const manifestPath = path.join(packageDir, "public", "bootstrap", "control-ui-manifest.json");

function parseArgs(argv) {
  const args = { outDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") {
      args.outDir = argv[index + 1] ? path.resolve(argv[index + 1]) : null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
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

function getActiveBootstrapAssets() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const assetBasenames = new Set(["control-ui-manifest.json"]);
  const currentControlUiAsset = getAssetBasename(manifest.url);
  if (currentControlUiAsset) {
    assetBasenames.add(currentControlUiAsset);
  }
  const currentBackendAsset = getAssetBasename(manifest.backendPackageUrl);
  if (currentBackendAsset) {
    assetBasenames.add(currentBackendAsset);
  }
  return { manifest, assetBasenames };
}

function shouldExclude(relativePath, activeBootstrapAssets) {
  if (!relativePath) {
    return false;
  }

  const normalized = relativePath.split(path.sep).join("/");
  const topLevel = normalized.split("/")[0];
  if ([".next", "node_modules"].includes(topLevel)) {
    return true;
  }
  if (
    [".env", ".env.local", ".DS_Store", "tsconfig.tsbuildinfo", "npm-debug.log"].includes(
      path.basename(normalized),
    )
  ) {
    return true;
  }

  if (normalized.startsWith("public/bootstrap/")) {
    const basename = path.basename(normalized);
    if (basename.endsWith(".tar.gz") && !activeBootstrapAssets.has(basename)) {
      return true;
    }
  }

  return false;
}

function ensureBootstrapAssetsExist(activeBootstrapAssets) {
  for (const basename of activeBootstrapAssets) {
    const assetPath = path.join(packageDir, "public", "bootstrap", basename);
    if (!fs.existsSync(assetPath)) {
      throw new Error(`Missing active bootstrap asset referenced by manifest: ${basename}`);
    }
  }
}

function prepareDeployDir(outDir, activeBootstrapAssets) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.cpSync(packageDir, outDir, {
    recursive: true,
    filter: (sourcePath) => {
      const relativePath = path.relative(packageDir, sourcePath);
      return !shouldExclude(relativePath, activeBootstrapAssets);
    },
  });
}

function main() {
  const { outDir: explicitOutDir } = parseArgs(process.argv.slice(2));
  assertStandalonePackageLock(packageDir);

  const { manifest, assetBasenames } = getActiveBootstrapAssets();
  ensureBootstrapAssetsExist(assetBasenames);

  const outDir = explicitOutDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "octogen-railway-stage-"));
  prepareDeployDir(outDir, assetBasenames);

  console.error(
    `Prepared Railway deploy dir at ${outDir} with manifest ${manifest.version} and assets: ${Array.from(
      assetBasenames,
    ).join(", ")}`,
  );
  process.stdout.write(`${outDir}\n`);
}

main();
