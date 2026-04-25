import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function usage() {
  console.error(
    "Usage: node ./scripts/stamp-managed-backend-artifact.mjs --input <tgz> --output <tgz> --version <version>",
  );
}

function parseArgs(argv) {
  let input = "";
  let output = "";
  let version = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      input = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--output") {
      output = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--version") {
      version = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!input || !output || !version) {
    usage();
    throw new Error("Missing required --input/--output/--version");
  }
  return {
    input: path.resolve(input),
    output: path.resolve(output),
    version: version.trim(),
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const { input, output, version } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(input)) {
    throw new Error(`Input archive not found: ${input}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "octogen-managed-backend-"));
  try {
    const extractResult = spawnSync("tar", ["-xzf", input, "-C", tempRoot], {
      stdio: "inherit",
      env: {
        ...process.env,
        COPYFILE_DISABLE: "1",
      },
    });
    if (extractResult.status !== 0) {
      throw new Error(`Failed to extract archive: ${input}`);
    }

    const packageRoot = path.join(tempRoot, "package");
    const packageJsonPath = path.join(packageRoot, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error(`Archive does not contain package/package.json: ${input}`);
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    packageJson.version = version;
    writeJson(packageJsonPath, packageJson);

    const buildInfoPath = path.join(packageRoot, "dist", "build-info.json");
    if (fs.existsSync(buildInfoPath)) {
      const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
      buildInfo.version = version;
      writeJson(buildInfoPath, buildInfo);
    }

    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.rmSync(output, { force: true });
    const packResult = spawnSync("tar", ["-czf", output, "-C", tempRoot, "package"], {
      stdio: "inherit",
      env: {
        ...process.env,
        COPYFILE_DISABLE: "1",
      },
    });
    if (packResult.status !== 0) {
      throw new Error(`Failed to create archive: ${output}`);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  process.stdout.write(`${output}\n`);
}

main();
