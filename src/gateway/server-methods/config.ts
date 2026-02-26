import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import {
  CONFIG_PATH,
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import { applyLegacyMigrations } from "../../config/legacy.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import {
  redactConfigObject,
  redactConfigSnapshot,
  restoreRedactedValues,
} from "../../config/redact-snapshot.js";
import { buildConfigSchema, type ConfigSchemaResponse } from "../../config/schema.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { diffConfigPaths } from "../config-reload.js";
import {
  formatControlPlaneActor,
  resolveControlPlaneActor,
  summarizeChangedPaths,
} from "../control-plane-audit.js";
import {
  enforceManagedTrustedProxyGatewayConfig,
  isManagedTrustedProxyEnabled,
} from "../managed-trusted-proxy.js";
import {
  ErrorCodes,
  errorShape,
  validateConfigApplyParams,
  validateConfigGetParams,
  validateConfigPatchParams,
  validateConfigSchemaParams,
  validateConfigSetParams,
} from "../protocol/index.js";
import { resolveBaseHashParam } from "./base-hash.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const MANAGED_TRUSTED_PROXY_LOCK_CODE = "MANAGED_GATEWAY_LOCKED";
const MANAGED_TRUSTED_PROXY_LOCK_MESSAGE =
  "gateway auth mode is managed by platform and locked to trusted-proxy";

function requireConfigBaseHash(
  params: unknown,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  respond: RespondFn,
): boolean {
  if (!snapshot.exists) {
    return true;
  }
  const snapshotHash = resolveConfigSnapshotHash(snapshot);
  if (!snapshotHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config base hash unavailable; re-run config.get and retry",
      ),
    );
    return false;
  }
  const baseHash = resolveBaseHashParam(params);
  if (!baseHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config base hash required; re-run config.get and retry",
      ),
    );
    return false;
  }
  if (baseHash !== snapshotHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config changed since last load; re-run config.get and retry",
      ),
    );
    return false;
  }
  return true;
}

