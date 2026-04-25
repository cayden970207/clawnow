#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: octogen-control-ui-updater.sh --manifest-url <url> [options]

Required:
  --manifest-url <url>         JSON manifest URL for Control UI release

Optional:
  --install-root <dir>         Install root (default: /opt/octogen/control-ui)
  --keep <count>               Keep latest N releases (default: 3)
  --proxy-script-url <url>     Refresh /opt/octogen/octogen-proxy.mjs from this URL
  --force                      Reinstall even when version is unchanged
  --print-root                 Print resolved current root on success

Manifest shape:
  {
    "version": "2026.2.26-1",
    "url": "https://.../control-ui-2026.2.26-1.tgz",
    "sha256": "<optional hex digest>",
    "backendVersion": "2026.3.13",
    "backendInstallSpec": "openclaw@2026.3.13",
    "backendPackageUrl": "https://.../openclaw-2026.2.23-whatsapp-groups1.tgz",
    "backendPackageSha256": "<optional hex digest>"
  }
USAGE
}

MANIFEST_URL=""
INSTALL_ROOT="/opt/octogen/control-ui"
KEEP_COUNT="3"
PROXY_SCRIPT_URL=""
FORCE="0"
PRINT_ROOT="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest-url)
      MANIFEST_URL="${2:-}"
      shift 2
      ;;
    --install-root)
      INSTALL_ROOT="${2:-}"
      shift 2
      ;;
    --keep)
      KEEP_COUNT="${2:-}"
      shift 2
      ;;
    --proxy-script-url)
      PROXY_SCRIPT_URL="${2:-}"
      shift 2
      ;;
    --force)
      FORCE="1"
      shift 1
      ;;
    --print-root)
      PRINT_ROOT="1"
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$MANIFEST_URL" ]]; then
  echo "Missing required --manifest-url" >&2
  usage
  exit 1
fi

if ! [[ "$KEEP_COUNT" =~ ^[0-9]+$ ]] || [[ "$KEEP_COUNT" -lt 1 ]]; then
  echo "--keep must be a positive integer" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

node_satisfies_openclaw_runtime() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  node <<'NODE' >/dev/null 2>&1
const [major = 0, minor = 0, patch = 0] = String(process.versions.node || "")
  .split(".")
  .map((part) => Number.parseInt(part, 10));
const ok =
  major > 22 || (major === 22 && (minor > 16 || (minor === 16 && patch >= 0)));
process.exit(ok ? 0 : 1);
NODE
}

read_gateway_service_env_value() {
  local key="$1"
  local env_path="/etc/openclaw-gateway.env"
  if [[ -z "$key" || ! -f "$env_path" ]]; then
    return 0
  fi
  awk -F= -v wanted="$key" '$1 == wanted { print substr($0, index($0, "=") + 1); exit }' "$env_path"
}

read_env_file_value() {
  local env_path="$1"
  local key="$2"
  if [[ -z "$env_path" || -z "$key" || ! -f "$env_path" ]]; then
    return 0
  fi
  awk -F= -v wanted="$key" '$1 == wanted { print substr($0, index($0, "=") + 1); exit }' "$env_path"
}

resolve_trusted_proxy_user() {
  local user
  user="$(read_gateway_service_env_value "OCTOGEN_TRUSTED_PROXY_USER")"
  if [[ -n "$user" ]]; then
    printf '%s' "$user"
    return 0
  fi
  read_env_file_value "/etc/octogen-proxy.env" "OCTOGEN_TRUSTED_PROXY_USER"
}

resolve_proxy_script_url() {
  if [[ -n "$PROXY_SCRIPT_URL" ]]; then
    printf '%s' "$PROXY_SCRIPT_URL"
    return 0
  fi
  read_env_file_value "/etc/octogen-proxy.env" "OCTOGEN_PROXY_SCRIPT_URL"
}

refresh_managed_proxy_script() {
  local proxy_script_url="$1"
  local target_path="/opt/octogen/octogen-proxy.mjs"
  local download_path="${tmp_dir}/octogen-proxy.mjs"

  if [[ -z "$proxy_script_url" ]]; then
    return 0
  fi

  curl -fsSL "$proxy_script_url" -o "$download_path"
  chmod 755 "$download_path"

  if [[ -f "$target_path" ]] && cmp -s "$download_path" "$target_path"; then
    return 0
  fi

  install -m 755 "$download_path" "$target_path"
  printf '%s' "updated"
}

