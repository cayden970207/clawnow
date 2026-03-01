#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: clawnow-vm-bootstrap.sh --proxy-secret <secret> [options]

Required:
  --proxy-secret <secret>      Shared secret for ClawNow trusted-proxy tokens

Optional:
  --proxy-bind <host>          Proxy bind host (default: 127.0.0.1)
  --proxy-port <port>          Proxy port (default: 18790)
  --gateway-port <port>        OpenClaw gateway port (default: 18789)
  --control-prefix <path>      Control UI path prefix (default: /clawnow)
  --novnc-prefix <path>        noVNC path prefix (default: /novnc)
  --public-host <host>         Public HTTPS host for VM (default: auto-detect via --public-host-template)
  --public-host-template <tpl> Host template with {{IPV4}} (default: {{IPV4}}.sslip.io)
  --instance-id <id>           Claw instance id (used for gateway template rendering)
  --gateway-origin-template    Gateway URL template (for example: https://{{IPV4}}.sslip.io)
                               Supported placeholders: {{IPV4}}, {{INSTANCE_ID}}, {{SERVER_ID}}
  --control-ui-origin <origin> Explicit Control UI browser origin allowlist entry
  --control-plane-device-id <id>
                               Pre-approved control-plane device id for gateway admin automation
  --control-plane-device-public-key <key>
                               Base64url public key for the pre-approved control-plane device
  --disable-https              Skip Caddy HTTPS front door (not recommended for production)
  --openclaw-version <ver>     npm package version (default: latest)
  --proxy-script-url <url>     Proxy script URL
                               (default: https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/clawnow-proxy.mjs)
  --control-ui-manifest-url <url>
                               Optional Control UI manifest URL for automatic UI updates
  --control-ui-updater-script-url <url>
                               Control UI updater script URL
                               (default: https://raw.githubusercontent.com/openclaw/openclaw/main/clawnow-control-plane/scripts/clawnow-control-ui-updater.sh)

Logs:
  /var/log/clawnow-bootstrap.log
  /var/lib/clawnow/bootstrap-state.json
USAGE
}

PROXY_SECRET=""
PROXY_BIND="127.0.0.1"
PROXY_PORT="18790"
GATEWAY_PORT="18789"
CONTROL_PREFIX="/clawnow"
NOVNC_PREFIX="/novnc"
PUBLIC_HOST=""
PUBLIC_HOST_TEMPLATE="{{IPV4}}.sslip.io"
INSTANCE_ID=""
SERVER_ID=""
GATEWAY_ORIGIN_TEMPLATE=""
CONTROL_UI_ORIGIN=""
ENABLE_HTTPS="1"
OPENCLAW_VERSION="latest"
PROXY_SCRIPT_URL="https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/clawnow-proxy.mjs"
CONTROL_UI_MANIFEST_URL=""
CONTROL_UI_UPDATER_SCRIPT_URL="https://raw.githubusercontent.com/openclaw/openclaw/main/clawnow-control-plane/scripts/clawnow-control-ui-updater.sh"
CONTROL_UI_ROOT=""
CONTROL_PLANE_DEVICE_ID=""
CONTROL_PLANE_DEVICE_PUBLIC_KEY=""

BOOTSTRAP_LOG="/var/log/clawnow-bootstrap.log"
STATE_DIR="/var/lib/clawnow"
STATE_FILE="${STATE_DIR}/bootstrap-state.json"
DESKTOP_DISPLAY=":1"
DESKTOP_VNC_PORT="5900"
DESKTOP_NOVNC_PORT="6080"
DESKTOP_NOVNC_WEB_ROOT="/usr/share/novnc"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --proxy-secret)
      PROXY_SECRET="${2:-}"
      shift 2
      ;;
    --proxy-bind)
      PROXY_BIND="${2:-}"
      shift 2
      ;;
    --proxy-port)
      PROXY_PORT="${2:-}"
      shift 2
      ;;
    --gateway-port)
      GATEWAY_PORT="${2:-}"
      shift 2
      ;;
    --control-prefix)
      CONTROL_PREFIX="${2:-}"
      shift 2
      ;;
    --novnc-prefix)
      NOVNC_PREFIX="${2:-}"
      shift 2
      ;;
    --public-host)
      PUBLIC_HOST="${2:-}"
      shift 2
      ;;
    --public-host-template)
      PUBLIC_HOST_TEMPLATE="${2:-}"
      shift 2
      ;;
    --instance-id)
      INSTANCE_ID="${2:-}"
      shift 2
      ;;
    --gateway-origin-template)
      GATEWAY_ORIGIN_TEMPLATE="${2:-}"
      shift 2
      ;;
    --control-ui-origin)
      CONTROL_UI_ORIGIN="${2:-}"
      shift 2
      ;;
    --control-ui-allowed-origin)
      CONTROL_UI_ORIGIN="${2:-}"
      shift 2
      ;;
    --control-plane-device-id)
      CONTROL_PLANE_DEVICE_ID="${2:-}"
      shift 2
      ;;
    --control-plane-device-public-key)
      CONTROL_PLANE_DEVICE_PUBLIC_KEY="${2:-}"
      shift 2
      ;;
    --disable-https)
      ENABLE_HTTPS="0"
      shift 1
      ;;
    --openclaw-version)
      OPENCLAW_VERSION="${2:-}"
      shift 2
      ;;
    --proxy-script-url)
      PROXY_SCRIPT_URL="${2:-}"
      shift 2
      ;;
    --control-ui-manifest-url)
      CONTROL_UI_MANIFEST_URL="${2:-}"
      shift 2
      ;;
    --control-ui-updater-script-url)
      CONTROL_UI_UPDATER_SCRIPT_URL="${2:-}"
      shift 2
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

