import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertStandalonePackageLock } from "./package-lock-guard.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");

assertStandalonePackageLock(packageDir);
console.log("package-lock.json is standalone and safe for Railway/npm ci deploys.");
