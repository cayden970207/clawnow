#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const COOKIE_PREFIX = "clawnow_tp_";

function loadDotEnv(dotenvPath) {
  if (!fs.existsSync(dotenvPath)) {
    return;
  }
  const content = fs.readFileSync(dotenvPath, "utf8");
  const lines = content.split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key]) {
      continue;
    }
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parseBoolean(value, fallback) {
  if (value == null) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePort(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parseUpstream(name, fallback) {
  const raw = process.env[name]?.trim() || fallback;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL for ${name}: ${raw}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${name} must use http:// or https://`);
  }
  return parsed;
}

function parseLoopbackLocalAddress(value, fallback) {
  const raw = (value || "").trim();
  if (!raw) {
    return fallback;
  }
  if (net.isIP(raw) !== 4) {
    return fallback;
  }
  // Keep it loopback-only; this is used to force proxy -> gateway source IP.
  if (!raw.startsWith("127.")) {
    return fallback;
  }
  return raw;
}

function isLoopbackRemoteAddress(remoteAddress) {
  const raw = typeof remoteAddress === "string" ? remoteAddress.trim() : "";
  if (!raw) {
    return false;
  }
  if (raw === "::1") {
    return true;
  }
  if (raw.startsWith("::ffff:")) {
    const mapped = raw.slice("::ffff:".length);
    return net.isIP(mapped) === 4 && mapped.startsWith("127.");
  }
  return net.isIP(raw) === 4 && raw.startsWith("127.");
}

function hasForwardedHeaders(req) {
  return Boolean(
    req.headers["x-forwarded-for"] ||
      req.headers["x-real-ip"] ||
      req.headers["x-forwarded-host"] ||
      req.headers["x-forwarded-proto"],
  );
}

function isDirectLoopbackClient(req) {
  return isLoopbackRemoteAddress(req.socket?.remoteAddress) && !hasForwardedHeaders(req);
}

function normalizePrefix(value, fallback) {
  const raw = (value || fallback || "/").trim();
  if (!raw.startsWith("/")) {
    return `/${raw}`;
  }
  return raw.replace(/\/+$/, "") || "/";
}

function safeB64UrlDecode(segment) {
  return Buffer.from(segment, "base64url").toString("utf8");
}

function constantTimeEqual(a, b) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return timingSafeEqual(aBuffer, bBuffer);
}

function verifySignedToken(token, config) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("malformed_token");
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  const expectedSignature = createHmac("sha256", config.sharedSecret)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest("base64url");
  if (!constantTimeEqual(signatureSegment, expectedSignature)) {
    throw new Error("invalid_signature");
  }

  let header;
  let payload;
  try {
    header = JSON.parse(safeB64UrlDecode(headerSegment));
    payload = JSON.parse(safeB64UrlDecode(payloadSegment));
  } catch {
    throw new Error("invalid_json");
  }

  if (header?.alg !== "HS256") {
    throw new Error("invalid_alg");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid_payload");
  }
  if (typeof payload.sub !== "string" || payload.sub.trim() === "") {
    throw new Error("missing_sub");
  }
  if (typeof payload.exp !== "number") {
    throw new Error("missing_exp");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const tokenClockSkewSeconds =
    Number.isFinite(config.tokenClockSkewSeconds) && config.tokenClockSkewSeconds > 0
      ? Math.floor(config.tokenClockSkewSeconds)
      : 0;
  if (payload.exp + tokenClockSkewSeconds <= nowSeconds) {
    throw new Error("token_expired");
  }
  if (typeof payload.instance_id !== "string" || payload.instance_id.trim() === "") {
    throw new Error("missing_instance_id");
  }
  if (typeof payload.session_type !== "string" || payload.session_type.trim() === "") {
    throw new Error("missing_session_type");
  }
  if (payload.trusted_proxy !== true) {
    throw new Error("trusted_proxy_flag_missing");
  }
  if (config.expectedIss && payload.iss !== config.expectedIss) {
    throw new Error("invalid_iss");
  }

  if (config.expectedAud) {
    const audience = payload.aud;
    const matchesAudience = Array.isArray(audience)
      ? audience.includes(config.expectedAud)
      : audience === config.expectedAud;
    if (!matchesAudience) {
      throw new Error("invalid_aud");
    }
  }

  return {
    sub: payload.sub,
    iss: payload.iss,
    aud: payload.aud,
    exp: payload.exp,
    iat: payload.iat,
    instanceId: payload.instance_id,
    sessionType: payload.session_type,
  };
}