if [[ -z "$PROXY_SECRET" ]]; then
  echo "Missing required --proxy-secret" >&2
  usage
  exit 1
fi

if [[ -n "$CONTROL_PLANE_DEVICE_ID" && -z "$CONTROL_PLANE_DEVICE_PUBLIC_KEY" ]]; then
  echo "--control-plane-device-public-key is required when --control-plane-device-id is set" >&2
  exit 1
fi
if [[ -z "$CONTROL_PLANE_DEVICE_ID" && -n "$CONTROL_PLANE_DEVICE_PUBLIC_KEY" ]]; then
  echo "--control-plane-device-id is required when --control-plane-device-public-key is set" >&2
  exit 1
fi

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

write_state() {
  local phase="$1"
  local status="$2"
  local message="$3"
  local now
  now="$(timestamp)"
  install -d -m 0755 "$STATE_DIR"
  cat >"$STATE_FILE" <<STATE
{"phase":"$(json_escape "$phase")","status":"$(json_escape "$status")","message":"$(json_escape "$message")","updatedAt":"$now"}
STATE
}

log_step() {
  echo "[$(timestamp)] [clawnow-bootstrap] $*"
}

on_error() {
  local exit_code="$?"
  local line="$1"
  write_state "failed" "error" "bootstrap failed at line ${line} (exit ${exit_code})"
  log_step "FAILED at line ${line} (exit ${exit_code})"

  for unit in clawnow-desktop.service openclaw-gateway.service clawnow-proxy.service caddy.service; do
    if systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "$unit"; then
      log_step "systemctl status ${unit}"
      systemctl --no-pager --full status "$unit" || true
      log_step "journalctl -u ${unit} (last 60 lines)"
      journalctl -u "$unit" -n 60 --no-pager || true
    fi
  done

  exit "$exit_code"
}

install -d -m 0755 "$(dirname "$BOOTSTRAP_LOG")"
touch "$BOOTSTRAP_LOG"
chmod 0644 "$BOOTSTRAP_LOG"
exec > >(tee -a "$BOOTSTRAP_LOG") 2>&1

trap 'on_error $LINENO' ERR

write_state "init" "running" "bootstrap started"
log_step "starting bootstrap"

export DEBIAN_FRONTEND=noninteractive

wait_for_tcp_port() {
  local host="$1"
  local port="$2"
  local retries="${3:-60}"
  local delay_seconds="${4:-2}"
  local i
  for ((i=1; i<=retries; i++)); do
    if timeout 1 bash -c "</dev/tcp/${host}/${port}" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay_seconds"
  done
  return 1
}

resolve_gateway_origin_from_template() {
  local template="$1"
  local ipv4="$2"
  local instance_id="$3"
  local server_id="$4"

  if [[ -z "$template" ]]; then
    return 1
  fi

  local rendered="$template"
  rendered="${rendered//\{\{IPV4\}\}/$ipv4}"
  rendered="${rendered//\{\{INSTANCE_ID\}\}/$instance_id}"
  rendered="${rendered//\{\{SERVER_ID\}\}/$server_id}"

  if [[ "$rendered" == *"{{"* ]]; then
    return 1
  fi

  node - "$rendered" <<'NODE'
const input = String(process.argv[2] || "").trim();
try {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    process.exit(1);
  }
  process.stdout.write(url.origin);
} catch {
  process.exit(1);
}
NODE
}

