import type {
  GatewayAuthConfig,
  GatewayTrustedProxyConfig,
  OpenClawConfig,
} from "../config/config.js";

const MANAGED_TRUSTED_PROXY_ENV = "OPENCLAW_MANAGED_TRUSTED_PROXY";

// ClawNow defaults. We only apply these when the managed env flag is enabled.
// Preserve/merge existing config values whenever possible.
export const MANAGED_TRUSTED_PROXY_DEFAULT_USER_HEADER = "x-forwarded-user";
export const MANAGED_TRUSTED_PROXY_DEFAULT_REQUIRED_HEADERS = [
  "x-clawnow-verified",
  "x-clawnow-instance-id",
  "x-clawnow-session-type",
];
export const MANAGED_TRUSTED_PROXY_DEFAULT_TRUSTED_PROXIES = ["127.0.0.1", "::1"];

export function isManagedTrustedProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[MANAGED_TRUSTED_PROXY_ENV];
  if (!raw) {
    return false;
  }
  return raw === "1" || raw.toLowerCase() === "true";
}

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function ensureManagedTrustedProxies(value: unknown): string[] {
  const configured = normalizeStringList(value);
  const merged = new Set(configured);
  for (const proxy of MANAGED_TRUSTED_PROXY_DEFAULT_TRUSTED_PROXIES) {
    merged.add(proxy);
  }
  return [...merged];
}

export function enforceManagedTrustedProxyAuthConfig(auth: GatewayAuthConfig): void {
  // Force the auth mode regardless of incoming overrides/config drift.
  auth.mode = "trusted-proxy";

  // In managed mode, treat token/password as invalid: remove them so we can't
  // accidentally fall back to token/password auth paths.
  delete auth.token;
  delete auth.password;

  const nextTrustedProxy: GatewayTrustedProxyConfig = auth.trustedProxy
    ? { ...auth.trustedProxy }
    : { userHeader: MANAGED_TRUSTED_PROXY_DEFAULT_USER_HEADER };

  nextTrustedProxy.userHeader =
    nextTrustedProxy.userHeader?.trim() || MANAGED_TRUSTED_PROXY_DEFAULT_USER_HEADER;
  if (
    !Array.isArray(nextTrustedProxy.requiredHeaders) ||
    nextTrustedProxy.requiredHeaders.length === 0
  ) {
    nextTrustedProxy.requiredHeaders = [...MANAGED_TRUSTED_PROXY_DEFAULT_REQUIRED_HEADERS];
  }

  auth.trustedProxy = nextTrustedProxy;
}

export function enforceManagedTrustedProxyGatewayConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = structuredClone(cfg);
  next.gateway = next.gateway || {};
  next.gateway.mode = next.gateway.mode || "local";
  next.gateway.auth = next.gateway.auth || {};
  enforceManagedTrustedProxyAuthConfig(next.gateway.auth);

  // Ensure loopback proxies so the gateway can authenticate requests coming from
  // a local reverse proxy (like clawnow-proxy).
  next.gateway.trustedProxies = ensureManagedTrustedProxies(next.gateway.trustedProxies);

  // Managed deployments rely on an explicit reverse proxy; keep reload off to avoid
  // flapping restarts when the control plane patches config mid-flight.
  next.gateway.reload = next.gateway.reload || {};
  next.gateway.reload.mode = "off";

  return next;
}