tighten_managed_state_dir_permissions() {
  local state_dir="/root/.openclaw"
  local credentials_dir="${state_dir}/credentials"
  mkdir -p "$state_dir" "$credentials_dir"
  chmod 700 "$state_dir" "$credentials_dir"
}

resolve_installed_openclaw_version() {
  if ! command -v openclaw >/dev/null 2>&1; then
    return 0
  fi
  openclaw --version 2>/dev/null | head -n 1 | tr -d '[:space:]'
}

scrub_octogen_gateway_config() {
  local config_path="/root/.openclaw/openclaw.json"
  if [[ ! -f "$config_path" ]]; then
    return 0
  fi
  node - "$config_path" <<'NODE'
const fs = require("node:fs");

const configPath = process.argv[2];
const raw = fs.readFileSync(configPath, "utf8");
const config = JSON.parse(raw);

let changed = false;
if (
  config &&
  typeof config === "object" &&
  config.gateway &&
  typeof config.gateway === "object" &&
  config.gateway.controlUi &&
  typeof config.gateway.controlUi === "object" &&
  Object.prototype.hasOwnProperty.call(config.gateway.controlUi, "features")
) {
  delete config.gateway.controlUi.features;
  changed = true;
}

if (changed) {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
NODE
}

repair_managed_octogen_gateway_config() {
  local config_path="/root/.openclaw/openclaw.json"
  local trusted_proxy_user
  trusted_proxy_user="$(resolve_trusted_proxy_user)"
  mkdir -p "$(dirname "$config_path")"
  if [[ ! -f "$config_path" ]]; then
    printf '{}\n' >"$config_path"
  fi
  tighten_managed_state_dir_permissions
  OCTOGEN_TRUSTED_PROXY_USER="$trusted_proxy_user" node - "$config_path" <<'NODE'
const fs = require("node:fs");

const configPath = process.argv[2];

const asObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const asStringArray = (value) =>
  Array.isArray(value)
    ? value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean)
    : null;

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  config = {};
}
if (!config || typeof config !== "object" || Array.isArray(config)) {
  config = {};
}

let changed = false;

config.gateway = asObject(config.gateway);
config.gateway.auth = asObject(config.gateway.auth);
config.gateway.auth.trustedProxy = asObject(config.gateway.auth.trustedProxy);
const trustedProxyUser =
  typeof process.env.OCTOGEN_TRUSTED_PROXY_USER === "string"
    ? process.env.OCTOGEN_TRUSTED_PROXY_USER.trim()
    : "";
if (trustedProxyUser) {
  const allowUsers = asStringArray(config.gateway.auth.trustedProxy.allowUsers) ?? [];
  if (allowUsers.length !== 1 || allowUsers[0] !== trustedProxyUser) {
    config.gateway.auth.trustedProxy.allowUsers = [trustedProxyUser];
    changed = true;
  }
}
config.gateway.controlUi = asObject(config.gateway.controlUi);
const controlUi = config.gateway.controlUi;
if (controlUi.dangerouslyAllowHostHeaderOriginFallback !== false) {
  controlUi.dangerouslyAllowHostHeaderOriginFallback = false;
  changed = true;
}
if (controlUi.trustProxyAuth !== true) {
  controlUi.trustProxyAuth = true;
  changed = true;
}
if ("dangerouslyDisableDeviceAuth" in controlUi) {
  delete controlUi.dangerouslyDisableDeviceAuth;
  changed = true;
}
controlUi.features = asObject(controlUi.features);
if (controlUi.features.tasks !== true) {
  controlUi.features.tasks = true;
  changed = true;
}

config.browser = asObject(config.browser);
if (config.browser.enabled !== true) {
  config.browser.enabled = true;
  changed = true;
}
if (config.browser.noSandbox !== true) {
  config.browser.noSandbox = true;
  changed = true;
}
const browserDefaultProfile =
  typeof config.browser.defaultProfile === "string" ? config.browser.defaultProfile.trim().toLowerCase() : "";
if (browserDefaultProfile !== "openclaw") {
  config.browser.defaultProfile = "openclaw";
  changed = true;
}

config.update = asObject(config.update);
if (config.update.checkOnStart !== false) {
  config.update.checkOnStart = false;
  changed = true;
}
config.update.auto = asObject(config.update.auto);
if (config.update.auto.enabled !== false) {
  config.update.auto.enabled = false;
  changed = true;
}

