import path from "node:path";

function parseArgs(argv) {
  let baseUrl = process.env.OCTOGEN_BOOTSTRAP_ASSET_BASE_URL ?? "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") {
      baseUrl = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!baseUrl) {
    throw new Error("Missing --base-url (or OCTOGEN_BOOTSTRAP_ASSET_BASE_URL env).");
  }
  return baseUrl.replace(/\/+$/, "");
}

async function assertOk(url, label, allowedStatuses = [200, 301, 302, 307, 308]) {
  const response = await fetch(url, { method: "GET", redirect: "manual" });
  if (!allowedStatuses.includes(response.status)) {
    throw new Error(`${label} failed: ${response.status} ${response.statusText}`);
  }
  return response;
}

async function main() {
  const baseUrl = parseArgs(process.argv.slice(2));
  await assertOk(`${baseUrl}/`, "home");

  const manifestResponse = await assertOk(
    `${baseUrl}/bootstrap/control-ui-manifest.json`,
    "manifest",
    [200],
  );
  const manifest = await manifestResponse.json();
  if (!manifest?.url) {
    throw new Error("manifest is missing url");
  }
  const backendInstallSpec =
    typeof manifest.backendInstallSpec === "string" ? manifest.backendInstallSpec.trim() : "";
  const backendPackageUrl =
    typeof manifest.backendPackageUrl === "string" ? manifest.backendPackageUrl.trim() : "";
  if (!manifest?.backendVersion || (!backendInstallSpec && !backendPackageUrl)) {
    throw new Error("manifest is missing backendVersion or backend release source");
  }

  const assetResponse = await fetch(manifest.url, { method: "HEAD", redirect: "manual" });
  if (assetResponse.status !== 200) {
    throw new Error(
      `control-ui asset ${path.basename(new URL(manifest.url).pathname)} is not reachable (${assetResponse.status})`,
    );
  }

  if (backendPackageUrl) {
    const backendUrl = backendPackageUrl;
    const backendResponse = await fetch(backendUrl, { method: "HEAD", redirect: "manual" });
    if (backendResponse.status !== 200) {
      throw new Error(
        `backend asset ${path.basename(new URL(backendUrl).pathname)} is not reachable (${backendResponse.status})`,
      );
    }
  }

  console.log(
    `Smoke check passed for ${baseUrl} (manifest ${manifest.version}, control-ui ${path.basename(
      new URL(manifest.url).pathname,
    )}${backendPackageUrl ? `, backend ${path.basename(new URL(backendPackageUrl).pathname)}` : backendInstallSpec ? `, backend ${backendInstallSpec}` : ""}).`,
  );
}

await main();
