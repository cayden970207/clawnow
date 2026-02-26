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
    "sha256": "<optional hex digest>"
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
process.stdout.write(`${version}\n${url}\n${sha}`);
NODE
)"

manifest_version="$(printf '%s\n' "$manifest_info" | sed -n '1p')"
manifest_package_url="$(printf '%s\n' "$manifest_info" | sed -n '2p')"
manifest_sha256="$(printf '%s\n' "$manifest_info" | sed -n '3p')"

releases_dir="${INSTALL_ROOT}/releases"
current_link="${INSTALL_ROOT}/current"
version_file="${INSTALL_ROOT}/current.version"

mkdir -p "$releases_dir"

current_version=""
if [[ -f "$version_file" ]]; then
  current_version="$(tr -d '[:space:]' <"$version_file" || true)"
fi

if [[ "$FORCE" != "1" && "$current_version" == "$manifest_version" && -f "${current_link}/index.html" ]]; then
  echo "Control UI already on ${manifest_version}; skipping"
  if [[ "$PRINT_ROOT" == "1" ]]; then
    echo "$current_link"
  fi
  exit 0
fi

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

echo "Updated Control UI to ${manifest_version}"
if [[ "$PRINT_ROOT" == "1" ]]; then
  echo "$current_link"
fi
