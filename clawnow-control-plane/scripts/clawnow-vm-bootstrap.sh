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

  for unit in openclaw-gateway.service clawnow-proxy.service caddy.service; do
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
OPENCLAW_MANAGED_TRUSTED_PROXY=1
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
fs.mkdirSync(stateDir, { recursive: true });

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
config.gateway.auth.mode = 'trusted-proxy';
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
cat >/etc/systemd/system/openclaw-gateway.service <<EOF_GATEWAY
[Unit]
Description=OpenClaw Gateway
After=network.target
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
  echo "OpenClaw gateway port ${GATEWAY_PORT} did not become ready in time" >&2
  exit 1
fi
if ! wait_for_tcp_port 127.0.0.1 "$PROXY_PORT" 120 1; then
  echo "ClawNow proxy port ${PROXY_PORT} did not become ready in time" >&2
  exit 1
fi

if [[ "$ENABLE_HTTPS" == "1" ]]; then
  write_state "ready" "ok" "gateway ready with https host ${PUBLIC_HOST}"
  log_step "bootstrap complete: https://${PUBLIC_HOST}${CONTROL_PREFIX}/"
else
  write_state "ready" "ok" "gateway ready on http proxy"
  log_step "bootstrap complete: http://${PROXY_BIND}:${PROXY_PORT}${CONTROL_PREFIX}/"
fi

systemctl is-active openclaw-gateway.service
systemctl is-active clawnow-proxy.service
if [[ "$ENABLE_HTTPS" == "1" ]]; then
  systemctl is-active caddy
fi

echo "ClawNow VM bootstrap complete."