resolve_http_origin_from_host() {
  local host="$1"
  local port="$2"
  if [[ -z "$host" ]]; then
    return 1
  fi
  node - "$host" "$port" <<'NODE'
const rawHost = String(process.argv[2] || "").trim();
const rawPort = String(process.argv[3] || "").trim();
if (!rawHost) process.exit(1);
let candidate = rawHost;
if (!/^https?:\/\//i.test(candidate)) {
  candidate = `http://${candidate}`;
}
try {
  const url = new URL(candidate);
  url.protocol = "http:";
  if (!url.port && rawPort) {
    url.port = rawPort;
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  process.stdout.write(url.origin);
} catch {
  process.exit(1);
}
NODE
}

install_caddy() {
  if apt-get install -y caddy; then
    return 0
  fi

  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
}

has_supported_browser() {
  command -v google-chrome >/dev/null 2>&1 || \
    command -v google-chrome-stable >/dev/null 2>&1 || \
    command -v chromium >/dev/null 2>&1 || \
    command -v chromium-browser >/dev/null 2>&1
}

install_browser() {
  if has_supported_browser; then
    log_step "browser already installed"
    return 0
  fi

  local arch
  arch="$(dpkg --print-architecture 2>/dev/null || true)"
  if [[ "$arch" == "amd64" ]]; then
    local chrome_deb="/tmp/google-chrome-stable_current_amd64.deb"
    log_step "attempting to install google-chrome-stable"
    if curl --connect-timeout 10 --max-time 180 --retry 2 --retry-delay 2 -fsSL \
      "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" \
      -o "$chrome_deb"; then
      if ! dpkg -i "$chrome_deb"; then
        apt-get install -f -y
        dpkg -i "$chrome_deb"
      fi
      rm -f "$chrome_deb"
    else
      log_step "google-chrome download failed; falling back to distro chromium packages"
      rm -f "$chrome_deb"
    fi
  fi

  if has_supported_browser; then
    return 0
  fi

  log_step "google-chrome unavailable; trying distro chromium packages"
  apt-get install -y chromium || apt-get install -y chromium-browser

  if ! has_supported_browser; then
    echo "No supported browser was installed (tried google-chrome/chromium)." >&2
    exit 1
  fi
}

install_desktop_runtime_packages() {
  if apt-get install -y xvfb x11vnc novnc websockify; then
    return 0
  fi
  apt-get install -y xvfb x11vnc novnc python3-websockify
}

prepare_novnc_web_root() {
  local source_root="/usr/share/novnc"
  local target_root="/opt/clawnow/novnc"
  local error_handler_path="${target_root}/app/error-handler.js"
  local filter_script_path="${target_root}/clawnow-error-filter.js"
  DESKTOP_NOVNC_WEB_ROOT="$source_root"

  if [[ ! -d "$source_root" ]]; then
    log_step "warning: noVNC source root not found (${source_root}); skipping extension error filter patch"
    return 0
  fi

  rm -rf "$target_root"
  if ! cp -a "$source_root" "$target_root"; then
    log_step "warning: failed to clone noVNC web root into ${target_root}; using distro root"
    return 0
  fi
  DESKTOP_NOVNC_WEB_ROOT="$target_root"

  if [[ ! -f "$error_handler_path" ]]; then
    log_step "warning: noVNC error handler missing at ${error_handler_path}; continuing without extension filter patch"
    return 0
  fi

  cat >"$filter_script_path" <<'EOF_FILTER_JS'
(() => {
  if (typeof window === "undefined") {
    return;
  }
  if (window.__CLAWNOW_NOVNC_ERROR_FILTER === true) {
    return;
  }
  window.__CLAWNOW_NOVNC_ERROR_FILTER = true;

  const knownMessage = (value) => {
    const message = String(value ?? "").trim();
    if (!message) {
      return false;
    }
    return (
      /Cannot redefine property:\s*(ethereum|solana)/i.test(message) ||
      /Cannot assign to read only property\s+['"]?(ethereum|solana)['"]?/i.test(message) ||
      /Cannot set property\s+['"]?(chainId|ethereum|solana)['"]?.*only a getter/i.test(message)
    );
  };

  const isExtensionLocation = (value) =>
    /(chrome|moz)-extension:\/\/|safari-web-extension:\/\//i.test(String(value ?? ""));

  window.addEventListener(
    "error",
    (event) => {
      const message = String(event?.message ?? event?.error?.message ?? "").trim();
      const stack = String(event?.error?.stack ?? "");
      const filename = String(event?.filename ?? "");
      const locationHint = `${filename} ${stack}`;
      if (!knownMessage(message) || !isExtensionLocation(locationHint)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  window.addEventListener(
    "unhandledrejection",
    (event) => {
      const reason = event?.reason;
      const message = String(reason?.message ?? reason ?? "").trim();
      const stack = String(reason?.stack ?? "");
      if (!knownMessage(message) || !isExtensionLocation(stack)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
})();
EOF_FILTER_JS

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$target_root" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
script_tag = '<script src="clawnow-error-filter.js"></script>'
for name in ("vnc.html", "vnc_lite.html", "vnc_auto.html"):
    html_path = root / name
    if not html_path.exists():
        continue
    source = html_path.read_text(encoding="utf-8")
    if "clawnow-error-filter.js" in source:
        continue
    if "</head>" in source:
        updated = source.replace("</head>", f"  {script_tag}\n</head>", 1)
    else:
        updated = re.sub(
            r"(<script[^>]+src=\"(?:app/ui\.js|app/ui-lite\.js|app/ui-auto\.js)\"[^>]*>)",
            script_tag + "\n\\1",
            source,
            count=1,
            flags=re.IGNORECASE,
        )
    html_path.write_text(updated, encoding="utf-8")
PY
  else
    log_step "warning: python3 missing; noVNC HTML prefilter injection skipped"
  fi

  if ! node - "$error_handler_path" <<'NODE'
const fs = require("node:fs");

const filePath = process.argv[2];
let source = fs.readFileSync(filePath, "utf8");
if (source.includes("CLAWNOW_EXTENSION_ERROR_FILTER")) {
  process.exit(0);
}

const marker = "function handleError(event, err) {";
if (!source.includes(marker)) {
  throw new Error("noVNC error handler marker not found");
}

const injectedGuard = `function shouldIgnoreKnownExtensionInjectionErrors(event, err) {
    const message = String(event?.message ?? err?.message ?? "").trim();
    if (!message) {
        return false;
    }
    const knownMessage =
        /Cannot redefine property:\\s*(ethereum|solana)/i.test(message) ||
        /Cannot assign to read only property\\s+['"]?(ethereum|solana)['"]?/i.test(message) ||
        /Cannot set property\\s+['"]?(chainId|ethereum|solana)['"]?.*only a getter/i.test(message);
    if (!knownMessage) {
        return false;
    }

    const locationHint = [
        typeof event?.filename === "string" ? event.filename : "",
        typeof err?.stack === "string" ? err.stack : "",
    ]
        .filter(Boolean)
        .join(" ");

    return /(chrome|moz)-extension:\\/\\//i.test(locationHint);
}

// CLAWNOW_EXTENSION_ERROR_FILTER
`;

source = source.replace(marker, `${injectedGuard}${marker}`);
source = source.replace(
  "function handleError(event, err) {\n",
  `function handleError(event, err) {\n    if (shouldIgnoreKnownExtensionInjectionErrors(event, err)) {\n        return false;\n    }\n`,
);

fs.writeFileSync(filePath, source);
NODE
  then
    log_step "warning: failed to patch noVNC error handler; continuing with unpatched noVNC assets"
  fi
}

install_desktop_runtime_files() {
  cat >/opt/clawnow/clawnow-desktop-runtime.sh <<'EOF_DESKTOP_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NAME="${CLAWNOW_DESKTOP_DISPLAY:-:1}"
DISPLAY_NUMBER="${DISPLAY_NAME#:}"
SCREEN_SIZE="${CLAWNOW_DESKTOP_SCREEN:-1600x1000x24}"
VNC_PORT="${CLAWNOW_DESKTOP_VNC_PORT:-5900}"
NOVNC_PORT="${CLAWNOW_DESKTOP_NOVNC_PORT:-6080}"
NOVNC_WEB_ROOT="${CLAWNOW_DESKTOP_NOVNC_WEB_ROOT:-/usr/share/novnc}"

XVFB_PID=""
X11VNC_PID=""
WEBSOCKIFY_PID=""

cleanup() {
  for pid in "$WEBSOCKIFY_PID" "$X11VNC_PID" "$XVFB_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  wait >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

rm -f "/tmp/.X${DISPLAY_NUMBER}-lock"
rm -f "/tmp/.X11-unix/X${DISPLAY_NUMBER}"
install -d -m 0755 /tmp/.X11-unix

Xvfb "$DISPLAY_NAME" -screen 0 "$SCREEN_SIZE" -ac -nolisten tcp &
XVFB_PID="$!"

for _ in $(seq 1 50); do
  if [[ -S "/tmp/.X11-unix/X${DISPLAY_NUMBER}" ]]; then
    break
  fi
  sleep 0.1
done

x11vnc -display "$DISPLAY_NAME" -rfbport "$VNC_PORT" -shared -forever -localhost -nopw &
X11VNC_PID="$!"

if command -v websockify >/dev/null 2>&1; then
  websockify --web "${NOVNC_WEB_ROOT}/" "127.0.0.1:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" &
else
  python3 -m websockify --web "${NOVNC_WEB_ROOT}/" "127.0.0.1:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" &
fi
WEBSOCKIFY_PID="$!"

wait -n "$XVFB_PID" "$X11VNC_PID" "$WEBSOCKIFY_PID"
exit 1
EOF_DESKTOP_SCRIPT
  chmod +x /opt/clawnow/clawnow-desktop-runtime.sh

  cat >/etc/clawnow-desktop.env <<EOF_DESKTOP_ENV
CLAWNOW_DESKTOP_DISPLAY=${DESKTOP_DISPLAY}
CLAWNOW_DESKTOP_VNC_PORT=${DESKTOP_VNC_PORT}
CLAWNOW_DESKTOP_NOVNC_PORT=${DESKTOP_NOVNC_PORT}
CLAWNOW_DESKTOP_SCREEN=1600x1000x24
CLAWNOW_DESKTOP_NOVNC_WEB_ROOT=${DESKTOP_NOVNC_WEB_ROOT}
EOF_DESKTOP_ENV
}

resolve_public_ipv4() {
  local ip
  ip="$(curl -4fsS --max-time 5 https://api.ipify.org || true)"
  if [[ -n "$ip" ]]; then
    echo "$ip"
    return 0
  fi
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '/src/ {for (i = 1; i <= NF; i++) if ($i == "src") {print $(i+1); exit}}')"
  if [[ -n "$ip" ]]; then
    echo "$ip"
    return 0
  fi
  hostname -I 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+\./) {print $i; exit}}'
}

CONTROL_UI_ALLOWED_ORIGIN="${CONTROL_UI_ORIGIN}"
DETECTED_IPV4=""
if [[ -z "$DETECTED_IPV4" ]]; then
  DETECTED_IPV4="$(resolve_public_ipv4)"
fi

if [[ -n "$GATEWAY_ORIGIN_TEMPLATE" && -n "$DETECTED_IPV4" ]]; then
  TEMPLATE_ORIGIN="$(resolve_gateway_origin_from_template "$GATEWAY_ORIGIN_TEMPLATE" "$DETECTED_IPV4" "$INSTANCE_ID" "$SERVER_ID" || true)"
  if [[ -n "$TEMPLATE_ORIGIN" ]]; then
    if [[ -z "$CONTROL_UI_ALLOWED_ORIGIN" ]]; then
      CONTROL_UI_ALLOWED_ORIGIN="$TEMPLATE_ORIGIN"
    fi
    if [[ "$ENABLE_HTTPS" == "1" && -z "$PUBLIC_HOST" && "$TEMPLATE_ORIGIN" == https://* ]]; then
      PUBLIC_HOST="$(node - "$TEMPLATE_ORIGIN" <<'NODE'
const input = String(process.argv[2] || "").trim();
try {
  process.stdout.write(new URL(input).host);
} catch {}
NODE
)"
    fi
  fi
fi

write_state "packages" "running" "installing base packages"
log_step "installing base packages"
apt-get update
apt-get install -y curl ca-certificates gnupg

write_state "packages" "running" "installing desktop runtime packages"
log_step "installing desktop runtime packages"
install_desktop_runtime_packages

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -Eq '^v(22|23|24|25)\.'; then
  write_state "packages" "running" "installing Node.js 22"
  log_step "installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v pnpm >/dev/null 2>&1; then
  write_state "packages" "running" "installing pnpm"
  log_step "installing pnpm"
  npm install -g pnpm@10
fi

write_state "packages" "running" "installing openclaw"
log_step "installing openclaw@${OPENCLAW_VERSION}"
npm install -g "openclaw@${OPENCLAW_VERSION}"
OPENCLAW_INSTALLED_VERSION="$(openclaw --version 2>/dev/null | head -n 1 | tr -d '[:space:]')"
if [[ -z "$OPENCLAW_INSTALLED_VERSION" ]]; then
  OPENCLAW_INSTALLED_VERSION="$OPENCLAW_VERSION"
fi
log_step "resolved openclaw version: ${OPENCLAW_INSTALLED_VERSION}"

write_state "packages" "running" "installing browser"
log_step "ensuring a supported browser is installed"
install_browser

if [[ "$ENABLE_HTTPS" == "1" ]]; then
  write_state "packages" "running" "installing caddy"
  log_step "installing caddy"
  install_caddy
fi

write_state "proxy" "running" "installing proxy script"
log_step "installing proxy script from ${PROXY_SCRIPT_URL}"
install -d -m 0755 /opt/clawnow
curl -fsSL "$PROXY_SCRIPT_URL" -o /opt/clawnow/clawnow-proxy.mjs
chmod +x /opt/clawnow/clawnow-proxy.mjs

write_state "desktop_runtime" "running" "installing desktop runtime scripts"
log_step "installing desktop runtime scripts"
prepare_novnc_web_root
install_desktop_runtime_files

if [[ -n "$CONTROL_UI_MANIFEST_URL" ]]; then
  write_state "control_ui" "running" "updating control ui assets"
  log_step "installing control ui updater from ${CONTROL_UI_UPDATER_SCRIPT_URL}"
  curl -fsSL "$CONTROL_UI_UPDATER_SCRIPT_URL" -o /opt/clawnow/clawnow-control-ui-updater.sh
  chmod +x /opt/clawnow/clawnow-control-ui-updater.sh

  log_step "running control ui updater with manifest ${CONTROL_UI_MANIFEST_URL}"
  CONTROL_UI_UPDATE_OUTPUT=""
  if CONTROL_UI_UPDATE_OUTPUT="$(
    /opt/clawnow/clawnow-control-ui-updater.sh \
      --manifest-url "$CONTROL_UI_MANIFEST_URL" \
      --install-root /opt/clawnow/control-ui \
      --print-root
  )"; then
    CONTROL_UI_ROOT="$(printf '%s\n' "$CONTROL_UI_UPDATE_OUTPUT" | tail -n 1 | tr -d '\r')"
    log_step "control ui update complete (root=${CONTROL_UI_ROOT})"
  else
    log_step "warning: control ui update failed; continuing with packaged UI"
    log_step "control ui updater output: ${CONTROL_UI_UPDATE_OUTPUT}"
    CONTROL_UI_ROOT=""
  fi
fi

cat >/etc/clawnow-proxy.env <<EOF_ENV
CLAWNOW_PROXY_SHARED_SECRET=${PROXY_SECRET}
CLAWNOW_PROXY_BIND=${PROXY_BIND}
CLAWNOW_PROXY_PORT=${PROXY_PORT}
CLAWNOW_OPENCLAW_UPSTREAM=http://127.0.0.1:${GATEWAY_PORT}
CLAWNOW_NOVNC_UPSTREAM=http://127.0.0.1:${DESKTOP_NOVNC_PORT}
CLAWNOW_PROXY_CONTROL_PREFIX=${CONTROL_PREFIX}
CLAWNOW_PROXY_NOVNC_PREFIX=${NOVNC_PREFIX}
CLAWNOW_PROXY_EXPECTED_ISS=clawnow-control-plane
CLAWNOW_PROXY_EXPECTED_AUD=openclaw-gateway
CLAWNOW_PROXY_HEALTH_UPSTREAM_TIMEOUT_MS=2000
EOF_ENV

if [[ "$ENABLE_HTTPS" == "1" && -z "$PUBLIC_HOST" ]]; then
  if [[ -z "$DETECTED_IPV4" ]]; then
    DETECTED_IPV4="$(resolve_public_ipv4)"
  fi
  if [[ -z "$DETECTED_IPV4" ]]; then
    echo "Unable to detect public IPv4 for HTTPS host. Pass --public-host explicitly." >&2
    exit 1
  fi
  PUBLIC_HOST="${PUBLIC_HOST_TEMPLATE//\{\{IPV4\}\}/$DETECTED_IPV4}"
fi

if [[ "$ENABLE_HTTPS" == "1" && "$PUBLIC_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  log_step "PUBLIC_HOST resolved as raw IPv4 (${PUBLIC_HOST}); converting to sslip.io host"
  PUBLIC_HOST="${PUBLIC_HOST}.sslip.io"
fi

if [[ "$ENABLE_HTTPS" == "1" && -z "$CONTROL_UI_ALLOWED_ORIGIN" && -n "$PUBLIC_HOST" ]]; then
  CONTROL_UI_ALLOWED_ORIGIN="https://${PUBLIC_HOST}"
fi

if [[ "$ENABLE_HTTPS" != "1" && -z "$CONTROL_UI_ALLOWED_ORIGIN" ]]; then
  if [[ -z "$PUBLIC_HOST" && -n "$DETECTED_IPV4" ]]; then
    PUBLIC_HOST="$DETECTED_IPV4"
  fi
  if [[ -n "$PUBLIC_HOST" ]]; then
    CONTROL_UI_ALLOWED_ORIGIN="$(resolve_http_origin_from_host "$PUBLIC_HOST" "$PROXY_PORT" || true)"
  fi
fi

cat >/etc/openclaw-gateway.env <<EOF_GATEWAY_ENV
OPENCLAW_VERSION=${OPENCLAW_INSTALLED_VERSION}
OPENCLAW_SERVICE_VERSION=${OPENCLAW_INSTALLED_VERSION}
DISPLAY=${DESKTOP_DISPLAY}
EOF_GATEWAY_ENV

write_state "gateway_config" "running" "writing OpenClaw gateway config"
log_step "writing gateway trusted-proxy config"
CONTROL_PREFIX="$CONTROL_PREFIX" \
CLAWNOW_ENABLE_HTTPS="$ENABLE_HTTPS" \
CLAWNOW_CONTROL_UI_ALLOWED_ORIGIN="$CONTROL_UI_ALLOWED_ORIGIN" \
CLAWNOW_CONTROL_UI_ROOT="$CONTROL_UI_ROOT" \
CLAWNOW_CONTROL_PLANE_DEVICE_ID="$CONTROL_PLANE_DEVICE_ID" \
CLAWNOW_CONTROL_PLANE_DEVICE_PUBLIC_KEY="$CONTROL_PLANE_DEVICE_PUBLIC_KEY" \
node <<'NODE'
const fs = require('node:fs');

const configPath = '/root/.openclaw/openclaw.json';
const stateDir = '/root/.openclaw';
const credentialsDir = '/root/.openclaw/credentials';
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(credentialsDir, { recursive: true });

let config = {};
if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    config = {};
  }
}

config.gateway = config.gateway || {};
config.gateway.mode = config.gateway.mode || 'local';
// Disable automatic config reload/restart while running the onboarding wizard.
// The wizard writes config multiple times; hot reload can restart the gateway mid-flow,
// wiping the in-memory wizard session and forcing users to start over.
	config.gateway.reload = config.gateway.reload || {};
	config.gateway.reload.mode = 'off';
	config.gateway.auth = config.gateway.auth || {};
	// Gateway binds to loopback and is only reachable through the local ClawNow proxy.
	// Use "none" here so local CLI/doctor/browser probes can connect directly without
	// needing trusted-proxy headers (the proxy already enforces session auth).
	config.gateway.auth.mode = 'none';
	config.gateway.auth.trustedProxy = config.gateway.auth.trustedProxy || {};
	config.gateway.auth.trustedProxy.userHeader = 'x-forwarded-user';
	config.gateway.auth.trustedProxy.requiredHeaders = [
	  'x-clawnow-verified',
  'x-clawnow-instance-id',
  'x-clawnow-session-type',
];
config.gateway.trustedProxies = ['127.0.0.1', '::1'];
config.gateway.controlUi = config.gateway.controlUi || {};
config.gateway.controlUi.basePath = process.env.CONTROL_PREFIX || '/clawnow';
config.browser =
  config.browser && typeof config.browser === 'object' && !Array.isArray(config.browser)
    ? config.browser
    : {};
config.browser.enabled = true;
const browserDefaultProfile =
  typeof config.browser.defaultProfile === 'string' ? config.browser.defaultProfile.trim() : '';
if (!browserDefaultProfile || browserDefaultProfile.toLowerCase() === 'chrome') {
  config.browser.defaultProfile = 'openclaw';
}
config.tools =
  config.tools && typeof config.tools === 'object' && !Array.isArray(config.tools)
    ? config.tools
    : {};
config.tools.exec =
  config.tools.exec && typeof config.tools.exec === 'object' && !Array.isArray(config.tools.exec)
    ? config.tools.exec
    : {};
// ClawNow runs managed gateway/browser flows; keep shell exec in allowlist mode by default
// so assistant turns cannot silently run maintenance commands like "openclaw doctor".
config.tools.exec.security = 'allowlist';
const execAsk =
  typeof config.tools.exec.ask === 'string' ? config.tools.exec.ask.trim().toLowerCase() : '';
if (execAsk !== 'off' && execAsk !== 'on-miss' && execAsk !== 'always') {
  config.tools.exec.ask = 'on-miss';
}
const controlUiRoot = (process.env.CLAWNOW_CONTROL_UI_ROOT || '').trim();
if (controlUiRoot) {
  config.gateway.controlUi.root = controlUiRoot;
}
const allowedOrigin = (process.env.CLAWNOW_CONTROL_UI_ALLOWED_ORIGIN || '').trim();
if (allowedOrigin) {
  config.gateway.controlUi.allowedOrigins = [allowedOrigin];
}
// ClawNow proxy terminates public traffic and forwards to loopback gateway.
// Allow Host-header origin fallback so browser origin checks pass for per-VM public hosts.
config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
// In HTTP mode (no TLS), browser secure-context APIs are unavailable and OpenClaw
// will otherwise clear requested scopes. We intentionally bypass device auth in
// this mode so trusted-proxy sessions can still operate.
const enableHttps = process.env.CLAWNOW_ENABLE_HTTPS === '1';
if (!enableHttps) {
  config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
}

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const controlPlaneDeviceId = (process.env.CLAWNOW_CONTROL_PLANE_DEVICE_ID || '').trim();
const controlPlaneDevicePublicKey = (process.env.CLAWNOW_CONTROL_PLANE_DEVICE_PUBLIC_KEY || '').trim();
if ((controlPlaneDeviceId && !controlPlaneDevicePublicKey) || (!controlPlaneDeviceId && controlPlaneDevicePublicKey)) {
  throw new Error('control-plane device id/public key must both be set');
}
if (controlPlaneDeviceId && controlPlaneDevicePublicKey) {
  const now = Date.now();
  const deviceScopes = [
    'operator.admin',
    'operator.read',
    'operator.write',
    'operator.approvals',
    'operator.pairing',
  ];
  const devicesDir = '/root/.openclaw/devices';
  const pairedPath = `${devicesDir}/paired.json`;
  fs.mkdirSync(devicesDir, { recursive: true });

  let paired = {};
  if (fs.existsSync(pairedPath)) {
    try {
      paired = JSON.parse(fs.readFileSync(pairedPath, 'utf8'));
    } catch {
      paired = {};
    }
  }
  if (!paired || typeof paired !== 'object' || Array.isArray(paired)) {
    paired = {};
  }
  const existing = paired[controlPlaneDeviceId] && typeof paired[controlPlaneDeviceId] === 'object'
    ? paired[controlPlaneDeviceId]
    : {};
  const existingRoles = Array.isArray(existing.roles)
    ? existing.roles.filter((role) => typeof role === 'string' && role.trim().length > 0)
    : typeof existing.role === 'string' && existing.role.trim().length > 0
      ? [existing.role.trim()]
      : [];
  const roles = Array.from(new Set([...existingRoles, 'operator']));

  paired[controlPlaneDeviceId] = {
    ...existing,
    deviceId: controlPlaneDeviceId,
    publicKey: controlPlaneDevicePublicKey,
    displayName: existing.displayName || 'clawnow-control-plane',
    platform: existing.platform || 'server',
    clientId: existing.clientId || 'gateway-client',
    clientMode: existing.clientMode || 'backend',
    role: 'operator',
    roles,
    scopes: deviceScopes,
    approvedScopes: deviceScopes,
    createdAtMs: typeof existing.createdAtMs === 'number' ? existing.createdAtMs : now,
    approvedAtMs: now,
  };

  fs.writeFileSync(pairedPath, `${JSON.stringify(paired, null, 2)}\n`);
}
NODE

if [[ "$ENABLE_HTTPS" == "1" ]]; then
  write_state "caddy_config" "running" "configuring caddy"
  log_step "configuring caddy"

  cat >/etc/caddy/Caddyfile <<EOF_CADDY
${PUBLIC_HOST} {
  @bootstrap path /__clawnow/bootstrap
  handle @bootstrap {
    root * ${STATE_DIR}
    rewrite * /bootstrap-state.json
    file_server
  }

  reverse_proxy 127.0.0.1:${PROXY_PORT}
}
EOF_CADDY

  caddy validate --config /etc/caddy/Caddyfile
fi

write_state "systemd" "running" "writing service units"
log_step "writing systemd units"
cat >/etc/systemd/system/clawnow-desktop.service <<'EOF_DESKTOP_SERVICE'
[Unit]
Description=ClawNow Desktop Runtime
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
EnvironmentFile=-/etc/clawnow-desktop.env
ExecStart=/usr/bin/env bash -lc '/opt/clawnow/clawnow-desktop-runtime.sh'
Restart=always
RestartSec=3
User=root
WorkingDirectory=/opt/clawnow

[Install]
WantedBy=multi-user.target
EOF_DESKTOP_SERVICE

cat >/etc/systemd/system/openclaw-gateway.service <<EOF_GATEWAY
[Unit]
Description=OpenClaw Gateway
After=network.target clawnow-desktop.service
Wants=clawnow-desktop.service
StartLimitIntervalSec=0

[Service]
Type=simple
EnvironmentFile=/etc/openclaw-gateway.env
ExecStart=/usr/bin/env bash -lc 'openclaw gateway run --bind loopback --port ${GATEWAY_PORT} --force --allow-unconfigured'
Restart=always
RestartSec=3
User=root
WorkingDirectory=/root

[Install]
WantedBy=multi-user.target
EOF_GATEWAY

cat >/etc/systemd/system/clawnow-proxy.service <<'EOF_PROXY'
[Unit]
Description=ClawNow Trusted Proxy
After=network.target openclaw-gateway.service
Wants=openclaw-gateway.service
StartLimitIntervalSec=0

[Service]
Type=simple
EnvironmentFile=/etc/clawnow-proxy.env
ExecStart=/usr/bin/env bash -lc 'node /opt/clawnow/clawnow-proxy.mjs'
Restart=always
RestartSec=3
User=root
WorkingDirectory=/opt/clawnow

[Install]
WantedBy=multi-user.target
EOF_PROXY

systemctl daemon-reload

if [[ "$ENABLE_HTTPS" == "1" ]]; then
  write_state "caddy_start" "running" "starting caddy"
  log_step "starting caddy for host ${PUBLIC_HOST}"
  # apt install may auto-start Caddy with the default config; restart to guarantee our generated Caddyfile is applied.
  systemctl enable caddy
  systemctl restart caddy
  systemctl is-active caddy >/dev/null

  if wait_for_tcp_port 127.0.0.1 443 90 1; then
    log_step "caddy is listening on 443"
  else
    log_step "warning: caddy 443 listener not ready yet (certificate issuance may still be in progress)"
  fi
fi

write_state "desktop_start" "running" "starting desktop runtime"
log_step "starting clawnow-desktop.service"
systemctl enable clawnow-desktop.service
systemctl restart clawnow-desktop.service
systemctl is-active clawnow-desktop.service >/dev/null

write_state "gateway_start" "running" "starting openclaw gateway"
log_step "starting openclaw-gateway.service"
systemctl enable openclaw-gateway.service
systemctl restart openclaw-gateway.service
systemctl is-active openclaw-gateway.service >/dev/null

write_state "proxy_start" "running" "starting clawnow proxy"
log_step "starting clawnow-proxy.service"
systemctl enable clawnow-proxy.service
systemctl restart clawnow-proxy.service
systemctl is-active clawnow-proxy.service >/dev/null

if ! wait_for_tcp_port 127.0.0.1 "$GATEWAY_PORT" 120 1; then
  write_state "failed" "error" "openclaw gateway port ${GATEWAY_PORT} did not become ready in time"
  echo "OpenClaw gateway port ${GATEWAY_PORT} did not become ready in time" >&2
  exit 1
fi
if ! wait_for_tcp_port 127.0.0.1 "$PROXY_PORT" 120 1; then
  write_state "failed" "error" "proxy port ${PROXY_PORT} did not become ready in time"
  echo "ClawNow proxy port ${PROXY_PORT} did not become ready in time" >&2
  exit 1
fi
if ! wait_for_tcp_port 127.0.0.1 "$DESKTOP_NOVNC_PORT" 120 1; then
  write_state "failed" "error" "desktop novnc port ${DESKTOP_NOVNC_PORT} did not become ready in time"
  echo "Desktop noVNC port ${DESKTOP_NOVNC_PORT} did not become ready in time" >&2
  exit 1
fi

if [[ "$ENABLE_HTTPS" == "1" ]]; then
  write_state "ready" "ok" "gateway ready with https host ${PUBLIC_HOST}"
  log_step "bootstrap complete: https://${PUBLIC_HOST}${CONTROL_PREFIX}/"
else
  write_state "ready" "ok" "gateway ready on http proxy"
  log_step "bootstrap complete: http://${PROXY_BIND}:${PROXY_PORT}${CONTROL_PREFIX}/"
fi

systemctl is-active clawnow-desktop.service
systemctl is-active openclaw-gateway.service
systemctl is-active clawnow-proxy.service
if [[ "$ENABLE_HTTPS" == "1" ]]; then
  systemctl is-active caddy
fi

echo "ClawNow VM bootstrap complete."