function getBearerToken(authHeader) {
  if (!authHeader) {
    return null;
  }
  if (Array.isArray(authHeader)) {
    return getBearerToken(authHeader[0]);
  }
  const normalized = authHeader.trim();
  if (!normalized.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = normalized.slice(7).trim();
  return token || null;
}

function parseCookies(cookieHeader) {
  const source = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader || "";
  const result = {};
  for (const segment of source.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!key) {
      continue;
    }
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function getCookieNameForSessionType(sessionType) {
  return `${COOKIE_PREFIX}${sessionType}`;
}

function normalizeExpectedSessionTypes(expectedSessionType) {
  if (typeof expectedSessionType === "string" && expectedSessionType.trim()) {
    return [expectedSessionType.trim()];
  }
  if (!Array.isArray(expectedSessionType)) {
    return [];
  }
  const normalized = [];
  for (const value of expectedSessionType) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || normalized.includes(trimmed)) {
      continue;
    }
    normalized.push(trimmed);
  }
  return normalized;
}

function getCookieToken(req, expectedSessionType) {
  const cookies = parseCookies(req.headers.cookie);
  const expected = normalizeExpectedSessionTypes(expectedSessionType);
  if (expected.length > 0) {
    for (const sessionType of expected) {
      const token = cookies[getCookieNameForSessionType(sessionType)];
      if (token) {
        return token;
      }
    }
    return null;
  }
  return (
    cookies[getCookieNameForSessionType("control_ui")] ||
    cookies[getCookieNameForSessionType("novnc")] ||
    null
  );
}