config.web = asObject(config.web);
if (config.web.enabled !== true) {
  config.web.enabled = true;
  changed = true;
}

config.channels = asObject(config.channels);
for (const channelId of ["telegram", "whatsapp"]) {
  const channel = asObject(config.channels[channelId]);
  if (channel.enabled !== true) {
    channel.enabled = true;
    changed = true;
  }
  if (channelId === "whatsapp") {
    const groupPolicy =
      typeof channel.groupPolicy === "string" ? channel.groupPolicy.trim().toLowerCase() : "";
    if (groupPolicy !== "allowlist") {
      channel.groupPolicy = "allowlist";
      changed = true;
    }
  }
  config.channels[channelId] = channel;
}

config.plugins = asObject(config.plugins);
config.plugins.entries = asObject(config.plugins.entries);
for (const pluginId of ["telegram", "whatsapp"]) {
  const entry = asObject(config.plugins.entries[pluginId]);
  if (entry.enabled !== true) {
    entry.enabled = true;
    changed = true;
  }
  config.plugins.entries[pluginId] = entry;
}

const allow = asStringArray(config.plugins.allow);
if (allow && allow.length > 0) {
  const nextAllow = [...allow];
  for (const pluginId of ["telegram", "whatsapp"]) {
    if (!nextAllow.includes(pluginId)) {
      nextAllow.push(pluginId);
      changed = true;
    }
  }
  config.plugins.allow = nextAllow;
}
const deny = asStringArray(config.plugins.deny);
if (deny && deny.length > 0) {
  const managedChannelSet = new Set(["telegram", "whatsapp"]);
  const nextDeny = deny.filter((entry) => !managedChannelSet.has(entry));
  if (nextDeny.length !== deny.length) {
    config.plugins.deny = nextDeny;
    changed = true;
  }
}

config.tools = asObject(config.tools);
config.tools.exec = asObject(config.tools.exec);
const execSecurity =
  typeof config.tools.exec.security === "string" ? config.tools.exec.security.trim().toLowerCase() : "";
if (execSecurity !== "allowlist") {
  config.tools.exec.security = "allowlist";
  changed = true;
}
const execAsk =
  typeof config.tools.exec.ask === "string" ? config.tools.exec.ask.trim().toLowerCase() : "";
if (execAsk !== "on-miss") {
  config.tools.exec.ask = "on-miss";
  changed = true;
}

config.agents = asObject(config.agents);
config.agents.defaults = asObject(config.agents.defaults);
config.agents.defaults.memorySearch = asObject(config.agents.defaults.memorySearch);
if (config.agents.defaults.memorySearch.enabled === undefined) {
  config.agents.defaults.memorySearch.enabled = true;
  changed = true;
}
const memoryProvider =
  typeof config.agents.defaults.memorySearch.provider === "string"
    ? config.agents.defaults.memorySearch.provider.trim()
    : "";
if (!memoryProvider) {
  config.agents.defaults.memorySearch.provider = "openai";
  changed = true;
}
const memoryModel =
  typeof config.agents.defaults.memorySearch.model === "string"
    ? config.agents.defaults.memorySearch.model.trim()
    : "";
if (!memoryModel) {
  config.agents.defaults.memorySearch.model = "text-embedding-3-small";
  changed = true;
}
const memoryFallback =
  typeof config.agents.defaults.memorySearch.fallback === "string"
    ? config.agents.defaults.memorySearch.fallback.trim()
    : "";
if (!memoryFallback) {
  config.agents.defaults.memorySearch.fallback = "openai";
  changed = true;
}
config.agents.defaults.memorySearch.remote = asObject(config.agents.defaults.memorySearch.remote);
config.agents.defaults.memorySearch.remote.batch = asObject(
  config.agents.defaults.memorySearch.remote.batch,
);
if (config.agents.defaults.memorySearch.remote.batch.enabled === undefined) {
  config.agents.defaults.memorySearch.remote.batch.enabled = true;
  changed = true;
}
if (config.agents.defaults.memorySearch.remote.batch.wait === undefined) {
  config.agents.defaults.memorySearch.remote.batch.wait = true;
  changed = true;
}
const batchConcurrency =
  typeof config.agents.defaults.memorySearch.remote.batch.concurrency === "number" &&
  Number.isFinite(config.agents.defaults.memorySearch.remote.batch.concurrency)
    ? Math.max(1, Math.floor(config.agents.defaults.memorySearch.remote.batch.concurrency))
    : null;
