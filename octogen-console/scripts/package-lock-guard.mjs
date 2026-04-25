import fs from "node:fs";
import path from "node:path";

function isBadResolvedPath(resolved) {
  return (
    typeof resolved === "string" &&
    (resolved.startsWith("..") || resolved.startsWith("file:") || resolved.includes("/.pnpm/"))
  );
}

export function loadPackageLock(packageDir) {
  const packageLockPath = path.join(packageDir, "package-lock.json");
  return {
    packageLockPath,
    packageLock: JSON.parse(fs.readFileSync(packageLockPath, "utf8")),
  };
}

export function findStandalonePackageLockIssues(packageLock) {
  const issues = [];
  for (const [packagePath, entry] of Object.entries(packageLock.packages ?? {})) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (entry.link === true) {
      issues.push({
        packagePath,
        reason: "link=true",
      });
      continue;
    }
    if (isBadResolvedPath(entry.resolved)) {
      issues.push({
        packagePath,
        reason: `resolved=${entry.resolved}`,
      });
    }
  }
  return issues;
}

export function assertStandalonePackageLock(packageDir) {
  const { packageLockPath, packageLock } = loadPackageLock(packageDir);
  const issues = findStandalonePackageLockIssues(packageLock);
  if (issues.length === 0) {
    return { packageLockPath, packageLock };
  }

  const summary = issues
    .slice(0, 10)
    .map((issue) => `- ${issue.packagePath || "<root>"}: ${issue.reason}`)
    .join("\n");
  const extra = issues.length > 10 ? `\n- ...and ${issues.length - 10} more` : "";
  throw new Error(
    `package-lock.json is not standalone and will break standalone npm ci deploys.\n${summary}${extra}\nRegenerate it from a clean temp copy instead of inside the pnpm workspace.`,
  );
}