function buildSessionCookie(claims, prefix) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const maxAge = Math.max(1, Math.floor(claims.exp - nowSeconds));
  const cookieName = getCookieNameForSessionType(claims.sessionType);
  const pathValue =
    claims.sessionType === "control_ui" ? "/" : prefix && prefix !== "/" ? prefix : "/";
  return `${cookieName}=${encodeURIComponent(claims.token)}; Path=${pathValue}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function appendForwardedFor(existing, remoteAddress) {
  const resolvedRemote = remoteAddress || "unknown";
  if (!existing) {
    return resolvedRemote;
  }
  if (Array.isArray(existing)) {
    const joined = existing.join(", ").trim();
    return joined ? `${joined}, ${resolvedRemote}` : resolvedRemote;
  }
  const trimmed = existing.trim();
  return trimmed ? `${trimmed}, ${resolvedRemote}` : resolvedRemote;
}

function buildForwardHeaders(req, upstream, claims) {
  const headers = {};
  for (const [rawKey, rawValue] of Object.entries(req.headers)) {
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key)) {
      continue;
    }
    if (key === "host" || key === "authorization" || key === "content-length") {
      continue;
    }
    if (rawValue === undefined) {
      continue;
    }
    headers[rawKey] = rawValue;
  }

  const requestHost =
    (Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host) || upstream.host;
  headers.Host = requestHost;
  headers["X-Forwarded-For"] = appendForwardedFor(
    req.headers["x-forwarded-for"],
    req.socket.remoteAddress,
  );
  headers["X-Forwarded-Proto"] =
    (Array.isArray(req.headers["x-forwarded-proto"])
      ? req.headers["x-forwarded-proto"][0]
      : req.headers["x-forwarded-proto"]) || "https";
  headers["X-Forwarded-Host"] =
    (Array.isArray(req.headers["x-forwarded-host"])
      ? req.headers["x-forwarded-host"][0]
      : req.headers["x-forwarded-host"]) ||
    req.headers.host ||
    upstream.host;

  headers["X-Forwarded-User"] = claims.sub;
  headers["X-ClawNow-Verified"] = "1";
  headers["X-ClawNow-Instance-Id"] = claims.instanceId;
  headers["X-ClawNow-Session-Type"] = claims.sessionType;

  return headers;
}

function sanitizeResponseHeaders(headers) {
  const sanitized = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) {
      continue;
    }
    if (HOP_BY_HOP_HEADERS.has(rawKey.toLowerCase())) {
      continue;
    }
    sanitized[rawKey] = rawValue;
  }
  return sanitized;
}

function writeHttpError(res, statusCode, code, message) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      success: false,
      error: message,
      code,
    }),
  );
}

function writeUpgradeError(socket, statusCode, message) {
  const statusLine =
    statusCode === 401
      ? "401 Unauthorized"
      : statusCode === 403
        ? "403 Forbidden"
        : statusCode === 404
          ? "404 Not Found"
          : "502 Bad Gateway";
  socket.write(
    `HTTP/1.1 ${statusLine}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${message}`,
  );
  socket.destroy();
}

function resolveTarget(url) {
  const portRaw = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const port =
    Number.isInteger(portRaw) && portRaw > 0 ? portRaw : url.protocol === "https:" ? 443 : 80;
  return { host: url.hostname, port };
}

function checkTcpConnectivity(params) {
  const { host, port, timeoutMs } = params;
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, error) => {
      if (done) {
        return;
      }
      done = true;
      resolve({ ok, error: error ? String(error) : null });
    };

    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      finish(false, "timeout");
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      finish(true, null);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      finish(false, err?.message || err);
    });
  });
}

async function writeHealthResponse(res, config) {
  const openclawTarget = resolveTarget(config.openclawUpstream);
  const openclaw = await checkTcpConnectivity({ ...openclawTarget, timeoutMs: 700 });
  const novncTarget = config.novncUpstream ? resolveTarget(config.novncUpstream) : null;
  const novnc = novncTarget ? await checkTcpConnectivity({ ...novncTarget, timeoutMs: 700 }) : null;

  const success = openclaw.ok && (novnc ? novnc.ok : true);
  const payload = {
    success,
    service: "clawnow-proxy",
    checkedAt: new Date().toISOString(),
    upstream: {
      openclaw: { ...openclawTarget, ok: openclaw.ok, error: openclaw.error },
      ...(novncTarget
        ? { novnc: { ...novncTarget, ok: novnc?.ok === true, error: novnc?.error ?? null } }
        : {}),
    },
    ...(success
      ? {}
      : {
          code: "upstream_unavailable",
          error: "One or more upstream services are unavailable",
        }),
  };

  res.statusCode = success ? 200 : 503;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function writeBootstrapResponse(res, config) {
  const stateFile = config.bootstrapStateFile;
  try {
    if (!fs.existsSync(stateFile)) {
      writeHttpError(res, 404, "bootstrap_state_missing", "Bootstrap state file not found");
      return;
    }
    const raw = fs.readFileSync(stateFile, "utf8");
    if (!raw || !raw.trim()) {
      writeHttpError(res, 500, "bootstrap_state_invalid", "Bootstrap state file is empty");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(raw);
  } catch (error) {
    writeHttpError(
      res,
      500,
      "bootstrap_state_error",
      `Failed to read bootstrap state: ${String(error?.message || error)}`,
    );
  }
}

function enforceGatewayTrustedProxyConfig(config) {
  const stateDir = "/root/.openclaw";
  const configPath = `${stateDir}/openclaw.json`;
  fs.mkdirSync(stateDir, { recursive: true });

  let existing = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      existing = {};
    }
  }

  const next = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  next.gateway = next.gateway || {};
  const localGatewayUrl = `ws://127.0.0.1:${config.port}${config.localGatewayPrefix}`;
  // Route all VM-local CLI/agent gateway RPC through the local proxy path.
  // This isolates local calls from trusted-proxy header requirements while
  // keeping public browser traffic on managed trusted-proxy auth.
  next.gateway.mode = "remote";
  next.gateway.remote =
    next.gateway.remote && typeof next.gateway.remote === "object" && !Array.isArray(next.gateway.remote)
      ? next.gateway.remote
      : {};
  next.gateway.remote.url = localGatewayUrl;
  delete next.gateway.remote.token;
  delete next.gateway.remote.password;
  next.gateway.auth = next.gateway.auth || {};
  // ClawNow runs in managed trusted-proxy mode. Keep gateway auth aligned with
  // control-plane issued trusted-proxy sessions to avoid auth-mode drift.
  next.gateway.auth.mode = "trusted-proxy";
  next.gateway.auth.trustedProxy = next.gateway.auth.trustedProxy || {};
  next.gateway.auth.trustedProxy.userHeader = "x-forwarded-user";
  next.gateway.auth.trustedProxy.requiredHeaders = [
    "x-clawnow-verified",
    "x-clawnow-instance-id",
    "x-clawnow-session-type",
  ];

  // Ensure we do not accidentally fall back to token/password auth.
  delete next.gateway.auth.token;
  delete next.gateway.auth.password;

  // Keep trusted-proxy traffic distinct from local CLI/tools by using a
  // different loopback source IP for proxy -> gateway connections.
  // - proxy connects with localAddress=127.0.0.2 (trusted)
  // - local tools connect from 127.0.0.1 (not trusted)
  // Include ::1 to satisfy OpenClaw's bind=loopback trusted-proxy validation.
  next.gateway.trustedProxies = ["127.0.0.2", "::1"];
  next.gateway.controlUi = next.gateway.controlUi || {};
  next.gateway.controlUi.basePath = next.gateway.controlUi.basePath || config.controlPrefix;
  next.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
  next.update =
    next.update && typeof next.update === "object" && !Array.isArray(next.update) ? next.update : {};
  // Platform-managed upgrades: keep VM-side update prompts/auto-updates disabled.
  next.update.checkOnStart = false;
  next.update.auto =
    next.update.auto && typeof next.update.auto === "object" && !Array.isArray(next.update.auto)
      ? next.update.auto
      : {};
  next.update.auto.enabled = false;
  // ClawNow proxy is the trust boundary; skip browser pairing ceremony so
  // Control UI connections do not fail on device identity checks.
  next.gateway.controlUi.dangerouslyDisableDeviceAuth = true;

  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return { configPath };
}