if (batchConcurrency === null) {
  config.agents.defaults.memorySearch.remote.batch.concurrency = 2;
  changed = true;
}

const existingModels = asObject(config.models);
const existingProviders = existingModels ? asObject(existingModels.providers) : null;
const existingOpenAiProvider = existingProviders ? asObject(existingProviders.openai) : null;
const openAiApiKey =
  typeof existingOpenAiProvider?.apiKey === "string"
    ? existingOpenAiProvider.apiKey.trim()
    : "";
const memoryRemoteApiKey =
  typeof config.agents.defaults.memorySearch.remote.apiKey === "string"
    ? config.agents.defaults.memorySearch.remote.apiKey.trim()
    : "";
if (!memoryRemoteApiKey && openAiApiKey) {
  config.agents.defaults.memorySearch.remote.apiKey = openAiApiKey;
  changed = true;
}
if (
  existingOpenAiProvider &&
  Object.keys(existingOpenAiProvider).length === 0 &&
  existingProviders &&
  typeof existingProviders === "object"
) {
  delete existingProviders.openai;
  changed = true;
  if (Object.keys(existingProviders).length === 0 && existingModels && typeof existingModels === "object") {
    delete existingModels.providers;
    if (Object.keys(existingModels).length === 0) {
      delete config.models;
    }
  }
}

if (changed) {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

process.stdout.write(changed ? "changed" : "unchanged");
NODE
  tighten_managed_state_dir_permissions
}

refresh_gateway_service_env() {
  local env_path="/etc/openclaw-gateway.env"
  if [[ ! -f "$env_path" ]]; then
    return 0
  fi
  node - "$env_path" "${1:-}" "${2:-}" <<'NODE'
const fs = require("node:fs");

const [envPath, versionRaw, installSpecRaw] = process.argv.slice(2);
const version = String(versionRaw || "").trim();
const installSpec = String(installSpecRaw || "").trim();
const lines = fs
  .readFileSync(envPath, "utf8")
  .split(/\r?\n/g)
  .filter((line, index, array) => !(index === array.length - 1 && line === ""));

const nextLines = lines.filter((line) => {
  const idx = line.indexOf("=");
  const key = idx >= 0 ? line.slice(0, idx) : line;
  return (
    key !== "OPENCLAW_VERSION" &&
    key !== "OPENCLAW_SERVICE_VERSION" &&
    key !== "OPENCLAW_BUNDLED_VERSION" &&
    key !== "OPENCLAW_INSTALL_SPEC"
  );
});

if (version) {
  nextLines.push(`OPENCLAW_VERSION=${version}`);
  nextLines.push(`OPENCLAW_SERVICE_VERSION=${version}`);
  nextLines.push(`OPENCLAW_BUNDLED_VERSION=${version}`);
}
if (installSpec) {
  nextLines.push(`OPENCLAW_INSTALL_SPEC=${installSpec}`);
}

fs.writeFileSync(envPath, `${nextLines.join("\n")}\n`);
NODE
}

normalize_gateway_service_unit() {
  local unit_path="/etc/systemd/system/openclaw-gateway.service"
  if [[ ! -f "$unit_path" ]]; then
    return 0
  fi
  node - "$unit_path" <<'NODE'
const fs = require("node:fs");

const unitPath = process.argv[2];
const raw = fs.readFileSync(unitPath, "utf8");
const next = raw.replace(
  /^ExecStart=\/usr\/bin\/env bash -lc ('[^']+')$/m,
  "ExecStart=/usr/bin/env bash -c $1",
);

if (next !== raw) {
  fs.writeFileSync(unitPath, next);
}
NODE
}

manifest_path="${tmp_dir}/manifest.json"
curl -fsSL "$MANIFEST_URL" -o "$manifest_path"