function parseRawConfigOrRespond(
  params: unknown,
  requestName: string,
  respond: RespondFn,
): string | null {
  const rawValue = (params as { raw?: unknown }).raw;
  if (typeof rawValue !== "string") {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid ${requestName} params: raw (string) required`,
      ),
    );
    return null;
  }
  return rawValue;
}

function parseValidateConfigFromRawOrRespond(
  params: unknown,
  requestName: string,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  respond: RespondFn,
): { config: OpenClawConfig; schema: ConfigSchemaResponse } | null {
  const rawValue = parseRawConfigOrRespond(params, requestName, respond);
  if (!rawValue) {
    return null;
  }
  const parsedRes = parseConfigJson5(rawValue);
  if (!parsedRes.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
    return null;
  }
  const schema = loadSchemaWithPlugins();
  const restored = restoreRedactedValues(parsedRes.parsed, snapshot.config, schema.uiHints);
  if (!restored.ok) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, restored.humanReadableMessage ?? "invalid config"),
    );
    return null;
  }
  const validated = validateConfigObjectWithPlugins(restored.result);
  if (!validated.ok) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "invalid config", {
        details: { issues: validated.issues },
      }),
    );
    return null;
  }
  return { config: validated.config, schema };
}

function resolveConfigRestartRequest(params: unknown): {
  sessionKey: string | undefined;
  note: string | undefined;
  restartDelayMs: number | undefined;
  deliveryContext: ReturnType<typeof extractDeliveryInfo>["deliveryContext"];
  threadId: ReturnType<typeof extractDeliveryInfo>["threadId"];
} {
  const { sessionKey, note, restartDelayMs } = parseRestartRequestParams(params);

  // Extract deliveryContext + threadId for routing after restart
  // Supports both :thread: (most channels) and :topic: (Telegram)
  const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);

  return {
    sessionKey,
    note,
    restartDelayMs,
    deliveryContext,
    threadId,
  };
}

function buildConfigRestartSentinelPayload(params: {
  kind: RestartSentinelPayload["kind"];
  mode: string;
  sessionKey: string | undefined;
  deliveryContext: ReturnType<typeof extractDeliveryInfo>["deliveryContext"];
  threadId: ReturnType<typeof extractDeliveryInfo>["threadId"];
  note: string | undefined;
}): RestartSentinelPayload {
  return {
    kind: params.kind,
    status: "ok",
    ts: Date.now(),
    sessionKey: params.sessionKey,
    deliveryContext: params.deliveryContext,
    threadId: params.threadId,
    message: params.note ?? null,
    doctorHint: formatDoctorNonInteractiveHint(),
    stats: {
      mode: params.mode,
      root: CONFIG_PATH,
    },
  };
}

async function tryWriteRestartSentinelPayload(
  payload: RestartSentinelPayload,
): Promise<string | null> {
  try {
    return await writeRestartSentinel(payload);
  } catch {
    return null;
  }
}

function loadSchemaWithPlugins(): ConfigSchemaResponse {
  const cfg = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const pluginRegistry = loadOpenClawPlugins({
    config: cfg,
    cache: true,
    workspaceDir,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  });
  // Note: We can't easily cache this, as there are no callback that can invalidate
  // our cache. However, both loadConfig() and loadOpenClawPlugins() already cache
  // their results, and buildConfigSchema() is just a cheap transformation.
  return buildConfigSchema({
    plugins: pluginRegistry.plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      configUiHints: plugin.configUiHints,
      configSchema: plugin.configJsonSchema,
    })),
    channels: listChannelPlugins().map((entry) => ({
      id: entry.id,
      label: entry.meta.label,
      description: entry.meta.blurb,
      configSchema: entry.configSchema?.schema,
      configUiHints: entry.configSchema?.uiHints,
    })),
  });
}

function preserveTrustedProxyGatewayDefaults(
  incomingConfig: OpenClawConfig,
  snapshotConfig: OpenClawConfig,
): OpenClawConfig {
  const snapshotGateway = snapshotConfig.gateway;
  const managed = isManagedTrustedProxyEnabled(process.env);
  const shouldPreserve = snapshotGateway?.auth?.mode === "trusted-proxy";
  if (!managed && !shouldPreserve) {
    return incomingConfig;
  }

  const nextConfig = structuredClone(incomingConfig);
  nextConfig.gateway = nextConfig.gateway || {};

  if (snapshotGateway) {
    nextConfig.gateway.mode ??= snapshotGateway.mode;
    nextConfig.gateway.trustedProxies ??= snapshotGateway.trustedProxies;
  }

  const nextGatewayAuth = nextConfig.gateway.auth;
  const preserveTrustedProxyAuth =
    nextGatewayAuth?.mode === undefined || nextGatewayAuth.mode === "trusted-proxy";
  if (preserveTrustedProxyAuth) {
    nextConfig.gateway.auth = nextConfig.gateway.auth || {};
    nextConfig.gateway.auth.mode ??= snapshotGateway?.auth?.mode;
    if (snapshotGateway?.auth?.trustedProxy) {
      const incomingTrustedProxy = nextConfig.gateway.auth.trustedProxy;
      const snapshotTrustedProxy = snapshotGateway.auth.trustedProxy;
      nextConfig.gateway.auth.trustedProxy = incomingTrustedProxy
        ? {
            userHeader: incomingTrustedProxy.userHeader ?? snapshotTrustedProxy.userHeader,
            requiredHeaders:
              incomingTrustedProxy.requiredHeaders ?? snapshotTrustedProxy.requiredHeaders,
            allowUsers: incomingTrustedProxy.allowUsers ?? snapshotTrustedProxy.allowUsers,
          }
        : { ...snapshotTrustedProxy };
    }
  }

  if (snapshotGateway?.controlUi) {
    nextConfig.gateway.controlUi = nextConfig.gateway.controlUi || {};
    nextConfig.gateway.controlUi.basePath ??= snapshotGateway.controlUi.basePath;
    nextConfig.gateway.controlUi.root ??= snapshotGateway.controlUi.root;
    nextConfig.gateway.controlUi.allowedOrigins ??= snapshotGateway.controlUi.allowedOrigins;
    if (nextConfig.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback === undefined) {
      nextConfig.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback =
        snapshotGateway.controlUi.dangerouslyAllowHostHeaderOriginFallback;
    }
    if (nextConfig.gateway.controlUi.dangerouslyDisableDeviceAuth === undefined) {
      nextConfig.gateway.controlUi.dangerouslyDisableDeviceAuth =
        snapshotGateway.controlUi.dangerouslyDisableDeviceAuth;
    }
  }

  return managed ? enforceManagedTrustedProxyGatewayConfig(nextConfig) : nextConfig;
}

function isManagedTrustedProxyLockEnabled(snapshotConfig: OpenClawConfig): boolean {
  void snapshotConfig;
  return isManagedTrustedProxyEnabled(process.env);
}

function resolveIncomingGatewayAuthMode(config: OpenClawConfig): string | undefined {
  return config.gateway?.auth?.mode;
}

function respondManagedTrustedProxyLockError(respond: RespondFn) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, MANAGED_TRUSTED_PROXY_LOCK_MESSAGE, {
      details: {
        code: MANAGED_TRUSTED_PROXY_LOCK_CODE,
        requiredMode: "trusted-proxy",
      },
    }),
  );
}

function rejectIfManagedTrustedProxyViolation(params: {
  incomingConfig: OpenClawConfig;
  snapshotConfig: OpenClawConfig;
  respond: RespondFn;
}): boolean {
  if (!isManagedTrustedProxyLockEnabled(params.snapshotConfig)) {
    return false;
  }
  const incomingMode = resolveIncomingGatewayAuthMode(params.incomingConfig);
  if (incomingMode === undefined || incomingMode === "trusted-proxy") {
    return false;
  }
  respondManagedTrustedProxyLockError(params.respond);
  return true;
}

export const configHandlers: GatewayRequestHandlers = {
  "config.get": async ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigGetParams, "config.get", respond)) {
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    const schema = loadSchemaWithPlugins();
    respond(true, redactConfigSnapshot(snapshot, schema.uiHints), undefined);
  },
  "config.schema": ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigSchemaParams, "config.schema", respond)) {
      return;
    }
    respond(true, loadSchemaWithPlugins(), undefined);
  },
  "config.set": async ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigSetParams, "config.set", respond)) {
      return;
    }
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    if (!requireConfigBaseHash(params, snapshot, respond)) {
      return;
    }
    const parsed = parseValidateConfigFromRawOrRespond(params, "config.set", snapshot, respond);
    if (!parsed) {
      return;
    }
    if (
      snapshot.valid &&
      rejectIfManagedTrustedProxyViolation({
        incomingConfig: parsed.config,
        snapshotConfig: snapshot.config,
        respond,
      })
    ) {
      return;
    }
    const protectedConfig = snapshot.valid
      ? preserveTrustedProxyGatewayDefaults(parsed.config, snapshot.config)
      : isManagedTrustedProxyEnabled(process.env)
        ? enforceManagedTrustedProxyGatewayConfig(parsed.config)
        : parsed.config;
    const validatedProtectedConfig = validateConfigObjectWithPlugins(protectedConfig);
    if (!validatedProtectedConfig.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config", {
          details: { issues: validatedProtectedConfig.issues },
        }),
      );
      return;
    }
    await writeConfigFile(validatedProtectedConfig.config, writeOptions);
    respond(
      true,
      {
        ok: true,
        path: CONFIG_PATH,
        config: redactConfigObject(validatedProtectedConfig.config, parsed.schema.uiHints),
      },
      undefined,
    );
  },
  "config.patch": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigPatchParams, "config.patch", respond)) {
      return;
    }
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    if (!requireConfigBaseHash(params, snapshot, respond)) {
      return;
    }
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before patching"),
      );
      return;
    }
    const rawValue = (params as { raw?: unknown }).raw;
    if (typeof rawValue !== "string") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid config.patch params: raw (string) required",
        ),
      );
      return;
    }
    const parsedRes = parseConfigJson5(rawValue);
    if (!parsedRes.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
      return;
    }
    if (
      !parsedRes.parsed ||
      typeof parsedRes.parsed !== "object" ||
      Array.isArray(parsedRes.parsed)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config.patch raw must be an object"),
      );
      return;
    }
    const merged = applyMergePatch(snapshot.config, parsedRes.parsed, {
      mergeObjectArraysById: true,
    });
    const schemaPatch = loadSchemaWithPlugins();
    const restoredMerge = restoreRedactedValues(merged, snapshot.config, schemaPatch.uiHints);
    if (!restoredMerge.ok) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          restoredMerge.humanReadableMessage ?? "invalid config",
        ),
      );
      return;
    }
    const migrated = applyLegacyMigrations(restoredMerge.result);
    const resolved = migrated.next ?? restoredMerge.result;
    const validated = validateConfigObjectWithPlugins(resolved);
    if (!validated.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config", {
          details: { issues: validated.issues },
        }),
      );
      return;
    }
    if (
      rejectIfManagedTrustedProxyViolation({
        incomingConfig: validated.config,
        snapshotConfig: snapshot.config,
        respond,
      })
    ) {
      return;
    }
    const protectedConfig = preserveTrustedProxyGatewayDefaults(validated.config, snapshot.config);
    const changedPaths = diffConfigPaths(snapshot.config, protectedConfig);
    const actor = resolveControlPlaneActor(client);
    context?.logGateway?.info(
      `config.patch write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.patch`,
    );
    await writeConfigFile(protectedConfig, writeOptions);

    const { sessionKey, note, restartDelayMs, deliveryContext, threadId } =
      resolveConfigRestartRequest(params);
    const payload = buildConfigRestartSentinelPayload({
      kind: "config-patch",
      mode: "config.patch",
      sessionKey,
      deliveryContext,
      threadId,
      note,
    });
    const sentinelPath = await tryWriteRestartSentinelPayload(payload);
    const restart = scheduleGatewaySigusr1Restart({
      delayMs: restartDelayMs,
      reason: "config.patch",
      audit: {
        actor: actor.actor,
        deviceId: actor.deviceId,
        clientIp: actor.clientIp,
        changedPaths,
      },
    });
    if (restart.coalesced) {
      context?.logGateway?.warn(
        `config.patch restart coalesced ${formatControlPlaneActor(actor)} delayMs=${restart.delayMs}`,
      );
    }
    respond(
      true,
      {
        ok: true,
        path: CONFIG_PATH,
        config: redactConfigObject(protectedConfig, schemaPatch.uiHints),
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },
  "config.apply": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigApplyParams, "config.apply", respond)) {
      return;
    }
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    if (!requireConfigBaseHash(params, snapshot, respond)) {
      return;
    }
    const parsed = parseValidateConfigFromRawOrRespond(params, "config.apply", snapshot, respond);
    if (!parsed) {
      return;
    }
    if (
      snapshot.valid &&
      rejectIfManagedTrustedProxyViolation({
        incomingConfig: parsed.config,
        snapshotConfig: snapshot.config,
        respond,
      })
    ) {
      return;
    }
    const protectedConfig = snapshot.valid
      ? preserveTrustedProxyGatewayDefaults(parsed.config, snapshot.config)
      : isManagedTrustedProxyEnabled(process.env)
        ? enforceManagedTrustedProxyGatewayConfig(parsed.config)
        : parsed.config;
    const changedPaths = diffConfigPaths(snapshot.valid ? snapshot.config : {}, protectedConfig);
    const actor = resolveControlPlaneActor(client);
    context?.logGateway?.info(
      `config.apply write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.apply`,
    );
    await writeConfigFile(protectedConfig, writeOptions);

    const { sessionKey, note, restartDelayMs, deliveryContext, threadId } =
      resolveConfigRestartRequest(params);
    const payload = buildConfigRestartSentinelPayload({
      kind: "config-apply",
      mode: "config.apply",
      sessionKey,
      deliveryContext,
      threadId,
      note,
    });
    const sentinelPath = await tryWriteRestartSentinelPayload(payload);
    const restart = scheduleGatewaySigusr1Restart({
      delayMs: restartDelayMs,
      reason: "config.apply",
      audit: {
        actor: actor.actor,
        deviceId: actor.deviceId,
        clientIp: actor.clientIp,
        changedPaths,
      },
    });
    if (restart.coalesced) {
      context?.logGateway?.warn(
        `config.apply restart coalesced ${formatControlPlaneActor(actor)} delayMs=${restart.delayMs}`,
      );
    }
    respond(
      true,
      {
        ok: true,
        path: CONFIG_PATH,
        config: redactConfigObject(protectedConfig, parsed.schema.uiHints),
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },
};