async function handleGatewayRepair(req, res, config) {
  if ((req.method || "").toUpperCase() !== "POST") {
    writeHttpError(res, 405, "method_not_allowed", "Use POST to repair gateway");
    return;
  }

  // Drain request body (best-effort) so keep-alive clients don't get stuck.
  try {
    req.resume();
  } catch {}

  const details = {
    config: null,
    restarted: false,
    upstreamReady: false,
    checkedAt: new Date().toISOString(),
  };

  try {
    details.config = enforceGatewayTrustedProxyConfig(config);
  } catch (error) {
    writeHttpError(
      res,
      500,
      "repair_config_failed",
      `Failed to enforce gateway config: ${String(error?.message || error)}`,
    );
    return;
  }

  const resetRes = spawnSync("systemctl", ["reset-failed", config.openclawService], {
    encoding: "utf8",
    timeout: 6000,
  });
  details.resetFailedExitCode =
    typeof resetRes.status === "number" ? resetRes.status : resetRes.error ? -1 : null;

  const restartRes = spawnSync("systemctl", ["restart", config.openclawService], {
    encoding: "utf8",
    timeout: 12_000,
  });
  details.restartExitCode =
    typeof restartRes.status === "number" ? restartRes.status : restartRes.error ? -1 : null;

  if (restartRes.error || restartRes.status !== 0) {
    const startRes = spawnSync("systemctl", ["start", config.openclawService], {
      encoding: "utf8",
      timeout: 12_000,
    });
    details.startFallbackExitCode =
      typeof startRes.status === "number" ? startRes.status : startRes.error ? -1 : null;
    if (startRes.error || startRes.status !== 0) {
      const restartMessage = restartRes.error
        ? String(restartRes.error?.message || restartRes.error)
        : `${restartRes.status}: ${(restartRes.stderr || restartRes.stdout || "").trim() || "unknown error"}`;
      const startMessage = startRes.error
        ? String(startRes.error?.message || startRes.error)
        : `${startRes.status}: ${(startRes.stderr || startRes.stdout || "").trim() || "unknown error"}`;
      writeHttpError(
        res,
        502,
        "repair_restart_failed",
        `systemctl restart/start failed (restart=${restartMessage}; start=${startMessage})`,
      );
      return;
    }
  }
  details.restarted = true;

  const openclawTarget = resolveTarget(config.openclawUpstream);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const probe = await checkTcpConnectivity({ ...openclawTarget, timeoutMs: 700 });
    if (probe.ok) {
      details.upstreamReady = true;
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ success: true, service: "clawnow-proxy", repaired: true, details }));
}