manifest_info="$(node - "$manifest_path" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const raw = fs.readFileSync(path, "utf8");
const parsed = JSON.parse(raw);
const version = String(parsed.version || "").trim();
const url = String(parsed.url || "").trim();
const sha = String(parsed.sha256 || "").trim().toLowerCase();
const backendVersion = String(parsed.backendVersion || "").trim();
const backendInstallSpec = String(parsed.backendInstallSpec || "").trim();
const backendPackageUrl = String(parsed.backendPackageUrl || "").trim();
const backendPackageSha256 = String(parsed.backendPackageSha256 || "").trim().toLowerCase();
if (!version) {
  throw new Error("manifest missing version");
}
if (!url) {
  throw new Error("manifest missing url");
}
try {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("url must be http/https");
  }
} catch (err) {
  throw new Error(`manifest url invalid: ${String(err)}`);
}
if (sha && !/^[a-f0-9]{64}$/.test(sha)) {
  throw new Error("manifest sha256 must be 64 hex chars when provided");
}
if (backendInstallSpec && backendPackageUrl) {
  throw new Error("manifest backendInstallSpec and backendPackageUrl are mutually exclusive");
}
if (!backendVersion || (!backendPackageUrl && !backendInstallSpec)) {
  throw new Error(
    "managed workspace release manifests must provide backendVersion and one of backendPackageUrl/backendInstallSpec",
  );
}
if (backendPackageUrl) {
  try {
    const u = new URL(backendPackageUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      throw new Error("backendPackageUrl must be http/https");
    }
  } catch (err) {
    throw new Error(`manifest backendPackageUrl invalid: ${String(err)}`);
  }
}
if (backendInstallSpec && backendPackageSha256) {
  throw new Error("manifest backendPackageSha256 requires backendPackageUrl");
}
if (backendPackageSha256 && !/^[a-f0-9]{64}$/.test(backendPackageSha256)) {
  throw new Error("manifest backendPackageSha256 must be 64 hex chars when provided");
}
process.stdout.write(
  `${version}\n${url}\n${sha}\n${backendVersion}\n${backendInstallSpec}\n${backendPackageUrl}\n${backendPackageSha256}`,
);
NODE
)"

manifest_version="$(printf '%s\n' "$manifest_info" | sed -n '1p')"
manifest_package_url="$(printf '%s\n' "$manifest_info" | sed -n '2p')"
manifest_sha256="$(printf '%s\n' "$manifest_info" | sed -n '3p')"
backend_version="$(printf '%s\n' "$manifest_info" | sed -n '4p')"
backend_install_spec="$(printf '%s\n' "$manifest_info" | sed -n '5p')"
backend_package_url="$(printf '%s\n' "$manifest_info" | sed -n '6p')"
backend_package_sha256="$(printf '%s\n' "$manifest_info" | sed -n '7p')"

releases_dir="${INSTALL_ROOT}/releases"
current_link="${INSTALL_ROOT}/current"
version_file="${INSTALL_ROOT}/current.version"
backend_version_file="${INSTALL_ROOT}/current.backend.version"
backend_install_spec_file="${INSTALL_ROOT}/current.backend.install-spec"

mkdir -p "$releases_dir"

current_version=""
if [[ -f "$version_file" ]]; then
  current_version="$(tr -d '[:space:]' <"$version_file" || true)"
fi
current_backend_version=""
if [[ -f "$backend_version_file" ]]; then
  current_backend_version="$(tr -d '[:space:]' <"$backend_version_file" || true)"
fi
current_backend_install_spec=""
if [[ -f "$backend_install_spec_file" ]]; then
  current_backend_install_spec="$(tr -d '\r' <"$backend_install_spec_file" | tr -d '\n' || true)"
fi
service_backend_version="$(read_gateway_service_env_value OPENCLAW_VERSION | tr -d '[:space:]' || true)"
service_backend_install_spec="$(read_gateway_service_env_value OPENCLAW_INSTALL_SPEC | tr -d '[:space:]' || true)"
installed_openclaw_version="$(resolve_installed_openclaw_version || true)"
proxy_script_url="$(resolve_proxy_script_url)"
expected_runtime_version=""
if [[ -n "$backend_install_spec" && "$backend_install_spec" == openclaw@* ]]; then
  expected_runtime_version="${backend_install_spec#openclaw@}"
fi
service_runtime_version="$installed_openclaw_version"
if [[ -z "$service_runtime_version" && -n "$expected_runtime_version" ]]; then
  service_runtime_version="$expected_runtime_version"
fi

config_repaired="0"
config_repair_status="$(repair_managed_octogen_gateway_config || true)"
if [[ "$config_repair_status" == "changed" ]]; then
  config_repaired="1"
fi

