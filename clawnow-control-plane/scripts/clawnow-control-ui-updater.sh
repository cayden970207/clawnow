#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: clawnow-control-ui-updater.sh --manifest-url <url> [options]

Required:
  --manifest-url <url>         JSON manifest URL for Control UI release

Optional:
  --install-root <dir>         Install root (default: /opt/clawnow/control-ui)
  --keep <count>               Keep latest N releases (default: 3)
  --force                      Reinstall even when version is unchanged
  --print-root                 Print resolved current root on success

Manifest shape:
  {
    "version": "2026.2.26-1",
    "url": "https://.../control-ui-2026.2.26-1.tgz",
    "sha256": "<optional hex digest>",
    "backendVersion": "2026.2.23-whatsapp-groups1",
    "backendPackageUrl": "https://.../openclaw-2026.2.23-whatsapp-groups1.tgz",
    "backendPackageSha256": "<optional hex digest>"
  }
USAGE
}

MANIFEST_URL=""
INSTALL_ROOT="/opt/clawnow/control-ui"
KEEP_COUNT="3"
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
if ((backendVersion && !backendPackageUrl) || (!backendVersion && backendPackageUrl)) {
  throw new Error("backendVersion and backendPackageUrl must be provided together");
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
if (backendPackageSha256 && !/^[a-f0-9]{64}$/.test(backendPackageSha256)) {
  throw new Error("manifest backendPackageSha256 must be 64 hex chars when provided");
}
process.stdout.write(
  `${version}\n${url}\n${sha}\n${backendVersion}\n${backendPackageUrl}\n${backendPackageSha256}`,
);
NODE
)"

manifest_version="$(printf '%s\n' "$manifest_info" | sed -n '1p')"
manifest_package_url="$(printf '%s\n' "$manifest_info" | sed -n '2p')"
manifest_sha256="$(printf '%s\n' "$manifest_info" | sed -n '3p')"
backend_version="$(printf '%s\n' "$manifest_info" | sed -n '4p')"
backend_package_url="$(printf '%s\n' "$manifest_info" | sed -n '5p')"
backend_package_sha256="$(printf '%s\n' "$manifest_info" | sed -n '6p')"

releases_dir="${INSTALL_ROOT}/releases"
current_link="${INSTALL_ROOT}/current"
version_file="${INSTALL_ROOT}/current.version"
backend_version_file="${INSTALL_ROOT}/current.backend.version"

mkdir -p "$releases_dir"

current_version=""
if [[ -f "$version_file" ]]; then
  current_version="$(tr -d '[:space:]' <"$version_file" || true)"
fi
current_backend_version=""
if [[ -f "$backend_version_file" ]]; then
  current_backend_version="$(tr -d '[:space:]' <"$backend_version_file" || true)"
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
fi

if [[ "$ui_needs_update" != "1" && "$backend_needs_update" != "1" ]]; then
  echo "Control UI/backend already up to date; skipping"
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

  npm install -g "$backend_archive_path"
  printf '%s\n' "$backend_version" >"$backend_version_file"

  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "openclaw-gateway.service"; then
      systemctl restart openclaw-gateway.service || true
    fi
  fi
  echo "Updated OpenClaw backend to ${backend_version}"
fi

if [[ "$ui_needs_update" == "1" ]]; then
  echo "Updated Control UI to ${manifest_version}"
else
  echo "Control UI already on ${manifest_version}; skipped UI package install"
fi
if [[ "$PRINT_ROOT" == "1" ]]; then
  echo "$current_link"
fi