function shouldUseRoute(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function maybeStripPrefix(pathname, prefix, shouldStrip) {
  if (!shouldStrip) {
    return pathname;
  }
  if (pathname === prefix) {
    return "/";
  }
  if (pathname.startsWith(`${prefix}/`)) {
    const stripped = pathname.slice(prefix.length);
    return stripped.startsWith("/") ? stripped : `/${stripped}`;
  }
  return pathname;
}

function buildTargetPath(route, requestUrl) {
  const url = new URL(requestUrl, "http://clawnow.local");
  const tokenInQuery = url.searchParams.get("token");
  if (tokenInQuery) {
    url.searchParams.delete("token");
  }
  url.searchParams.delete("mode");

  const rewrittenPathname = maybeStripPrefix(url.pathname, route.prefix, route.stripPrefix);
  url.pathname = rewrittenPathname;

  if (
    url.searchParams.get("instanceId") &&
    url.searchParams.get("instanceId") !== route.claims.instanceId
  ) {
    throw new Error("instance_mismatch");
  }

  const expectedSessionTypes = normalizeExpectedSessionTypes(route.expectedSessionType);
  if (
    expectedSessionTypes.length > 0 &&
    !expectedSessionTypes.includes(route.claims.sessionType)
  ) {
    throw new Error("session_type_mismatch");
  }

  return `${url.pathname}${url.search}`;
}

function createProxyConfig() {
  loadDotEnv(path.resolve(process.cwd(), ".env"));

  const sharedSecret = process.env.CLAWNOW_PROXY_SHARED_SECRET?.trim();
  if (!sharedSecret) {
    throw new Error("CLAWNOW_PROXY_SHARED_SECRET is required");
  }

  return {
    bind: process.env.CLAWNOW_PROXY_BIND?.trim() || "127.0.0.1",
    port: parsePort(process.env.CLAWNOW_PROXY_PORT, 18790),
    sharedSecret,
    tokenClockSkewSeconds: parsePositiveInt(process.env.CLAWNOW_PROXY_TOKEN_CLOCK_SKEW_SECONDS, 120),
    expectedIss: process.env.CLAWNOW_PROXY_EXPECTED_ISS?.trim() || "clawnow-control-plane",
    expectedAud: process.env.CLAWNOW_PROXY_EXPECTED_AUD?.trim() || "openclaw-gateway",
    instanceId: process.env.CLAWNOW_INSTANCE_ID?.trim() || "local",
    controlPrefix: normalizePrefix(process.env.CLAWNOW_PROXY_CONTROL_PREFIX, "/clawnow"),
    novncPrefix: normalizePrefix(process.env.CLAWNOW_PROXY_NOVNC_PREFIX, "/novnc"),
    localGatewayPrefix: normalizePrefix(
      process.env.CLAWNOW_PROXY_LOCAL_GATEWAY_PREFIX,
      "/__clawnow/local-gateway",
    ),
    healthPath: normalizePrefix(process.env.CLAWNOW_PROXY_HEALTH_PATH, "/__clawnow/health"),
    bootstrapPath: normalizePrefix(
      process.env.CLAWNOW_PROXY_BOOTSTRAP_PATH,
      "/__clawnow/bootstrap",
    ),
    repairPrefix: normalizePrefix(process.env.CLAWNOW_PROXY_REPAIR_PREFIX, "/__clawnow/repair"),
    bootstrapStateFile:
      process.env.CLAWNOW_BOOTSTRAP_STATE_FILE?.trim() || "/var/lib/clawnow/bootstrap-state.json",
    stripControlPrefix: parseBoolean(process.env.CLAWNOW_PROXY_STRIP_CONTROL_PREFIX, false),
    stripNoVncPrefix: parseBoolean(process.env.CLAWNOW_PROXY_STRIP_NOVNC_PREFIX, true),
    openclawUpstream: parseUpstream("CLAWNOW_OPENCLAW_UPSTREAM", "http://127.0.0.1:18789"),
    openclawLocalAddress: parseLoopbackLocalAddress(
      process.env.CLAWNOW_OPENCLAW_LOCAL_ADDRESS,
      "127.0.0.2",
    ),
    openclawService: process.env.CLAWNOW_OPENCLAW_SERVICE?.trim() || "openclaw-gateway.service",
    novncUpstream: parseUpstream("CLAWNOW_NOVNC_UPSTREAM", "http://127.0.0.1:6080"),
  };
}

function resolveRoute(config, pathname) {
  if (pathname === config.healthPath) {
    return { kind: "health" };
  }
  if (pathname === config.bootstrapPath) {
    return { kind: "bootstrap" };
  }
  if (shouldUseRoute(pathname, config.repairPrefix)) {
    return { kind: "repair", prefix: config.repairPrefix };
  }
  if (shouldUseRoute(pathname, config.novncPrefix)) {
    if (!config.novncUpstream) {
      return { kind: "missing-novnc" };
    }
    return {
      kind: "proxy",
      prefix: config.novncPrefix,
      stripPrefix: config.stripNoVncPrefix,
      // Allow gateway control-ui sessions to open noVNC directly from the dashboard.
      expectedSessionType: ["novnc", "control_ui"],
      upstream: config.novncUpstream,
    };
  }
  if (shouldUseRoute(pathname, config.localGatewayPrefix)) {
    return {
      kind: "proxy",
      prefix: config.localGatewayPrefix,
      stripPrefix: true,
      expectedSessionType: "control_ui",
      upstream: config.openclawUpstream,
      localAddress: config.openclawLocalAddress,
      // Internal local route for VM-side CLI/agent tools.
      // Must be direct loopback (no forwarded headers).
      requireDirectLoopback: true,
    };
  }
  if (shouldUseRoute(pathname, config.controlPrefix)) {
    return {
      kind: "proxy",
      prefix: config.controlPrefix,
      stripPrefix: config.stripControlPrefix,
      expectedSessionType: "control_ui",
      upstream: config.openclawUpstream,
      localAddress: config.openclawLocalAddress,
    };
  }
  return { kind: "unknown" };
}

function resolveUpgradeRoute(config, pathname) {
  const route = resolveRoute(config, pathname);
  if (route.kind !== "unknown") {
    return route;
  }
  // Control UI defaults to ws(s)://host/ when no explicit gatewayUrl path is set.
  // Allow root websocket upgrades for control_ui sessions so proxy mode works
  // with stock OpenClaw UI behavior.
  if (pathname === "/" || pathname === "") {
    return {
      kind: "proxy",
      prefix: "/",
      stripPrefix: false,
      expectedSessionType: "control_ui",
      upstream: config.openclawUpstream,
      localAddress: config.openclawLocalAddress,
    };
  }
  return route;
}

function proxyHttpRequest(req, res, route) {
  const targetPath = buildTargetPath(route, req.url || "/");
  const headers = buildForwardHeaders(req, route.upstream, route.claims);
  const isHttps = route.upstream.protocol === "https:";
  const requestImpl = isHttps ? https.request : http.request;

  const upstreamReq = requestImpl(
    {
      protocol: route.upstream.protocol,
      hostname: route.upstream.hostname,
      port: route.upstream.port || (isHttps ? 443 : 80),
      method: req.method,
      path: targetPath,
      headers,
      ...(route.localAddress ? { localAddress: route.localAddress } : {}),
    },
    (upstreamRes) => {
      const statusCode = upstreamRes.statusCode || 502;
      const responseHeaders = sanitizeResponseHeaders(upstreamRes.headers);
      if (route.setCookie) {
        const existingSetCookie = responseHeaders["set-cookie"];
        if (existingSetCookie === undefined) {
          responseHeaders["set-cookie"] = route.setCookie;
        } else if (Array.isArray(existingSetCookie)) {
          responseHeaders["set-cookie"] = [...existingSetCookie, route.setCookie];
        } else {
          responseHeaders["set-cookie"] = [existingSetCookie, route.setCookie];
        }
      }
      res.writeHead(statusCode, responseHeaders);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on("error", (error) => {
    writeHttpError(
      res,
      502,
      "upstream_error",
      `Proxy upstream request failed: ${String(error.message || error)}`,
    );
  });

  req.pipe(upstreamReq);
}

function proxyUpgradeRequest(req, socket, head, route) {
  let targetPath;
  try {
    targetPath = buildTargetPath(route, req.url || "/");
  } catch (error) {
    writeUpgradeError(socket, 401, `Token validation failed: ${String(error.message || error)}`);
    return;
  }

  const headers = buildForwardHeaders(req, route.upstream, route.claims);
  headers.Connection = "Upgrade";
  headers.Upgrade = req.headers.upgrade || "websocket";

  const isTls = route.upstream.protocol === "https:";
  const upstreamSocket = isTls
    ? tls.connect({
        port: Number(route.upstream.port || 443),
        host: route.upstream.hostname,
        servername: route.upstream.hostname,
        ...(route.localAddress ? { localAddress: route.localAddress } : {}),
      })
    : net.connect({
        port: Number(route.upstream.port || 80),
        host: route.upstream.hostname,
        ...(route.localAddress ? { localAddress: route.localAddress } : {}),
      });

  const cleanup = () => {
    if (!socket.destroyed) {
      socket.destroy();
    }
    if (!upstreamSocket.destroyed) {
      upstreamSocket.destroy();
    }
  };

  upstreamSocket.once("error", () => {
    writeUpgradeError(socket, 502, "Upstream websocket connection failed");
  });

  socket.once("error", cleanup);

  const connectEvent = isTls ? "secureConnect" : "connect";
  upstreamSocket.once(connectEvent, () => {
    const hostHeaderValue = (() => {
      const hostHeader = headers.Host;
      if (Array.isArray(hostHeader) && hostHeader.length > 0) {
        return String(hostHeader[0]);
      }
      if (typeof hostHeader === "string" && hostHeader.trim().length > 0) {
        return hostHeader;
      }
      return route.upstream.host;
    })();
    const lines = [`GET ${targetPath} HTTP/1.1`, `Host: ${hostHeaderValue}`];
    for (const [key, value] of Object.entries(headers)) {
      if (value == null) {
        continue;
      }
      if (key.toLowerCase() === "host") {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          lines.push(`${key}: ${item}`);
        }
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    lines.push("", "");

    upstreamSocket.write(lines.join("\r\n"));
    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }

    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
  });
}

function parseAndValidateToken(req, config, expectedSessionType) {
  const requestUrl = new URL(req.url || "/", "http://clawnow.local");
  const queryToken = requestUrl.searchParams.get("token");
  const bearerToken = getBearerToken(req.headers.authorization);
  const cookieToken = getCookieToken(req, expectedSessionType);
  const token = queryToken || bearerToken || cookieToken;
  if (!token) {
    throw new Error("missing_token");
  }
  const claims = verifySignedToken(token, config);
  return {
    claims: { ...claims, token },
    source: queryToken ? "query" : bearerToken ? "bearer" : "cookie",
  };
}

function buildLoopbackClaims(config) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    sub: "loopback@local",
    iss: config.expectedIss,
    aud: config.expectedAud,
    exp: nowSeconds + 3600,
    iat: nowSeconds,
    instanceId: config.instanceId || "local",
    sessionType: "control_ui",
    token: "__loopback__",
  };
}

function resolveRouteAuth(req, config, route) {
  if (route.requireDirectLoopback === true) {
    if (!isDirectLoopbackClient(req)) {
      throw new Error("loopback_only");
    }
    return { claims: buildLoopbackClaims(config), source: "loopback" };
  }
  return parseAndValidateToken(req, config, route.expectedSessionType);
}

function createServer(config) {
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || "/", "http://clawnow.local");
    const route = resolveRoute(config, requestUrl.pathname);

    if (route.kind === "health") {
      void writeHealthResponse(res, config);
      return;
    }

    if (route.kind === "bootstrap") {
      writeBootstrapResponse(res, config);
      return;
    }

    if (route.kind === "repair") {
      try {
        parseAndValidateToken(req, config, "control_ui");
      } catch (error) {
        writeHttpError(
          res,
          401,
          "unauthorized",
          `Token validation failed: ${String(error.message || error)}`,
        );
        return;
      }

      const suffix = requestUrl.pathname.slice(route.prefix.length) || "/";
      if (suffix === "/gateway" || suffix === "/gateway/" || suffix === "/") {
        void handleGatewayRepair(req, res, config);
        return;
      }
      writeHttpError(res, 404, "route_not_found", "Unknown ClawNow repair route");
      return;
    }

    if (route.kind === "missing-novnc") {
      writeHttpError(res, 503, "novnc_unavailable", "CLAWNOW_NOVNC_UPSTREAM is not configured");
      return;
    }

    if (route.kind === "unknown") {
      writeHttpError(res, 404, "route_not_found", "Unknown ClawNow proxy route");
      return;
    }

    try {
      const auth = resolveRouteAuth(req, config, route);
      const setCookie =
        auth.source === "cookie" || auth.source === "loopback"
          ? null
          : buildSessionCookie(auth.claims, route.prefix);
      proxyHttpRequest(req, res, { ...route, claims: auth.claims, config, setCookie });
    } catch (error) {
      writeHttpError(
        res,
        401,
        "unauthorized",
        `Token validation failed: ${String(error.message || error)}`,
      );
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const requestUrl = new URL(req.url || "/", "http://clawnow.local");
    const route = resolveUpgradeRoute(config, requestUrl.pathname);
    if (route.kind !== "proxy") {
      writeUpgradeError(socket, 404, "Unknown ClawNow proxy route");
      return;
    }
    try {
      const auth = resolveRouteAuth(req, config, route);
      proxyUpgradeRequest(req, socket, head, { ...route, claims: auth.claims, config });
    } catch (error) {
      writeUpgradeError(socket, 401, `Token validation failed: ${String(error.message || error)}`);
    }
  });

  return server;
}

function main() {
  const config = createProxyConfig();
  const server = createServer(config);
  server.listen(config.port, config.bind, () => {
    const novncTarget = config.novncUpstream ? config.novncUpstream.toString() : "(disabled)";
    console.log(
      `[clawnow-proxy] listening on http://${config.bind}:${config.port}\n` +
        `  control: ${config.controlPrefix} -> ${config.openclawUpstream.toString()}\n` +
        `  local:   ${config.localGatewayPrefix} (loopback-only) -> ${config.openclawUpstream.toString()}\n` +
        `  novnc:   ${config.novncPrefix} -> ${novncTarget}`,
    );
  });
}

main();