ui_needs_update="1"
if [[ "$FORCE" != "1" && "$current_version" == "$manifest_version" && -f "${current_link}/index.html" ]]; then
  ui_needs_update="0"
fi
backend_needs_update="0"
if [[ -n "$backend_version" ]]; then
  if [[ "$FORCE" == "1" || "$current_backend_version" != "$backend_version" ]]; then
    backend_needs_update="1"
  fi
  if [[ -n "$backend_install_spec" ]]; then
    if [[ "$current_backend_install_spec" != "$backend_install_spec" ]]; then
      backend_needs_update="1"
    fi
    if [[ "$service_backend_install_spec" != "$backend_install_spec" ]]; then
      backend_needs_update="1"
    fi
  fi
  if [[ -z "$installed_openclaw_version" ]]; then
    backend_needs_update="1"
  fi
  if [[ -n "$expected_runtime_version" && "$installed_openclaw_version" != "$expected_runtime_version" ]]; then
    backend_needs_update="1"
  fi
fi

gateway_restart_required="$config_repaired"
proxy_restart_required="0"
service_env_needs_refresh="0"
if [[ -n "$service_runtime_version" && "$service_backend_version" != "$service_runtime_version" ]]; then
  service_env_needs_refresh="1"
fi
if [[ "$service_backend_install_spec" != "$backend_install_spec" ]]; then
  if [[ -n "$service_backend_install_spec" || -n "$backend_install_spec" ]]; then
    service_env_needs_refresh="1"
  fi
fi
if [[ "$service_env_needs_refresh" == "1" ]]; then
  gateway_restart_required="1"
fi

if [[ "$ui_needs_update" != "1" && "$backend_needs_update" != "1" && "$config_repaired" != "1" && "$service_env_needs_refresh" != "1" ]]; then
  proxy_refresh_status="$(refresh_managed_proxy_script "$proxy_script_url" || true)"
  if [[ "$proxy_refresh_status" == "updated" ]]; then
    proxy_restart_required="1"
  fi
fi

if [[ "$ui_needs_update" != "1" && "$backend_needs_update" != "1" && "$config_repaired" != "1" && "$service_env_needs_refresh" != "1" && "$proxy_restart_required" != "1" ]]; then
  echo "Workspace release already up to date; skipping"
  if [[ "$PRINT_ROOT" == "1" ]]; then
    echo "$current_link"
  fi
  exit 0
fi

if [[ "$ui_needs_update" == "1" ]]; then
  archive_path="${tmp_dir}/control-ui.tgz"
  curl -fsSL "$manifest_package_url" -o "$archive_path"

  if [[ -n "$manifest_sha256" ]]; then
    actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
    if [[ "$actual_sha256" != "$manifest_sha256" ]]; then
      echo "sha256 mismatch for Control UI archive" >&2
      echo "expected: $manifest_sha256" >&2
      echo "actual:   $actual_sha256" >&2
      exit 1
    fi
  fi

  target_dir="${releases_dir}/${manifest_version}"
  tmp_extract_dir="${tmp_dir}/extract"
  mkdir -p "$tmp_extract_dir"

  rm -rf "$target_dir"
  mkdir -p "$target_dir"
  tar -xzf "$archive_path" -C "$tmp_extract_dir"

  if [[ -f "${tmp_extract_dir}/index.html" ]]; then
    cp -a "${tmp_extract_dir}/." "$target_dir/"
  elif [[ -f "${tmp_extract_dir}/control-ui/index.html" ]]; then
    cp -a "${tmp_extract_dir}/control-ui/." "$target_dir/"
  else
    echo "archive does not contain index.html at root or control-ui/index.html" >&2
    exit 1
  fi

  if [[ ! -f "${target_dir}/index.html" ]]; then
    echo "invalid extracted Control UI: missing index.html" >&2
    exit 1
  fi

  ln -sfn "$target_dir" "$current_link"
  printf '%s\n' "$manifest_version" >"$version_file"

  # Keep most recent N release directories by mtime.
  release_list="$(ls -1dt "$releases_dir"/* 2>/dev/null || true)"
  if [[ -n "$release_list" ]]; then
    release_count="$(printf '%s\n' "$release_list" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [[ "$release_count" -gt "$KEEP_COUNT" ]]; then
      delete_list="$(printf '%s\n' "$release_list" | awk -v keep="$KEEP_COUNT" 'NR > keep')"
      if [[ -n "$delete_list" ]]; then
        while IFS= read -r release_dir; do
          [[ -z "$release_dir" ]] && continue
          rm -rf "$release_dir"
        done <<<"$delete_list"
      fi
    fi
  fi
fi

if [[ -n "$backend_version" && "$backend_needs_update" == "1" ]]; then
  # Official OpenClaw releases now require Node >= 22.16. Older managed VMs can
  # still be on an earlier 22.x build, so upgrade Node before reinstalling the
  # backend to avoid a restart into an immediately crashing runtime.
  if ! node_satisfies_openclaw_runtime; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  # Ensure npm does not keep a stale global openclaw tree around when installing
  # a custom backend build that reuses the same internal package semver.
  npm uninstall -g openclaw >/dev/null 2>&1 || true
  if [[ -n "$backend_install_spec" ]]; then
    # Force reinstall when the Octogen manifest backendVersion changes even if the
    # npm package's internal semver stays pinned (for example 2026.2.23 custom builds).
    npm install -g --force "$backend_install_spec"
  else
    backend_archive_path="${tmp_dir}/openclaw-backend.tgz"
    curl -fsSL "$backend_package_url" -o "$backend_archive_path"

    if [[ -n "$backend_package_sha256" ]]; then
      backend_actual_sha256="$(sha256sum "$backend_archive_path" | awk '{print $1}')"
      if [[ "$backend_actual_sha256" != "$backend_package_sha256" ]]; then
        echo "sha256 mismatch for OpenClaw backend archive" >&2
        echo "expected: $backend_package_sha256" >&2
        echo "actual:   $backend_actual_sha256" >&2
        exit 1
      fi
    fi

    # Force reinstall for archive upgrades so same-semver internal package versions
    # cannot leave the VM on a stale global install.
    npm install -g --force "$backend_archive_path"
  fi
  installed_openclaw_version="$(resolve_installed_openclaw_version || true)"
  service_runtime_version="$installed_openclaw_version"
  if [[ -z "$service_runtime_version" && -n "$expected_runtime_version" ]]; then
    service_runtime_version="$expected_runtime_version"
  fi
  if [[ -z "$service_runtime_version" ]]; then
    service_runtime_version="$backend_version"
  fi
  printf '%s\n' "$backend_version" >"$backend_version_file"
  if [[ -n "$backend_install_spec" ]]; then
    printf '%s\n' "$backend_install_spec" >"$backend_install_spec_file"
  else
    rm -f "$backend_install_spec_file"
  fi
  scrub_octogen_gateway_config
  refresh_gateway_service_env "$service_runtime_version" "$backend_install_spec"
  normalize_gateway_service_unit
  gateway_restart_required="1"
  echo "Updated OpenClaw backend to ${backend_version}"
fi

if [[ "$backend_needs_update" != "1" && "$service_env_needs_refresh" == "1" ]]; then
  refresh_gateway_service_env "$service_runtime_version" "$backend_install_spec"
  normalize_gateway_service_unit
fi

if [[ "$proxy_restart_required" != "1" ]]; then
  proxy_refresh_status="$(refresh_managed_proxy_script "$proxy_script_url" || true)"
  if [[ "$proxy_refresh_status" == "updated" ]]; then
    proxy_restart_required="1"
  fi
fi

if [[ "$gateway_restart_required" == "1" ]]; then
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "openclaw-gateway.service"; then
      systemctl daemon-reload
      systemctl restart openclaw-gateway.service
      systemctl is-active --quiet openclaw-gateway.service
    fi
  fi
fi

if [[ "$proxy_restart_required" == "1" ]]; then
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "octogen-proxy.service"; then
      systemctl daemon-reload
      systemctl restart octogen-proxy.service
      systemctl is-active --quiet octogen-proxy.service
    fi
  fi
  echo "Updated Octogen Console trusted proxy script"
fi

if [[ "$ui_needs_update" == "1" ]]; then
  echo "Updated Control UI to ${manifest_version}"
else
  echo "Control UI already on ${manifest_version}; skipped Control UI package install"
fi
if [[ "$config_repaired" == "1" ]]; then
  echo "Repaired managed gateway defaults for bundled channels"
fi
if [[ "$service_env_needs_refresh" == "1" ]]; then
  echo "Refreshed gateway runtime version markers"
fi
if [[ "$PRINT_ROOT" == "1" ]]; then
  echo "$current_link"
fi
