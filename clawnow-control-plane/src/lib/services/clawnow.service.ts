import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signPayload,
} from "crypto";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/server-auth";
import {
  ClawNowHetznerService,
  HetznerApiError,
  type HetznerServer,
} from "@/lib/services/clawnow-hetzner.service";
import { codexOAuthSessionService } from "@/lib/services/codex-oauth-session.service";

export type ClawInstanceStatus =
  | "provisioning"
  | "running"
  | "recovering"
  | "stopped"
  | "error"
  | "deleting"
  | "terminated";

export type ClawSessionType = "control_ui" | "novnc";

export interface ClawInstance {
  id: string;
  user_id: string;
  provider: "hetzner";
  region: string;
  server_type: string;
  image: string;
  server_name: string;
  hetzner_server_id: number | null;
  status: ClawInstanceStatus;
  ipv4: string | null;
  ipv6: string | null;
  gateway_url: string | null;
  control_ui_url: string | null;
  novnc_url: string | null;
  provisioning_started_at: string;
  provisioned_at: string | null;
  last_heartbeat_at: string | null;
  novnc_enabled_until: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ClawNowRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  controlUiOrigin?: string | null;
}

export interface ClawInstanceHealth {
  instance: ClawInstance | null;
  providerStatus: string | null;
  checkedAt: string;
  error?: string;
}

export type OnboardingWizardStatus = "running" | "done" | "cancelled" | "error";

export interface OnboardingWizardStepOption {
  value: unknown;
  label: string;
  hint?: string;
}

export interface OnboardingWizardStep {
  id: string;
  type: "note" | "select" | "text" | "confirm" | "multiselect" | "progress" | "action";
  title?: string;
  message?: string;
  options?: OnboardingWizardStepOption[];
  initialValue?: unknown;
  placeholder?: string;
  sensitive?: boolean;
  executor?: "gateway" | "client";
}

export interface OnboardingWizardResult {
  done: boolean;
  step?: OnboardingWizardStep;
  status?: OnboardingWizardStatus;
  error?: string;
}

export interface OnboardingWizardStatusResult {
  status: OnboardingWizardStatus;
  error?: string;
}

type ClawNowWizardAuthMethod = "openai_api_key" | "openai_codex_oauth";

const CLAWNOW_WIZARD_STEP_AUTH_METHOD = "clawnow.setup.auth_method";
const CLAWNOW_WIZARD_STEP_OPENAI_API_KEY = "clawnow.setup.openai_api_key";
const CLAWNOW_WIZARD_STEP_CODEX_CALLBACK_URL = "clawnow.setup.codex_callback_url";

export class ClawNowServiceError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ClawNowServiceError";
    this.code = code;
    this.status = status;
  }
}

interface ClawNowConfig {
  hetznerApiToken: string;
  hetznerLocation: string;
  hetznerServerType: string;
  hetznerImage: string;
  hetznerSshKeys: Array<number | string>;
  bootstrapAssetBaseUrl: string | null;
  controlUiManifestUrl: string | null;
  vmNamePrefix: string;
  gatewayBaseUrl: string | null;
  controlUiBaseUrl: string | null;
  novncBaseUrl: string | null;
  instanceGatewayTemplate: string;
  controlUiPath: string;
  novncPath: string;
  controlUiAllowedOrigin: string | null;
  proxySharedSecret: string;
  controlSessionTtlSeconds: number;
  novncSessionTtlMinutes: number;
  provisioningTimeoutSeconds: number;
  defaultCloudInit: string;
  openClawBootstrapCommand: string;
}

interface GatewayDeviceIdentity {
  deviceId: string;
  publicKeyBase64Url: string;
  privateKeyPem: string;
}

const DEFAULT_PROVISIONING_TIMEOUT_SECONDS = 15 * 60;
const CONTROL_UI_PROBE_TIMEOUT_MS = 6000;
const GATEWAY_HEALTH_TIMEOUT_MS = 8000;
const GATEWAY_WS_TIMEOUT_MS = 12000;
const GATEWAY_CONFIG_PATCH_MAX_ATTEMPTS = 3;
const GATEWAY_CONFIG_PATCH_RETRY_DELAY_MS = 400;
const GATEWAY_HEALTH_PATH = "__clawnow/health";
const GATEWAY_REPAIR_PATH = "__clawnow/repair/gateway";
const LEGACY_HTTP_GATEWAY_REASON = "legacy_http_gateway_detected";
const CLAWNOW_CLOUD_INIT_MAX_BYTES = 16000;
const DEFAULT_BOOTSTRAP_SCRIPT_URL =
  "https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/clawnow-vm-bootstrap.sh";
const DEFAULT_PROXY_SCRIPT_URL =
  "https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/clawnow-proxy.mjs";
const DEFAULT_CONTROL_UI_UPDATER_SCRIPT_URL =
  "https://raw.githubusercontent.com/openclaw/openclaw/main/clawnow-control-plane/scripts/clawnow-control-ui-updater.sh";
const LOCAL_BOOTSTRAP_SCRIPT_PATH = "api/clawnow/bootstrap/vm";
const LOCAL_PROXY_SCRIPT_PATH = "api/clawnow/bootstrap/proxy";
const LOCAL_CONTROL_UI_UPDATER_SCRIPT_PATH = "api/clawnow/bootstrap/control-ui-updater";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
};

type GatewayRequestSender = (method: string, params?: unknown) => Promise<unknown>;

interface GatewayRequestOptions {
  timeoutMs?: number;
  /**
   * When true, skip VM-side "gateway repair" attempts.
   *
   * Repair currently uses `systemctl restart`, which wipes the Gateway's in-memory wizard session.
   * For onboarding (`wizard.next`) we prefer retry + surface the underlying connectivity error
   * rather than silently restarting the gateway mid-wizard.
   */
  disableRepair?: boolean;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ClawNowServiceError(
      "CONFIG_MISSING",
      `Missing required environment variable: ${name}`,
      503,
    );
  }
  return value;
}

function getOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

function getNumberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

function getListEnv(name: string): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeHetznerSshKeyRef(value: string): number | string {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

function resolveBootstrapAssetBaseUrl(): string | null {
  const explicit = getOptionalEnv("CLAWNOW_BOOTSTRAP_ASSET_BASE_URL");
  if (explicit) {
    return ensureAbsoluteUrl("CLAWNOW_BOOTSTRAP_ASSET_BASE_URL", explicit);
  }

  const appUrl = getOptionalEnv("NEXT_PUBLIC_APP_URL");
  if (appUrl) {
    return ensureAbsoluteUrl("NEXT_PUBLIC_APP_URL", appUrl);
  }

  const siteUrl = getOptionalEnv("NEXT_PUBLIC_SITE_URL");
  if (siteUrl) {
    return ensureAbsoluteUrl("NEXT_PUBLIC_SITE_URL", siteUrl);
  }

  const railwayPublicDomain =
    getOptionalEnv("RAILWAY_PUBLIC_DOMAIN") || getOptionalEnv("RAILWAY_STATIC_URL");
  if (railwayPublicDomain) {
    const normalized = railwayPublicDomain.replace(/^https?:\/\//, "");
    return ensureAbsoluteUrl("RAILWAY_PUBLIC_DOMAIN", `https://${normalized}`);
  }

  return null;
}

function resolveControlUiAllowedOrigin(): string | null {
  const explicit = getOptionalEnv("CLAWNOW_CONTROL_UI_ALLOWED_ORIGIN");
  if (explicit) {
    return ensureAbsoluteUrl("CLAWNOW_CONTROL_UI_ALLOWED_ORIGIN", explicit);
  }
  return null;
}

function ensureAbsoluteUrl(name: string, value: string): string {
  try {
    const parsed = new URL(value);
    if (!parsed.protocol.startsWith("http")) {
      throw new Error("Only http/https URLs are supported");
    }
    return parsed.toString();
  } catch {
    throw new ClawNowServiceError(
      "CONFIG_INVALID",
      `Environment variable ${name} must be an absolute URL`,
      503,
    );
  }
}

function joinUrl(base: string, path: string): string {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  return new URL(normalizedPath, normalizedBase).toString();
}

function normalizePathSegment(name: string, value: string | null, fallback: string): string {
  const raw = (value || fallback).trim();
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized.includes("?") || normalized.includes("#")) {
    throw new ClawNowServiceError(
      "CONFIG_INVALID",
      `Environment variable ${name} must be a clean path segment`,
      503,
    );
  }
  return normalized;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function escapeForSingleQuotedBash(value: string): string {
  return value.replace(/'/g, `'"'"'`);
}

function loadClawNowConfig(): ClawNowConfig {
  const gatewayBaseRaw = getOptionalEnv("CLAWNOW_GATEWAY_BASE_URL");
  const gatewayBase = gatewayBaseRaw
    ? ensureAbsoluteUrl("CLAWNOW_GATEWAY_BASE_URL", gatewayBaseRaw)
    : null;
  const controlUiBaseRaw = getOptionalEnv("CLAWNOW_CONTROL_UI_BASE_URL");
  const novncBaseRaw = getOptionalEnv("CLAWNOW_NOVNC_BASE_URL");

  const controlUiBase = controlUiBaseRaw
    ? ensureAbsoluteUrl("CLAWNOW_CONTROL_UI_BASE_URL", controlUiBaseRaw)
    : gatewayBase
      ? joinUrl(gatewayBase, "clawnow")
      : null;
  const novncBase = novncBaseRaw
    ? ensureAbsoluteUrl("CLAWNOW_NOVNC_BASE_URL", novncBaseRaw)
    : gatewayBase
      ? joinUrl(gatewayBase, "novnc")
      : null;
  const bootstrapAssetBaseUrl = resolveBootstrapAssetBaseUrl();
  const controlUiManifestRaw = getOptionalEnv("CLAWNOW_CONTROL_UI_MANIFEST_URL");
  const controlUiManifestUrl = controlUiManifestRaw
    ? ensureAbsoluteUrl("CLAWNOW_CONTROL_UI_MANIFEST_URL", controlUiManifestRaw)
    : null;

  const instanceGatewayTemplate =
    getOptionalEnv("CLAWNOW_INSTANCE_GATEWAY_TEMPLATE") || "https://{{IPV4}}.sslip.io";
  if (
    !instanceGatewayTemplate.includes("{{IPV4}}") &&
    !instanceGatewayTemplate.includes("{{INSTANCE_ID}}")
  ) {
    throw new ClawNowServiceError(
      "CONFIG_INVALID",
      "CLAWNOW_INSTANCE_GATEWAY_TEMPLATE must include {{IPV4}} or {{INSTANCE_ID}}",
      503,
    );
  }

  return {
    hetznerApiToken: getRequiredEnv("CLAWNOW_HETZNER_API_TOKEN"),
    hetznerLocation: getOptionalEnv("CLAWNOW_HETZNER_LOCATION") || "sin",
    hetznerServerType: getOptionalEnv("CLAWNOW_HETZNER_SERVER_TYPE") || "cpx31",
    hetznerImage: getOptionalEnv("CLAWNOW_HETZNER_IMAGE") || "ubuntu-22.04",
    hetznerSshKeys: getListEnv("CLAWNOW_HETZNER_SSH_KEYS").map(normalizeHetznerSshKeyRef),
    bootstrapAssetBaseUrl,
    controlUiManifestUrl,
    vmNamePrefix: (getOptionalEnv("CLAWNOW_VM_NAME_PREFIX") || "clawnow").toLowerCase(),
    gatewayBaseUrl: gatewayBase,
    controlUiBaseUrl: controlUiBase,
    novncBaseUrl: novncBase,
    instanceGatewayTemplate,
    controlUiPath: normalizePathSegment(
      "CLAWNOW_CONTROL_UI_PATH",
      getOptionalEnv("CLAWNOW_CONTROL_UI_PATH"),
      "clawnow",
    ),
    novncPath: normalizePathSegment(
      "CLAWNOW_NOVNC_PATH",
      getOptionalEnv("CLAWNOW_NOVNC_PATH"),
      "novnc",
    ),
    controlUiAllowedOrigin: resolveControlUiAllowedOrigin(),
    proxySharedSecret: getRequiredEnv("CLAWNOW_PROXY_SHARED_SECRET"),
    controlSessionTtlSeconds: getNumberEnv("CLAWNOW_CONTROL_SESSION_TTL_SECONDS", 300),
    novncSessionTtlMinutes: getNumberEnv("CLAWNOW_NOVNC_TTL_MINUTES", 30),
    provisioningTimeoutSeconds: getNumberEnv(
      "CLAWNOW_PROVISIONING_TIMEOUT_SECONDS",
      DEFAULT_PROVISIONING_TIMEOUT_SECONDS,
    ),
    defaultCloudInit: getOptionalEnv("CLAWNOW_HETZNER_CLOUD_INIT") || "",
    openClawBootstrapCommand: getOptionalEnv("CLAWNOW_OPENCLAW_BOOTSTRAP_COMMAND") || "",
  };
}

function isUniqueViolation(error: PostgrestError | null): boolean {
  return Boolean(error && error.code === "23505");
}

export class ClawNowService {
  private readonly config: ClawNowConfig;
  private readonly hetzner: ClawNowHetznerService;
  private readonly gatewayDeviceIdentity: GatewayDeviceIdentity;

  constructor(config?: ClawNowConfig) {
    this.config = config || loadClawNowConfig();
    this.hetzner = new ClawNowHetznerService(this.config.hetznerApiToken);
    this.gatewayDeviceIdentity = this.resolveGatewayDeviceIdentity();
  }

  getConfigSummary() {
    return {
      provider: "hetzner",
      location: this.config.hetznerLocation,
      serverType: this.config.hetznerServerType,
      image: this.config.hetznerImage,
      sshKeys: this.config.hetznerSshKeys.length > 0 ? this.config.hetznerSshKeys : undefined,
      bootstrapAssetBaseUrl: this.config.bootstrapAssetBaseUrl,
      controlUiManifestUrl: this.config.controlUiManifestUrl,
      controlSessionTtlSeconds: this.config.controlSessionTtlSeconds,
      novncSessionTtlMinutes: this.config.novncSessionTtlMinutes,
      provisioningTimeoutSeconds: this.config.provisioningTimeoutSeconds,
      gatewayBaseUrl: this.config.gatewayBaseUrl,
      gatewayMode: this.config.instanceGatewayTemplate ? "per_instance" : "shared_proxy",
      controlUiPath: this.config.controlUiPath,
      novncPath: this.config.novncPath,
    };
  }

  async getCurrentInstance(userId: string): Promise<ClawInstance | null> {
    const health = await this.getInstanceHealth(userId, { syncProvider: true });
    return health.instance;
  }

  async provisionUserInstance(userId: string): Promise<{
    instance: ClawInstance;
    created: boolean;
    reused: boolean;
  }> {
    let instance = await this.findInstanceByUserId(userId);
    let forceProvision = false;

    if (instance?.hetzner_server_id) {
      try {
        const providerServer = await this.hetzner.getServer(instance.hetzner_server_id);
        const providerStatus = this.mapHetznerStatus(providerServer.status);
        const startupTimedOut =
          providerStatus === "running" &&
          !instance.provisioned_at &&
          this.isProvisioningStale(instance.provisioning_started_at);
        const shouldReprovision = instance.status === "error" || startupTimedOut;

        if (shouldReprovision) {
          await this.logEvent(
            instance.id,
            userId,
            "reprovision.start",
            "Reprovisioning VM after startup failure",
            {
              previousHetznerServerId: providerServer.id,
              previousStatus: instance.status,
              providerStatus: providerServer.status,
            },
            "warn",
          );

          try {
            await this.hetzner.deleteServer(providerServer.id);
          } catch (deleteError) {
            if (!this.isProviderServerMissing(deleteError)) {
              throw deleteError;
            }
          }

          instance = await this.resetInstanceForProvisioning(instance, userId);
          forceProvision = true;
        } else {
          const provisionedAtPatch =
            providerStatus === "running" && !instance.provisioned_at
              ? { provisioned_at: new Date().toISOString() }
              : {};
          const synced = await this.persistProviderState(instance.id, providerServer, {
            status: providerStatus,
            last_error: null,
            ...provisionedAtPatch,
          });
          return {
            instance: synced,
            created: false,
            reused: true,
          };
        }
      } catch (error) {
        if (this.isProviderServerMissing(error)) {
          instance = await this.markInstanceTerminated(
            instance,
            userId,
            "VM was deleted from Hetzner.",
          );
        } else {
          throw this.normalizeProviderError(error);
        }
      }
    }

    if (
      !forceProvision &&
      instance &&
      instance.status === "provisioning" &&
      !this.isProvisioningStale(instance.provisioning_started_at)
    ) {
      return {
        instance,
        created: false,
        reused: true,
      };
    }

    if (!instance) {
      instance = await this.createSeedInstance(userId);
    } else if (!forceProvision) {
      instance = await this.resetInstanceForProvisioning(instance, userId);
    }

    await this.logEvent(
      instance.id,
      userId,
      "provision.start",
      "Provisioning dedicated Hetzner VM",
      {
        location: this.config.hetznerLocation,
        serverType: this.config.hetznerServerType,
        image: this.config.hetznerImage,
      },
    );

    try {
      const cloudInit = this.renderCloudInit(userId, instance.id);
      const createResult = await this.hetzner.createServer({
        name: instance.server_name,
        serverType: this.config.hetznerServerType,
        image: this.config.hetznerImage,
        location: this.config.hetznerLocation,
        sshKeys: this.config.hetznerSshKeys.length > 0 ? this.config.hetznerSshKeys : undefined,
        userData: cloudInit || undefined,
        labels: {
          product: "clawnow",
          tenant: userId,
          environment: "phase1",
        },
      });

      const metadata = {
        ...instance.metadata,
        hetzner_action_id: createResult.actionId,
        trusted_proxy_mode: "trusted-proxy",
      };

      const updated = await this.persistProviderState(instance.id, createResult.server, {
        status: "provisioning",
        metadata,
        provisioned_at: null,
        last_error: null,
      });

      await this.logEvent(updated.id, userId, "provision.success", "Dedicated VM ready", {
        hetznerServerId: updated.hetzner_server_id,
        ipv4: updated.ipv4,
        status: updated.status,
      });

      return {
        instance: updated,
        created: true,
        reused: false,
      };
    } catch (error) {
      const normalizedError = this.normalizeProviderError(error);
      const provisionRejectedBeforeServerCreation =
        !instance.hetzner_server_id &&
        (normalizedError.code === "HETZNER_USER_DATA_REJECTED" ||
          normalizedError.code === "CLOUD_INIT_TOO_LARGE");

      const patch: Record<string, unknown> = {
        status: provisionRejectedBeforeServerCreation ? "terminated" : "error",
        last_error: normalizedError.message,
      };
      if (provisionRejectedBeforeServerCreation) {
        patch.hetzner_server_id = null;
        patch.ipv4 = null;
        patch.ipv6 = null;
        patch.gateway_url = null;
        patch.control_ui_url = null;
        patch.novnc_url = null;
        patch.provisioned_at = null;
        patch.novnc_enabled_until = null;
      }

      await this.updateInstance(instance.id, patch);
      await this.logEvent(
        instance.id,
        userId,
        "provision.failed",
        normalizedError.message,
        {
          errorCode: normalizedError.code,
          error: normalizedError.message,
        },
        "error",
      );
      throw normalizedError;
    }
  }

  async getInstanceHealth(
    userId: string,
    options?: { syncProvider?: boolean },
  ): Promise<ClawInstanceHealth> {
    const checkedAt = new Date().toISOString();
    const current = await this.findInstanceByUserId(userId);

    if (!current) {
      return {
        instance: null,
        providerStatus: null,
        checkedAt,
      };
    }

    if (options?.syncProvider === false) {
      return {
        instance: current,
        providerStatus: current.status,
        checkedAt,
      };
    }

    if (!current.hetzner_server_id) {
      const normalizedCurrent = await this.normalizeDetachedInstance(current);
      return {
        instance: normalizedCurrent,
        providerStatus: normalizedCurrent.status,
        checkedAt,
      };
    }

    try {
      const providerServer = await this.hetzner.getServer(current.hetzner_server_id);
      const providerStatus = this.mapHetznerStatus(providerServer.status);
      let derivedStatus: ClawInstanceStatus = providerStatus;
      let derivedError: string | null = null;
      let provisionedAtPatch: Record<string, unknown> = {};

      if (providerStatus === "running") {
        const gatewayUrl =
          this.buildInstanceGatewayUrl({
            instanceId: current.id,
            ipv4: providerServer.public_net?.ipv4?.ip || null,
            serverId: providerServer.id,
          }) || this.buildGatewayTenantUrl(current.id);
        const gatewayProbe = await this.probeGatewayReadiness(gatewayUrl);
        const everReady = Boolean(current.provisioned_at);

        if (!gatewayProbe.ready) {
          if (gatewayProbe.reason === LEGACY_HTTP_GATEWAY_REASON) {
            derivedStatus = "error";
            derivedError =
              "This VM is running legacy HTTP gateway mode. Click Redeploy Claw to recreate it with HTTPS.";
          } else {
            // Once the gateway has been reachable at least once, transient probe failures
            // should not bounce the UI back into "Starting" (especially mid-wizard).
            if (!everReady) {
              const startupTimedOut = this.isProvisioningStale(current.provisioning_started_at);
              derivedStatus = startupTimedOut ? "error" : "provisioning";
              derivedError = startupTimedOut
                ? `OpenClaw startup timed out (${gatewayProbe.reason || "gateway not reachable"}). Click Redeploy Claw to replace this VM.`
                : "OpenClaw is warming up. First boot can take around 3-10 minutes.";
            } else {
              derivedStatus = "running";
              derivedError = null;
            }
          }
        } else if (!everReady) {
          provisionedAtPatch = { provisioned_at: new Date().toISOString() };
        }
      }

      const updated = await this.persistProviderState(current.id, providerServer, {
        status: derivedStatus,
        last_error: derivedError,
        ...provisionedAtPatch,
      });

      return {
        instance: updated,
        providerStatus: providerServer.status,
        checkedAt,
      };
    } catch (error) {
      if (this.isProviderServerMissing(error)) {
        await this.markInstanceTerminated(current, userId, "VM was deleted from Hetzner.");
        return {
          instance: null,
          providerStatus: null,
          checkedAt,
          error: "Your previous VM was removed. Deploy a new one to continue.",
        };
      }

      const message = safeErrorMessage(error);
      await this.updateInstance(current.id, {
        status: "error",
        last_error: message,
      });
      await this.logEvent(
        current.id,
        userId,
        "health.sync_failed",
        message,
        { error: message },
        "warn",
      );

      const refreshed = await this.findInstanceByUserId(userId);
      return {
        instance: refreshed || current,
        providerStatus: null,
        checkedAt,
        error: message,
      };
    }
  }

  async recoverInstance(userId: string): Promise<{
    instance: ClawInstance;
    action: "poweron" | "reboot";
  }> {
    const instance = await this.requireInstanceWithServer(userId);
    const serverId = instance.hetzner_server_id;
    if (!serverId) {
      throw new ClawNowServiceError("INSTANCE_NOT_READY", "VM has not finished provisioning", 409);
    }

    const server = await this.hetzner.getServer(serverId);
    const action: "poweron" | "reboot" = server.status === "off" ? "poweron" : "reboot";

    await this.hetzner.runAction(serverId, action);
    const updated = await this.updateInstance(instance.id, {
      status: "recovering",
      last_error: null,
    });

    await this.logEvent(
      updated.id,
      userId,
      "recover.start",
      `Recovery action submitted: ${action}`,
      {
        action,
        hetznerStatus: server.status,
      },
      "warn",
    );

    return {
      instance: updated,
      action,
    };
  }

  async launchControlUi(
    userId: string,
    requestMeta?: ClawNowRequestMeta,
  ): Promise<{
    instance: ClawInstance;
    launchUrl: string;
    expiresAt: string;
  }> {
    const health = await this.getInstanceHealth(userId, { syncProvider: true });
    if (!health.instance) {
      throw new ClawNowServiceError("INSTANCE_NOT_FOUND", "No VM exists for this user yet", 404);
    }
    if (health.instance.status !== "running") {
      throw new ClawNowServiceError(
        "INSTANCE_NOT_RUNNING",
        "VM is not running. Please recover first.",
        409,
      );
    }
    if (!this.isTerminalOnboardingCompleted(health.instance)) {
      throw new ClawNowServiceError(
        "ONBOARDING_REQUIRED",
        "Complete terminal onboarding before launching gateway.",
        409,
      );
    }

    const session = await this.createControlGatewaySession(health.instance, userId, requestMeta, {
      syncControlUiOrigins: true,
      strictControlUiOriginSync: true,
    });

    const controlUiBase = this.ensureTrailingSlash(
      this.resolveLaunchBaseUrl(health.instance, "control_ui"),
    );
    const gatewayWebSocketUrl = this.withQuery(this.toWebSocketUrl(controlUiBase), {
      instanceId: health.instance.id,
      token: session.token,
      mode: "trusted-proxy",
    });
    const launchUrl = this.withQuery(controlUiBase, {
      instanceId: health.instance.id,
      token: session.token,
      mode: "trusted-proxy",
      gatewayUrl: gatewayWebSocketUrl,
    });

    await this.ensureControlUiLaunchable(health.instance, launchUrl);

    await this.logEvent(
      health.instance.id,
      userId,
      "session.control_ui",
      "Control UI launch session created",
      {
        expiresAt: session.expiresAt,
        ip: requestMeta?.ip || null,
      },
    );

    return {
      instance: health.instance,
      launchUrl,
      expiresAt: session.expiresAt,
    };
  }

  async createNoVncSession(
    userId: string,
    requestMeta?: ClawNowRequestMeta,
  ): Promise<{
    instance: ClawInstance;
    launchUrl: string;
    expiresAt: string;
  }> {
    const health = await this.getInstanceHealth(userId, { syncProvider: true });
    if (!health.instance) {
      throw new ClawNowServiceError("INSTANCE_NOT_FOUND", "No VM exists for this user yet", 404);
    }
    if (health.instance.status !== "running") {
      throw new ClawNowServiceError(
        "INSTANCE_NOT_RUNNING",
        "VM is not running. Please recover first.",
        409,
      );
    }

    const ttlSeconds = this.config.novncSessionTtlMinutes * 60;
    const session = await this.createAccessSession(
      health.instance,
      userId,
      "novnc",
      ttlSeconds,
      requestMeta,
    );

    const updated = await this.updateInstance(health.instance.id, {
      novnc_enabled_until: session.expiresAt,
    });

    const noVncBase = this.resolveLaunchBaseUrl(updated, "novnc");
    const launchUrl = this.withQuery(noVncBase, {
      instanceId: updated.id,
      token: session.token,
      mode: "trusted-proxy",
    });

    await this.logEvent(updated.id, userId, "session.novnc", "noVNC session created", {
      expiresAt: session.expiresAt,
      ip: requestMeta?.ip || null,
    });

    return {
      instance: updated,
      launchUrl,
      expiresAt: session.expiresAt,
    };
  }

  async configureOpenAiApiKey(
    userId: string,
    apiKey: string,
    requestMeta?: ClawNowRequestMeta,
  ): Promise<{ instance: ClawInstance }> {
    const normalizedApiKey = apiKey.trim();
    if (!normalizedApiKey) {
      throw new ClawNowServiceError("OPENAI_KEY_REQUIRED", "OpenAI API key is required", 400);
    }

    const health = await this.getInstanceHealth(userId, { syncProvider: true });
    if (!health.instance) {
      throw new ClawNowServiceError("INSTANCE_NOT_FOUND", "No VM exists for this user yet", 404);
    }
    if (health.instance.status !== "running") {
      throw new ClawNowServiceError(
        "INSTANCE_NOT_RUNNING",
        "VM is not running. Please recover first.",
        409,
      );
    }

    const session = await this.createAccessSession(
      health.instance,
      userId,
      "control_ui",
      this.config.controlSessionTtlSeconds,
      requestMeta,
    );

    const controlUiBase = this.ensureTrailingSlash(
      this.resolveLaunchBaseUrl(health.instance, "control_ui"),
    );
    const gatewayWebSocketUrl = this.withQuery(this.toWebSocketUrl(controlUiBase), {
      instanceId: health.instance.id,
      token: session.token,
      mode: "trusted-proxy",
    });
    await this.patchGatewayConfig(gatewayWebSocketUrl, session.token, {
      models: {
        providers: {
          openai: {
            apiKey: normalizedApiKey,
          },
        },
      },
    });

    await this.logEvent(
      health.instance.id,
      userId,
      "auth.openai_api_key.updated",
      "Updated OpenAI API key for workspace",
      {
        ip: requestMeta?.ip || null,
        keyPrefix: normalizedApiKey.slice(0, 7),
      },
    );

    return { instance: health.instance };
  }

  async configureOpenAiCodexAccessToken(
    userId: string,
    accessToken: string,
    requestMeta?: ClawNowRequestMeta,
  ): Promise<{ instance: ClawInstance }> {
    const normalizedAccessToken = accessToken.trim();
    if (!normalizedAccessToken) {
      throw new ClawNowServiceError(
        "CODEX_TOKEN_REQUIRED",
        "OpenAI Codex access token is required",
        400,
      );
    }

    const health = await this.getInstanceHealth(userId, { syncProvider: true });
    if (!health.instance) {
      throw new ClawNowServiceError("INSTANCE_NOT_FOUND", "No VM exists for this user yet", 404);
    }
    if (health.instance.status !== "running") {
      throw new ClawNowServiceError(
        "INSTANCE_NOT_RUNNING",
        "VM is not running. Please recover first.",
        409,
      );
    }

    const session = await this.createAccessSession(
      health.instance,
      userId,
      "control_ui",
      this.config.controlSessionTtlSeconds,
      requestMeta,
    );

    const controlUiBase = this.ensureTrailingSlash(
      this.resolveLaunchBaseUrl(health.instance, "control_ui"),
    );
    const gatewayWebSocketUrl = this.withQuery(this.toWebSocketUrl(controlUiBase), {
      instanceId: health.instance.id,
      token: session.token,
      mode: "trusted-proxy",
    });
    await this.patchGatewayConfig(gatewayWebSocketUrl, session.token, {
      models: {
        providers: {
          "openai-codex": {
            apiKey: normalizedAccessToken,
          },
        },
      },
    });

    await this.logEvent(
      health.instance.id,
      userId,
      "auth.openai_codex_oauth.updated",
      "Updated OpenAI Codex OAuth access token for workspace",
      {
        ip: requestMeta?.ip || null,
        tokenPrefix: normalizedAccessToken.slice(0, 7),
      },
    );

    return { instance: health.instance };
  }

  async startTerminalOnboarding(
    userId: string,
    requestMeta?: ClawNowRequestMeta,
  ): Promise<{ instance: ClawInstance; sessionId: string; result: OnboardingWizardResult }> {
    const instance = await this.requireRunningInstance(userId);

    // ClawNow uses a stateless (control-plane managed) wizard. We intentionally
    // avoid OpenClaw's in-memory gateway wizard sessions because any restart
    // wipes progress and causes flaky UX in hosted VM setups.
    const sessionId = randomUUID();
    const metadata =
      instance.metadata && typeof instance.metadata === "object" ? instance.metadata : {};
    const updatedInstance = await this.updateInstance(instance.id, {
      metadata: {
        ...metadata,
        trusted_proxy_mode: "trusted-proxy",
        onboarding_completed: false,
        onboarding_completed_at: null,
        onboarding_last_status: "running",
        onboarding_session_id: sessionId,
        onboarding_step_id: CLAWNOW_WIZARD_STEP_AUTH_METHOD,
        onboarding_auth_method: null,
        onboarding_codex_session_id: null,
      },
    });

    await this.logEvent(
      instance.id,
      userId,
      "onboarding.clawnow.start",
      "Started ClawNow setup wizard",
      {
        sessionId,
        ip: requestMeta?.ip || null,
      },
    );

    return {
      instance: updatedInstance,
      sessionId,
      result: {
        done: false,
        status: "running",
        step: {
          id: CLAWNOW_WIZARD_STEP_AUTH_METHOD,
          type: "select",
          title: "OpenAI auth method",
          message: "Choose how you want to connect your OpenClaw workspace to OpenAI.",
          options: [
            {
              value: "openai_codex_oauth",
              label: "OpenAI Codex (ChatGPT OAuth)",
              hint: "Use your ChatGPT plan. You'll login and paste a callback URL.",
            },
            {
              value: "openai_api_key",
              label: "OpenAI API key",
              hint: "Bring your own OpenAI API key (BYOK).",
            },
          ],
        },
      },
    };
  }

  async continueTerminalOnboarding(
    userId: string,
    params: {
      sessionId: string;
      answer?: {
        stepId: string;
        value: unknown;
      };
    },
    requestMeta?: ClawNowRequestMeta,
  ): Promise<{ instance: ClawInstance; result: OnboardingWizardResult }> {
    const sessionId = params.sessionId.trim();
    if (!sessionId) {
      throw new ClawNowServiceError(
        "WIZARD_SESSION_REQUIRED",
        "Onboarding session ID is required",
        400,
      );
    }

    const instance = await this.requireRunningInstance(userId);
    const metadata =
      instance.metadata && typeof instance.metadata === "object" ? instance.metadata : {};
    const activeSessionId =
      typeof (metadata as { onboarding_session_id?: unknown }).onboarding_session_id === "string"
        ? String((metadata as { onboarding_session_id: string }).onboarding_session_id).trim()
        : "";
    const stepId =
      typeof (metadata as { onboarding_step_id?: unknown }).onboarding_step_id === "string"
        ? String((metadata as { onboarding_step_id: string }).onboarding_step_id).trim()
        : "";

    if (!activeSessionId || activeSessionId !== sessionId || !stepId) {
      throw new ClawNowServiceError(
        "WIZARD_SESSION_EXPIRED",
        "Setup wizard session expired. Please start cooking wizard again.",
        409,
      );
    }

    const answer = params.answer;
    const answerStepId = answer?.stepId?.trim() || "";
    const answerValue = answer?.value;
    if (!answerStepId) {
      throw new ClawNowServiceError("WIZARD_STEP_REQUIRED", "Onboarding step ID is required", 400);
    }
    if (answerStepId !== stepId) {
      throw new ClawNowServiceError(
        "WIZARD_STEP_MISMATCH",
        "Wizard step mismatch. Please refresh and retry.",
        409,
      );
    }

    const setWizardState = async (patch: Record<string, unknown>): Promise<ClawInstance> => {
      return await this.updateInstance(instance.id, {
        metadata: {
          ...metadata,
          ...patch,
        },
      });
    };

    if (stepId === CLAWNOW_WIZARD_STEP_AUTH_METHOD) {
      const methodRaw = typeof answerValue === "string" ? answerValue.trim() : "";
      const authMethod: ClawNowWizardAuthMethod | null =
        methodRaw === "openai_api_key" || methodRaw === "openai_codex_oauth"
          ? (methodRaw as ClawNowWizardAuthMethod)
          : null;
      if (!authMethod) {
        throw new ClawNowServiceError("WIZARD_INVALID_VALUE", "Invalid auth method selection", 400);
      }

      if (authMethod === "openai_api_key") {
        const updated = await setWizardState({
          onboarding_step_id: CLAWNOW_WIZARD_STEP_OPENAI_API_KEY,
          onboarding_auth_method: authMethod,
          onboarding_codex_session_id: null,
        });
        return {
          instance: updated,
          result: {
            done: false,
            status: "running",
            step: {
              id: CLAWNOW_WIZARD_STEP_OPENAI_API_KEY,
              type: "text",
              title: "OpenAI API key",
              message: "Paste your OpenAI API key. We will store it in your VM config.",
              placeholder: "sk-...",
              sensitive: true,
            },
          },
        };
      }

      const updated = await setWizardState({
        onboarding_step_id: CLAWNOW_WIZARD_STEP_CODEX_CALLBACK_URL,
        onboarding_auth_method: authMethod,
        onboarding_codex_session_id: null,
      });
      return {
        instance: updated,
        result: {
          done: false,
          status: "running",
          step: {
            id: CLAWNOW_WIZARD_STEP_CODEX_CALLBACK_URL,
            type: "text",
            title: "Paste the redirect URL",
            message:
              'Click "Login with ChatGPT" to sign in, then copy the full callback URL and paste it here.',
            placeholder: "http://localhost:1455/auth/callback?code=...",
            sensitive: false,
          },
        },
      };
    }

    if (stepId === CLAWNOW_WIZARD_STEP_OPENAI_API_KEY) {
      const apiKey = typeof answerValue === "string" ? answerValue.trim() : "";
      if (!apiKey) {
        throw new ClawNowServiceError("OPENAI_API_KEY_REQUIRED", "API key is required", 400);
      }

      await this.configureOpenAiApiKey(userId, apiKey, requestMeta);
      const doneInstance = await this.updateOnboardingState(instance, {
        completed: true,
        status: "done",
      });
      // Clear wizard session bookkeeping but keep onboarding_completed=true.
      const cleared = await this.updateInstance(doneInstance.id, {
        metadata: {
          ...(doneInstance.metadata && typeof doneInstance.metadata === "object"
            ? doneInstance.metadata
            : {}),
          onboarding_session_id: null,
          onboarding_step_id: null,
          onboarding_codex_session_id: null,
        },
      });

      return {
        instance: cleared,
        result: { done: true, status: "done" },
      };
    }

    if (stepId === CLAWNOW_WIZARD_STEP_CODEX_CALLBACK_URL) {
      const callbackUrl = typeof answerValue === "string" ? answerValue.trim() : "";
      if (!callbackUrl) {
        throw new ClawNowServiceError(
          "CODEX_CALLBACK_URL_REQUIRED",
          "Redirect URL is required",
          400,
        );
      }
      const codexSessionId =
        typeof (metadata as { onboarding_codex_session_id?: unknown })
          .onboarding_codex_session_id === "string"
          ? String(
              (metadata as { onboarding_codex_session_id: string }).onboarding_codex_session_id,
            ).trim()
          : "";
      if (!codexSessionId) {
        throw new ClawNowServiceError(
          "CODEX_OAUTH_NOT_STARTED",
          'Click "Login with ChatGPT" first, then paste the callback URL here.',
          409,
        );
      }

      const creds = await codexOAuthSessionService.complete(userId, codexSessionId, callbackUrl);
      await this.configureOpenAiCodexAccessToken(userId, creds.access, requestMeta);
      const doneInstance = await this.updateOnboardingState(instance, {
        completed: true,
        status: "done",
      });
      const cleared = await this.updateInstance(doneInstance.id, {
        metadata: {
          ...(doneInstance.metadata && typeof doneInstance.metadata === "object"
            ? doneInstance.metadata
            : {}),
          onboarding_session_id: null,
          onboarding_step_id: null,
          onboarding_codex_session_id: null,
        },
      });

      return {
        instance: cleared,
        result: { done: true, status: "done" },
      };
    }

    throw new ClawNowServiceError(
      "WIZARD_STEP_UNKNOWN",
      "Wizard step not found. Please start cooking wizard again.",
      409,
    );
  }

  async cancelTerminalOnboarding(
    userId: string,
    sessionId: string,
    requestMeta?: ClawNowRequestMeta,
  ): Promise<{ instance: ClawInstance; status: OnboardingWizardStatusResult }> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new ClawNowServiceError(
        "WIZARD_SESSION_REQUIRED",
        "Onboarding session ID is required",
        400,
      );
    }

    const instance = await this.requireRunningInstance(userId);
    const metadata =
      instance.metadata && typeof instance.metadata === "object" ? instance.metadata : {};
    const activeSessionId =
      typeof (metadata as { onboarding_session_id?: unknown }).onboarding_session_id === "string"
        ? String((metadata as { onboarding_session_id: string }).onboarding_session_id).trim()
        : "";
    if (activeSessionId && activeSessionId !== normalizedSessionId) {
      throw new ClawNowServiceError(
        "WIZARD_SESSION_EXPIRED",
        "Setup wizard session expired. Please start cooking wizard again.",
        409,
      );
    }

    const updatedInstance = await this.updateOnboardingState(instance, {
      completed: false,
      status: "cancelled",
    });
    const cleared = await this.updateInstance(updatedInstance.id, {
      metadata: {
        ...(updatedInstance.metadata && typeof updatedInstance.metadata === "object"
          ? updatedInstance.metadata
          : {}),
        onboarding_session_id: null,
        onboarding_step_id: null,
        onboarding_auth_method: null,
        onboarding_codex_session_id: null,
      },
    });

    await this.logEvent(
      instance.id,
      userId,
      "onboarding.clawnow.cancel",
      "Cancelled ClawNow setup wizard",
      {
        sessionId: normalizedSessionId,
        ip: requestMeta?.ip || null,
      },
      "warn",
    );

    return {
      instance: cleared,
      status: {
        status: "cancelled",
      },
    };
  }

  async getLatestOpenAiCodexOAuthUrl(
    userId: string,
    requestMeta?: ClawNowRequestMeta,
  ): Promise<{ instance: ClawInstance; authUrl: string | null }> {
    const instance = await this.requireRunningInstance(userId);
    const metadata =
      instance.metadata && typeof instance.metadata === "object" ? instance.metadata : {};
    const stepId =
      typeof (metadata as { onboarding_step_id?: unknown }).onboarding_step_id === "string"
        ? String((metadata as { onboarding_step_id: string }).onboarding_step_id).trim()
        : "";
    const sessionId =
      typeof (metadata as { onboarding_session_id?: unknown }).onboarding_session_id === "string"
        ? String((metadata as { onboarding_session_id: string }).onboarding_session_id).trim()
        : "";

    if (!sessionId || stepId !== CLAWNOW_WIZARD_STEP_CODEX_CALLBACK_URL) {
      throw new ClawNowServiceError(
        "CODEX_OAUTH_NOT_READY",
        "Start the cooking wizard and select OpenAI Codex (ChatGPT OAuth) first.",
        409,
      );
    }

    const oauth = await codexOAuthSessionService.start(userId);
    const updatedInstance = await this.updateInstance(instance.id, {
      metadata: {
        ...metadata,
        onboarding_codex_session_id: oauth.sessionId,
      },
    });

    await this.logEvent(
      instance.id,
      userId,
      "auth.openai_codex_oauth.start",
      "Started OpenAI Codex OAuth session",
      {
        sessionId: oauth.sessionId,
        ip: requestMeta?.ip || null,
      },
    );

    return {
      instance: updatedInstance,
      authUrl: oauth.authUrl,
    };
  }

  private async createSeedInstance(userId: string): Promise<ClawInstance> {
    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from("claw_instances")
      .insert({
        user_id: userId,
        provider: "hetzner",
        region: this.config.hetznerLocation,
        server_type: this.config.hetznerServerType,
        image: this.config.hetznerImage,
        server_name: this.buildServerName(userId),
        status: "provisioning",
        provisioning_started_at: now,
        metadata: this.buildProvisioningMetadata(),
        gateway_url: null,
        control_ui_url: null,
        novnc_url: null,
      })
      .select("*")
      .single();

    if (error || !data) {
      if (isUniqueViolation(error)) {
        const existing = await this.findInstanceByUserId(userId);
        if (existing) {
          return existing;
        }
      }
      throw new ClawNowServiceError(
        "DB_INSERT_FAILED",
        error?.message || "Failed to create VM record",
        500,
      );
    }

    return data as ClawInstance;
  }

  private async persistProviderState(
    instanceId: string,
    providerServer: HetznerServer,
    override: Partial<ClawInstance> = {},
  ): Promise<ClawInstance> {
    const ipv4 = providerServer.public_net?.ipv4?.ip || null;
    const ipv6 = providerServer.public_net?.ipv6?.ip || null;
    const gatewayUrl =
      this.buildInstanceGatewayUrl({
        instanceId,
        ipv4,
        serverId: providerServer.id,
      }) || this.buildGatewayTenantUrl(instanceId);
    const controlUiUrl = gatewayUrl
      ? joinUrl(gatewayUrl, this.config.controlUiPath)
      : this.buildSharedControlUiUrl(instanceId);
    const novncUrl = gatewayUrl
      ? joinUrl(gatewayUrl, this.config.novncPath)
      : this.buildSharedNoVncUrl(instanceId);

    const patch: Record<string, unknown> = {
      hetzner_server_id: providerServer.id,
      ipv4,
      ipv6,
      gateway_url: gatewayUrl,
      control_ui_url: controlUiUrl,
      novnc_url: novncUrl,
      last_heartbeat_at: new Date().toISOString(),
    };

    const merged = { ...patch, ...override };
    return this.updateInstance(instanceId, merged);
  }

  private async updateInstance(
    instanceId: string,
    patch: Record<string, unknown>,
  ): Promise<ClawInstance> {
    const { data, error } = await supabaseAdmin
      .from("claw_instances")
      .update(patch)
      .eq("id", instanceId)
      .select("*")
      .single();

    if (error || !data) {
      throw new ClawNowServiceError(
        "DB_UPDATE_FAILED",
        error?.message || "Failed to update VM record",
        500,
      );
    }

    return data as ClawInstance;
  }

  private async resetInstanceForProvisioning(
    instance: ClawInstance,
    userId: string,
  ): Promise<ClawInstance> {
    const { data, error } = await supabaseAdmin
      .from("claw_instances")
      .update({
        status: "provisioning",
        provisioning_started_at: new Date().toISOString(),
        last_error: null,
        region: this.config.hetznerLocation,
        server_type: this.config.hetznerServerType,
        image: this.config.hetznerImage,
        server_name: this.buildServerName(userId),
        hetzner_server_id: null,
        ipv4: null,
        ipv6: null,
        gateway_url: null,
        control_ui_url: null,
        novnc_url: null,
        provisioned_at: null,
        last_heartbeat_at: null,
        novnc_enabled_until: null,
        metadata: this.buildProvisioningMetadata(instance.metadata),
      })
      .eq("id", instance.id)
      .select("*")
      .single();

    if (error || !data) {
      throw new ClawNowServiceError(
        "DB_UPDATE_FAILED",
        error?.message || "Failed to update VM state",
        500,
      );
    }

    return data as ClawInstance;
  }

  private async findInstanceByUserId(userId: string): Promise<ClawInstance | null> {
    const { data, error } = await supabaseAdmin
      .from("claw_instances")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      throw new ClawNowServiceError(
        "DB_FETCH_FAILED",
        error.message || "Failed to fetch VM record",
        500,
      );
    }

    return (data as ClawInstance | null) || null;
  }

  private async requireInstanceWithServer(userId: string): Promise<ClawInstance> {
    const instance = await this.findInstanceByUserId(userId);
    if (!instance) {
      throw new ClawNowServiceError("INSTANCE_NOT_FOUND", "No VM exists for this user yet", 404);
    }
    if (!instance.hetzner_server_id) {
      throw new ClawNowServiceError("INSTANCE_NOT_READY", "VM has not finished provisioning", 409);
    }
    return instance;
  }

  private async createAccessSession(
    instance: ClawInstance,
    userId: string,
    sessionType: ClawSessionType,
    ttlSeconds: number,
    requestMeta?: ClawNowRequestMeta,
  ): Promise<{ token: string; expiresAt: string }> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAtDate = new Date((nowSeconds + ttlSeconds) * 1000);
    const payload = {
      iss: "clawnow-control-plane",
      aud: "openclaw-gateway",
      sub: userId,
      jti: randomUUID(),
      iat: nowSeconds,
      exp: nowSeconds + ttlSeconds,
      instance_id: instance.id,
      session_type: sessionType,
      provider: "hetzner",
      trusted_proxy: true,
      gateway_url: instance.gateway_url,
    };
    const token = this.signToken(payload);
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = expiresAtDate.toISOString();

    const { error } = await supabaseAdmin.from("claw_access_sessions").insert({
      instance_id: instance.id,
      user_id: userId,
      session_type: sessionType,
      token_hash: tokenHash,
      expires_at: expiresAt,
      client_ip: requestMeta?.ip || null,
      user_agent: requestMeta?.userAgent || null,
      metadata: {
        trusted_proxy_mode: "trusted-proxy",
        gateway_url: instance.gateway_url,
      },
    });

    if (error) {
      throw new ClawNowServiceError(
        "SESSION_CREATE_FAILED",
        error.message || "Failed to create access session",
        500,
      );
    }

    return {
      token,
      expiresAt,
    };
  }

  private signToken(payload: Record<string, unknown>): string {
    const header = {
      alg: "HS256",
      typ: "JWT",
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.config.proxySharedSecret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest("base64url");

    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  private async syncControlUiAllowedOrigins(params: {
    instanceId: string;
    userId: string;
    gatewayWebSocketUrl: string;
    token: string;
    controlUiBase: string;
    requestMeta?: ClawNowRequestMeta;
  }): Promise<void> {
    const requestedOrigin = this.normalizeOrigin(params.requestMeta?.controlUiOrigin);
    const launchOrigin = this.normalizeOrigin(params.controlUiBase);
    const configuredOrigin = this.normalizeOrigin(this.config.controlUiAllowedOrigin);
    const requestedOrigins = Array.from(
      new Set(
        [configuredOrigin, requestedOrigin, launchOrigin].filter((value): value is string =>
          Boolean(value),
        ),
      ),
    );

    const snapshot = await this.requestGatewayMethod<{
      config?: {
        gateway?: {
          controlUi?: {
            allowedOrigins?: unknown;
            dangerouslyAllowHostHeaderOriginFallback?: unknown;
          };
        };
      };
    }>(params.gatewayWebSocketUrl, params.token, "config.get", {});

    const existingOrigins = this.normalizeOriginList(
      snapshot?.config?.gateway?.controlUi?.allowedOrigins,
    );
    const mergedOrigins = Array.from(new Set([...existingOrigins, ...requestedOrigins]));
    const fallbackEnabled =
      snapshot?.config?.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;
    const originsChanged = !this.sameStringSet(existingOrigins, mergedOrigins);

    if (originsChanged || !fallbackEnabled) {
      await this.patchGatewayConfig(params.gatewayWebSocketUrl, params.token, {
        gateway: {
          controlUi: {
            allowedOrigins: mergedOrigins,
            dangerouslyAllowHostHeaderOriginFallback: true,
          },
        },
      });
    }

    await this.logEvent(
      params.instanceId,
      params.userId,
      "gateway.control_ui.allowed_origins.sync",
      "Synced gateway control UI allowed origins",
      { origins: mergedOrigins },
      "info",
    );
  }

  private normalizeOrigin(rawUrl: string | null | undefined): string | null {
    const raw = rawUrl?.trim();
    if (!raw) {
      return null;
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      return parsed.origin;
    } catch {
      return null;
    }
  }

  private normalizeOriginList(rawOrigins: unknown): string[] {
    if (!Array.isArray(rawOrigins)) {
      return [];
    }
    return rawOrigins
      .map((value) => (typeof value === "string" ? this.normalizeOrigin(value) : null))
      .filter((value): value is string => Boolean(value));
  }

  private sameStringSet(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
      return false;
    }
    const rightSet = new Set(right);
    return left.every((value) => rightSet.has(value));
  }

  private buildServerName(userId: string): string {
    const uid =
      userId
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, 8)
        .toLowerCase() || "tenant";
    const suffix = Date.now().toString(36).slice(-6);
    return `${this.config.vmNamePrefix}-${uid}-${suffix}`.slice(0, 63);
  }

  private buildGatewayTenantUrl(instanceId: string): string | null {
    if (!this.config.gatewayBaseUrl) {
      return null;
    }
    return joinUrl(this.config.gatewayBaseUrl, `tenant/${instanceId}`);
  }

  private buildSharedControlUiUrl(instanceId: string): string | null {
    if (!this.config.controlUiBaseUrl) {
      return null;
    }
    return this.withQuery(this.config.controlUiBaseUrl, { instanceId });
  }

  private buildSharedNoVncUrl(instanceId: string): string | null {
    if (!this.config.novncBaseUrl) {
      return null;
    }
    return this.withQuery(this.config.novncBaseUrl, { instanceId });
  }

  private buildInstanceGatewayUrl(params: {
    instanceId: string;
    ipv4: string | null;
    serverId: number;
  }): string | null {
    const template = this.config.instanceGatewayTemplate;
    if (!params.ipv4 && template.includes("{{IPV4}}")) {
      return null;
    }

    const rendered = template
      .replaceAll("{{IPV4}}", params.ipv4 || "")
      .replaceAll("{{INSTANCE_ID}}", params.instanceId)
      .replaceAll("{{SERVER_ID}}", String(params.serverId));

    if (!rendered.trim()) {
      return null;
    }
    return ensureAbsoluteUrl("CLAWNOW_INSTANCE_GATEWAY_TEMPLATE", rendered);
  }

  private resolveLaunchBaseUrl(instance: ClawInstance, sessionType: ClawSessionType): string {
    const perInstanceUrl =
      sessionType === "control_ui" ? instance.control_ui_url : instance.novnc_url;
    if (perInstanceUrl) {
      return perInstanceUrl;
    }

    const sharedUrl =
      sessionType === "control_ui"
        ? this.buildSharedControlUiUrl(instance.id)
        : this.buildSharedNoVncUrl(instance.id);
    if (sharedUrl) {
      return sharedUrl;
    }

    throw new ClawNowServiceError(
      "INSTANCE_GATEWAY_MISSING",
      sessionType === "control_ui"
        ? "Control UI endpoint is not ready for this instance yet."
        : "noVNC endpoint is not ready for this instance yet.",
      409,
    );
  }

  private async requireRunningInstance(userId: string): Promise<ClawInstance> {
    const health = await this.getInstanceHealth(userId, { syncProvider: true });
    if (!health.instance) {
      throw new ClawNowServiceError("INSTANCE_NOT_FOUND", "No VM exists for this user yet", 404);
    }
    const providerStillRunning =
      health.providerStatus === "running" && Boolean(health.instance.hetzner_server_id);
    if (health.instance.status !== "running" && !providerStillRunning) {
      throw new ClawNowServiceError(
        "INSTANCE_NOT_RUNNING",
        "VM is not running. Please recover first.",
        409,
      );
    }
    return health.instance;
  }

  private async createControlGatewaySession(
    instance: ClawInstance,
    userId: string,
    requestMeta?: ClawNowRequestMeta,
    options?: {
      syncControlUiOrigins?: boolean;
      strictControlUiOriginSync?: boolean;
    },
  ): Promise<{ token: string; expiresAt: string; gatewayWebSocketUrl: string }> {
    const session = await this.createAccessSession(
      instance,
      userId,
      "control_ui",
      this.config.controlSessionTtlSeconds,
      requestMeta,
    );
    const controlUiBase = this.ensureTrailingSlash(
      this.resolveLaunchBaseUrl(instance, "control_ui"),
    );
    const gatewayWebSocketUrl = this.withQuery(this.toWebSocketUrl(controlUiBase), {
      instanceId: instance.id,
      token: session.token,
      mode: "trusted-proxy",
    });
    if (options?.syncControlUiOrigins) {
      try {
        await this.syncControlUiAllowedOrigins({
          instanceId: instance.id,
          userId,
          gatewayWebSocketUrl,
          token: session.token,
          controlUiBase,
          requestMeta,
        });
      } catch (error) {
        if (options.strictControlUiOriginSync) {
          throw new ClawNowServiceError(
            "GATEWAY_ORIGIN_SYNC_FAILED",
            `Failed to sync control UI allowed origins: ${safeErrorMessage(error)}`,
            502,
          );
        }
        try {
          await this.logEvent(
            instance.id,
            userId,
            "gateway.control_ui.allowed_origins.sync_failed",
            `Failed to sync control UI allowed origins: ${safeErrorMessage(error)}`,
            { error: safeErrorMessage(error) },
            "warn",
          );
        } catch {}
      }
    }
    return {
      token: session.token,
      expiresAt: session.expiresAt,
      gatewayWebSocketUrl,
    };
  }

  private toHttpOriginFromWebSocketUrl(websocketUrl: string): string | null {
    try {
      const url = new URL(websocketUrl);
      if (url.protocol === "ws:") {
        url.protocol = "http:";
      } else if (url.protocol === "wss:") {
        url.protocol = "https:";
      } else {
        return null;
      }
      // Drop path/query so we can probe health/bootstrap endpoints at the origin.
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      return url.origin;
    } catch {
      return null;
    }
  }

  private shouldAttemptGatewayRepair(error: unknown): string | null {
    if (!(error instanceof ClawNowServiceError)) {
      return null;
    }
    // Only attempt repair for connectivity/auth failures - never for validation errors.
    if (
      !new Set([
        "GATEWAY_CONNECT_FAILED",
        "GATEWAY_SOCKET_CLOSED",
        "GATEWAY_TIMEOUT",
        "GATEWAY_REQUEST_FAILED",
      ]).has(error.code)
    ) {
      return null;
    }

    const message = error.message.toLowerCase();
    if (message.includes("gateway token mismatch") || message.includes("gateway token missing")) {
      return "gateway_auth_mismatch";
    }
    if (message.includes("upstream_unavailable") || message.includes("healthhttp=503")) {
      return "gateway_upstream_unavailable";
    }
    if (message.includes("econnrefused") && message.includes("127.0.0.1:18789")) {
      return "gateway_upstream_refused";
    }
    return null;
  }

  private async repairGatewayViaProxy(params: {
    gatewayWebSocketUrl: string;
    token: string;
    reason: string;
  }): Promise<boolean> {
    const origin = this.toHttpOriginFromWebSocketUrl(params.gatewayWebSocketUrl);
    if (!origin) {
      return false;
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), 12_000);
    try {
      const url = new URL(`/${GATEWAY_REPAIR_PATH}`, origin).toString();
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${params.token}`,
          "content-type": "application/json; charset=utf-8",
          "user-agent": "clawnow-control-plane/gateway-repair",
        },
        body: JSON.stringify({ reason: params.reason }),
      });

      if (!response.ok) {
        let payload: { error?: unknown; code?: unknown } = {};
        try {
          payload = (await response.json()) as { error?: unknown; code?: unknown };
        } catch {
          payload = {};
        }
        const message =
          typeof payload.error === "string" && payload.error.trim()
            ? payload.error.trim()
            : `Gateway repair failed with HTTP ${response.status}`;
        throw new Error(message);
      }

      return true;
    } catch (error) {
      if (isAbortError(error)) {
        return false;
      }
      return false;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async diagnoseGatewayWebSocketOpenFailure(gatewayWebSocketUrl: string): Promise<string> {
    const origin = this.toHttpOriginFromWebSocketUrl(gatewayWebSocketUrl);
    if (!origin) {
      return "Could not derive gateway origin from websocket URL.";
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), 4000);
    const headers = { "user-agent": "clawnow-control-plane/gateway-probe" };

    const fetchJson = async (
      path: string,
    ): Promise<{ ok: boolean; status: number; payload: unknown }> => {
      const url = new URL(path, origin).toString();
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers,
      });
      let payload: unknown = null;
      try {
        payload = (await response.json()) as unknown;
      } catch {
        payload = null;
      }
      return { ok: response.ok, status: response.status, payload };
    };

    try {
      const [health, bootstrap] = await Promise.all([
        fetchJson(`/${GATEWAY_HEALTH_PATH}`),
        fetchJson("/__clawnow/bootstrap"),
      ]);

      const describePayloadError = (payload: unknown): string | null => {
        if (!payload || typeof payload !== "object") {
          return null;
        }
        const errorRaw = (payload as { error?: unknown }).error;
        const codeRaw = (payload as { code?: unknown }).code;
        const error = typeof errorRaw === "string" ? errorRaw.trim() : "";
        const code = typeof codeRaw === "string" ? codeRaw.trim() : "";
        if (code && error) {
          return `${code}: ${error}`;
        }
        if (error) {
          return error;
        }
        if (code) {
          return code;
        }
        return null;
      };

      const parts: string[] = [];
      parts.push(`origin=${origin}`);

      if (bootstrap.ok) {
        const phase =
          bootstrap.payload && typeof bootstrap.payload === "object"
            ? (bootstrap.payload as { phase?: unknown }).phase
            : null;
        const status =
          bootstrap.payload && typeof bootstrap.payload === "object"
            ? (bootstrap.payload as { status?: unknown }).status
            : null;
        const message =
          bootstrap.payload && typeof bootstrap.payload === "object"
            ? (bootstrap.payload as { message?: unknown }).message
            : null;
        if (typeof phase === "string" && typeof status === "string") {
          parts.push(`bootstrap=${phase}/${status}`);
        } else {
          parts.push("bootstrap=ok");
        }
        if (typeof message === "string" && message.trim()) {
          parts.push(`bootstrapMessage=${message.trim()}`);
        }
      } else {
        parts.push(
          `bootstrapHttp=${bootstrap.status}${
            describePayloadError(bootstrap.payload)
              ? ` (${describePayloadError(bootstrap.payload)})`
              : ""
          }`,
        );
      }

      if (health.ok) {
        parts.push("health=ok");
      } else {
        parts.push(
          `healthHttp=${health.status}${
            describePayloadError(health.payload) ? ` (${describePayloadError(health.payload)})` : ""
          }`,
        );
      }

      return parts.join("; ");
    } catch (error) {
      if (isAbortError(error)) {
        return `origin=${origin}; probe timed out`;
      }
      return `origin=${origin}; probe failed: ${safeErrorMessage(error)}`;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private parseWizardStartPayload(payload: unknown): {
    sessionId: string;
    result: OnboardingWizardResult;
  } {
    if (!payload || typeof payload !== "object") {
      throw new ClawNowServiceError(
        "WIZARD_PAYLOAD_INVALID",
        "Invalid onboarding wizard response",
        502,
      );
    }
    const sessionIdRaw = (payload as { sessionId?: unknown }).sessionId;
    const sessionId = typeof sessionIdRaw === "string" ? sessionIdRaw.trim() : "";
    if (!sessionId) {
      throw new ClawNowServiceError(
        "WIZARD_PAYLOAD_INVALID",
        "Onboarding wizard session ID missing",
        502,
      );
    }
    return {
      sessionId,
      result: this.parseWizardResult(payload),
    };
  }

  private parseWizardResult(payload: unknown): OnboardingWizardResult {
    if (!payload || typeof payload !== "object") {
      throw new ClawNowServiceError(
        "WIZARD_PAYLOAD_INVALID",
        "Invalid onboarding wizard response",
        502,
      );
    }

    const doneRaw = (payload as { done?: unknown }).done;
    if (typeof doneRaw !== "boolean") {
      throw new ClawNowServiceError(
        "WIZARD_PAYLOAD_INVALID",
        "Onboarding wizard response is missing done state",
        502,
      );
    }

    const statusRaw = (payload as { status?: unknown }).status;
    const errorRaw = (payload as { error?: unknown }).error;
    const stepRaw = (payload as { step?: unknown }).step;

    const result: OnboardingWizardResult = { done: doneRaw };
    if (this.isWizardStatus(statusRaw)) {
      result.status = statusRaw;
    }
    if (typeof errorRaw === "string" && errorRaw.trim()) {
      result.error = errorRaw;
    }

    const parsedStep = this.parseWizardStep(stepRaw);
    if (parsedStep) {
      result.step = parsedStep;
    }

    return result;
  }

  private parseWizardStatus(payload: unknown): OnboardingWizardStatusResult {
    if (!payload || typeof payload !== "object") {
      throw new ClawNowServiceError(
        "WIZARD_PAYLOAD_INVALID",
        "Invalid onboarding wizard status payload",
        502,
      );
    }
    const statusRaw = (payload as { status?: unknown }).status;
    if (!this.isWizardStatus(statusRaw)) {
      throw new ClawNowServiceError(
        "WIZARD_PAYLOAD_INVALID",
        "Onboarding wizard status is missing",
        502,
      );
    }
    const errorRaw = (payload as { error?: unknown }).error;
    return {
      status: statusRaw,
      ...(typeof errorRaw === "string" && errorRaw.trim()
        ? {
            error: errorRaw,
          }
        : {}),
    };
  }

  private parseWizardStep(payload: unknown): OnboardingWizardStep | undefined {
    if (!payload || typeof payload !== "object") {
      return undefined;
    }
    const idRaw = (payload as { id?: unknown }).id;
    const typeRaw = (payload as { type?: unknown }).type;
    const id = typeof idRaw === "string" ? idRaw.trim() : "";
    if (!id || !this.isWizardStepType(typeRaw)) {
      return undefined;
    }

    const titleRaw = (payload as { title?: unknown }).title;
    const messageRaw = (payload as { message?: unknown }).message;
    const optionsRaw = (payload as { options?: unknown }).options;
    const placeholderRaw = (payload as { placeholder?: unknown }).placeholder;
    const sensitiveRaw = (payload as { sensitive?: unknown }).sensitive;
    const executorRaw = (payload as { executor?: unknown }).executor;
    const initialValue = (payload as { initialValue?: unknown }).initialValue;

    const options = Array.isArray(optionsRaw)
      ? optionsRaw
          .map((option) => {
            if (!option || typeof option !== "object") {
              return null;
            }
            const labelRaw = (option as { label?: unknown }).label;
            const hintRaw = (option as { hint?: unknown }).hint;
            if (typeof labelRaw !== "string" || !labelRaw.trim()) {
              return null;
            }
            return {
              value: (option as { value?: unknown }).value,
              label: labelRaw,
              ...(typeof hintRaw === "string" && hintRaw.trim()
                ? {
                    hint: hintRaw,
                  }
                : {}),
            } satisfies OnboardingWizardStepOption;
          })
          .filter((option): option is OnboardingWizardStepOption => option !== null)
      : undefined;

    return {
      id,
      type: typeRaw,
      ...(typeof titleRaw === "string" ? { title: titleRaw } : {}),
      ...(typeof messageRaw === "string" ? { message: messageRaw } : {}),
      ...(options && options.length > 0 ? { options } : {}),
      ...(initialValue !== undefined ? { initialValue } : {}),
      ...(typeof placeholderRaw === "string" ? { placeholder: placeholderRaw } : {}),
      ...(typeof sensitiveRaw === "boolean" ? { sensitive: sensitiveRaw } : {}),
      ...(executorRaw === "gateway" || executorRaw === "client"
        ? {
            executor: executorRaw,
          }
        : {}),
    };
  }

  private isWizardStatus(value: unknown): value is OnboardingWizardStatus {
    return value === "running" || value === "done" || value === "cancelled" || value === "error";
  }

  private isWizardStepType(value: unknown): value is OnboardingWizardStep["type"] {
    return (
      value === "note" ||
      value === "select" ||
      value === "text" ||
      value === "confirm" ||
      value === "multiselect" ||
      value === "progress" ||
      value === "action"
    );
  }

  private buildProvisioningMetadata(existing?: Record<string, unknown>): Record<string, unknown> {
    return {
      ...existing,
      trusted_proxy_mode: "trusted-proxy",
      onboarding_completed: false,
      onboarding_completed_at: null,
      onboarding_last_status: "pending",
    };
  }

  private isTerminalOnboardingCompleted(instance: ClawInstance): boolean {
    const metadata =
      instance.metadata && typeof instance.metadata === "object" ? instance.metadata : {};
    const directCompleted = (metadata as { onboarding_completed?: unknown }).onboarding_completed;
    if (typeof directCompleted === "boolean") {
      return directCompleted;
    }
    const completedAt = (metadata as { onboarding_completed_at?: unknown }).onboarding_completed_at;
    return typeof completedAt === "string" && completedAt.trim().length > 0;
  }

  private async updateOnboardingState(
    instance: ClawInstance,
    state: {
      completed: boolean;
      status: OnboardingWizardStatus;
    },
  ): Promise<ClawInstance> {
    const metadata =
      instance.metadata && typeof instance.metadata === "object" ? instance.metadata : {};
    return await this.updateInstance(instance.id, {
      metadata: {
        ...metadata,
        trusted_proxy_mode: "trusted-proxy",
        onboarding_completed: state.completed,
        onboarding_completed_at: state.completed ? new Date().toISOString() : null,
        onboarding_last_status: state.status,
      },
    });
  }

  private withQuery(baseUrl: string, query: Record<string, string>): string {
    const url = new URL(baseUrl);
    Object.entries(query).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    return url.toString();
  }

  private ensureTrailingSlash(baseUrl: string): string {
    const url = new URL(baseUrl);
    if (!url.pathname.endsWith("/")) {
      url.pathname = `${url.pathname}/`;
    }
    return url.toString();
  }

  private toWebSocketUrl(baseUrl: string): string {
    const url = new URL(baseUrl);
    if (url.protocol === "http:") {
      url.protocol = "ws:";
      return url.toString();
    }
    if (url.protocol === "https:") {
      url.protocol = "wss:";
      return url.toString();
    }
    throw new ClawNowServiceError(
      "INVALID_GATEWAY_URL",
      `Cannot derive websocket URL from protocol: ${url.protocol}`,
      500,
    );
  }

  private async requestGatewayMethod<T>(
    gatewayWebSocketUrl: string,
    token: string,
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    let lastError: unknown = null;
    let repaired = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.withGatewayConnection(
          gatewayWebSocketUrl,
          token,
          async (sendRequest) => {
            return (await sendRequest(method, params)) as T;
          },
          options,
        );
      } catch (error) {
        lastError = error;
        if (attempt < 3 && this.isGatewayHandshakeRaceError(error)) {
          await this.wait(120);
          continue;
        }
        if (attempt < 3 && options?.disableRepair) {
          // Avoid restarting the gateway while a wizard is running (sessions are in-memory).
          await this.wait(250 * attempt);
          continue;
        }
        if (!repaired && attempt < 3) {
          const reason = this.shouldAttemptGatewayRepair(error);
          if (reason) {
            repaired = await this.repairGatewayViaProxy({
              gatewayWebSocketUrl,
              token,
              reason,
            });
            if (repaired) {
              // Give systemd + proxy a beat to bring the gateway back before retrying.
              await this.wait(600);
              continue;
            }
          }
        }
        break;
      }
    }

    const error = lastError;
    if (
      error instanceof ClawNowServiceError &&
      error.code === "GATEWAY_REQUEST_FAILED" &&
      method === "wizard.next" &&
      /wizard not found|wizard not running/i.test(error.message)
    ) {
      throw new ClawNowServiceError(
        "WIZARD_SESSION_EXPIRED",
        "Setup wizard session expired. Please start cooking wizard again.",
        409,
      );
    }
    if (
      error instanceof ClawNowServiceError &&
      error.code === "GATEWAY_REQUEST_FAILED" &&
      /pairing required/i.test(error.message)
    ) {
      throw new ClawNowServiceError(
        "GATEWAY_PAIRING_REQUIRED",
        "This VM uses an older gateway pairing state. Click Recover VM to apply the latest bootstrap, then start setup again.",
        409,
      );
    }
    throw error;
  }

  private isGatewayHandshakeRaceError(error: unknown): boolean {
    if (!(error instanceof ClawNowServiceError)) {
      return false;
    }
    if (error.code !== "GATEWAY_REQUEST_FAILED" && error.code !== "GATEWAY_SOCKET_CLOSED") {
      return false;
    }
    return /invalid handshake|first request must be connect/i.test(error.message);
  }

  private shouldRecoverWizardNextByResync(error: unknown): boolean {
    if (!(error instanceof ClawNowServiceError)) {
      return false;
    }
    if (error.code === "GATEWAY_TIMEOUT") {
      return true;
    }
    if (error.code !== "GATEWAY_REQUEST_FAILED") {
      return false;
    }
    return /wizard:\s*no pending step/i.test(error.message);
  }

  private isUnsupportedWizardStartProfileError(error: unknown): boolean {
    if (!(error instanceof ClawNowServiceError)) {
      return false;
    }
    if (error.code !== "GATEWAY_REQUEST_FAILED") {
      return false;
    }
    return (
      /invalid wizard\.start params/i.test(error.message) &&
      /unexpected property ['"]?profile['"]?/i.test(error.message)
    );
  }

  private extractLatestOpenAiOAuthUrl(lines: string[]): string | null {
    if (lines.length === 0) {
      return null;
    }

    const markerPattern = /(open this url in your local browser|open:\s*https?:\/\/)/i;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = this.stripAnsi(lines[index] || "").trim();
      if (!markerPattern.test(line)) {
        continue;
      }

      for (let probe = index; probe <= Math.min(lines.length - 1, index + 4); probe += 1) {
        const candidate = this.extractLikelyOpenAiOAuthUrl(lines[probe] || "");
        if (candidate) {
          return candidate;
        }
      }
    }

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = this.extractLikelyOpenAiOAuthUrl(lines[index] || "");
      if (candidate) {
        return candidate;
      }
    }

    return null;
  }

  private stripAnsi(value: string): string {
    // Avoid regex literals with control characters (oxlint no-control-regex).
    const esc = String.fromCharCode(27);
    return value.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
  }

  private extractLikelyOpenAiOAuthUrl(line: string): string | null {
    const normalized = this.stripAnsi(line);
    const matches = normalized.match(/https?:\/\/[^\s"'<>]+/g);
    if (!matches || matches.length === 0) {
      return null;
    }

    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const candidate = matches[index]?.replace(/[)\],.;]+$/g, "") || "";
      const parsed = this.parseHttpUrl(candidate);
      if (!parsed) {
        continue;
      }
      if (this.isLikelyOpenAiOAuthUrl(parsed, candidate)) {
        return parsed.toString();
      }
    }

    return null;
  }

  private parseHttpUrl(raw: string): URL | null {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private isLikelyOpenAiOAuthUrl(url: URL, raw: string): boolean {
    const hostname = url.hostname.toLowerCase();
    if (hostname.includes("openai.com") || hostname.includes("chatgpt.com")) {
      return true;
    }

    const redirectUri = url.searchParams.get("redirect_uri");
    if (redirectUri && /localhost:1455\/auth\/callback/i.test(redirectUri)) {
      return true;
    }

    return /localhost%3A1455%2Fauth%2Fcallback/i.test(raw);
  }

  private async patchGatewayConfig(
    gatewayWebSocketUrl: string,
    token: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    let lastError: unknown = null;
    let repaired = false;
    for (let attempt = 1; attempt <= GATEWAY_CONFIG_PATCH_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.patchGatewayConfigOnce(gatewayWebSocketUrl, token, patch);
        return;
      } catch (error) {
        lastError = error;
        if (!repaired) {
          const reason = this.shouldAttemptGatewayRepair(error);
          if (reason) {
            repaired = await this.repairGatewayViaProxy({
              gatewayWebSocketUrl,
              token,
              reason,
            });
            if (repaired) {
              await this.wait(800);
              continue;
            }
          }
        }
        const shouldRetry =
          attempt < GATEWAY_CONFIG_PATCH_MAX_ATTEMPTS && this.shouldRetryGatewayConfigPatch(error);
        if (!shouldRetry) {
          break;
        }
        await this.wait(GATEWAY_CONFIG_PATCH_RETRY_DELAY_MS * attempt);
      }
    }

    throw lastError instanceof ClawNowServiceError
      ? lastError
      : new ClawNowServiceError(
          "GATEWAY_CONFIG_PATCH_FAILED",
          `Failed to patch gateway config: ${safeErrorMessage(lastError)}`,
          502,
        );
  }

  private shouldRetryGatewayConfigPatch(error: unknown): boolean {
    if (!(error instanceof ClawNowServiceError)) {
      return true;
    }
    return new Set([
      "GATEWAY_CONNECT_FAILED",
      "GATEWAY_SOCKET_CLOSED",
      "GATEWAY_TIMEOUT",
      "GATEWAY_REQUEST_FAILED",
      "GATEWAY_CONFIG_PATCH_FAILED",
    ]).has(error.code);
  }

  private async wait(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private async patchGatewayConfigOnce(
    gatewayWebSocketUrl: string,
    token: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.withGatewayConnection(gatewayWebSocketUrl, token, async (sendRequest) => {
        const snapshot = (await sendRequest("config.get", {})) as {
          hash?: string | null;
        };
        const baseHash = typeof snapshot?.hash === "string" ? snapshot.hash : "";
        if (!baseHash) {
          throw new ClawNowServiceError(
            "GATEWAY_CONFIG_HASH_MISSING",
            "Gateway config hash missing",
            502,
          );
        }
        await sendRequest("config.patch", {
          raw: JSON.stringify(patch, null, 2),
          baseHash,
        });
      });
    } catch (error) {
      throw error instanceof ClawNowServiceError
        ? error
        : new ClawNowServiceError(
            "GATEWAY_CONFIG_PATCH_FAILED",
            `Failed to patch gateway config: ${safeErrorMessage(error)}`,
            502,
          );
    }
  }

  private async withGatewayConnection<T>(
    gatewayWebSocketUrl: string,
    token: string,
    operation: (sendRequest: GatewayRequestSender) => Promise<T>,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    let ws: WebSocket;
    try {
      ws = new WebSocket(gatewayWebSocketUrl);
    } catch (error) {
      throw new ClawNowServiceError(
        "GATEWAY_CONNECT_FAILED",
        `Failed to connect gateway websocket: ${safeErrorMessage(error)}`,
        502,
      );
    }

    let connectSent = false;
    let connectNonce: string | null = null;
    let challengeResolved = false;
    let settled = false;
    const pending = new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
      }
    >();
    let resolveChallenge: (() => void) | null = null;
    let rejectChallenge: ((error: unknown) => void) | null = null;
    const challengePromise = new Promise<void>((resolve, reject) => {
      resolveChallenge = () => {
        if (challengeResolved) {
          return;
        }
        challengeResolved = true;
        resolve();
      };
      rejectChallenge = (error) => {
        if (challengeResolved) {
          return;
        }
        challengeResolved = true;
        reject(error);
      };
    });

    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    let openSettled = false;
    let resolveOpen: (() => void) | null = null;
    let rejectOpen: ((error: unknown) => void) | null = null;
    const openPromise = new Promise<void>((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });

    const handleOpen = () => {
      if (openSettled) {
        return;
      }
      openSettled = true;
      resolveOpen?.();
    };

    const handleError = () => {
      // Only treat errors as fatal before the initial open handshake.
      if (openSettled) {
        return;
      }
      openSettled = true;
      rejectOpen?.(
        new ClawNowServiceError("GATEWAY_CONNECT_FAILED", "Gateway websocket failed to open", 502),
      );
    };

    const failAllPending = (error: unknown) => {
      for (const request of pending.values()) {
        request.reject(error);
      }
      pending.clear();
    };

    const sendRequest = async (method: string, params?: unknown): Promise<unknown> => {
      const requestId = randomUUID();
      const payload = JSON.stringify({ type: "req", id: requestId, method, params });
      if (ws.readyState !== WebSocket.OPEN) {
        throw new ClawNowServiceError(
          "GATEWAY_CONNECT_FAILED",
          "Gateway websocket is not open",
          502,
        );
      }
      return await new Promise<unknown>((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        ws.send(payload);
      });
    };

    const sendConnect = async () => {
      if (connectSent) {
        return;
      }
      const nonce = connectNonce?.trim();
      if (!nonce) {
        throw new ClawNowServiceError(
          "GATEWAY_REQUEST_FAILED",
          "Gateway connect challenge missing nonce",
          502,
        );
      }
      connectSent = true;
      const scopes = ["operator.admin", "operator.approvals", "operator.pairing"];
      await sendRequest("connect", {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "gateway-client",
          version: "clawnow-control-plane",
          platform: "server",
          mode: "backend",
        },
        role: "operator",
        scopes,
        device: this.buildGatewayDeviceAuth({
          nonce,
          role: "operator",
          clientId: "gateway-client",
          clientMode: "backend",
          scopes,
          token,
        }),
        auth: { token },
        locale: "en-US",
      });
    };

    const handleMessage = (event: MessageEvent) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(event.data ?? ""));
      } catch {
        return;
      }

      if (
        frame &&
        typeof frame === "object" &&
        (frame as GatewayEventFrame).type === "event" &&
        (frame as GatewayEventFrame).event === "connect.challenge"
      ) {
        const payload = (frame as GatewayEventFrame).payload;
        const maybeNonce =
          payload &&
          typeof payload === "object" &&
          typeof (payload as { nonce?: unknown }).nonce === "string";
        if (maybeNonce) {
          connectNonce = String((payload as { nonce: string }).nonce).trim();
          resolveChallenge?.();
        }
        return;
      }

      if (!frame || typeof frame !== "object" || (frame as GatewayResponseFrame).type !== "res") {
        return;
      }

      const response = frame as GatewayResponseFrame;
      const request = pending.get(response.id);
      if (!request) {
        return;
      }
      pending.delete(response.id);
      if (response.ok) {
        request.resolve(response.payload);
        return;
      }

      request.reject(
        new ClawNowServiceError(
          "GATEWAY_REQUEST_FAILED",
          response.error?.message || response.error?.code || "Gateway request failed",
          502,
        ),
      );
    };

    const handleClose = (event: CloseEvent) => {
      settle(() => {
        cleanup();
        const closeError = new ClawNowServiceError(
          "GATEWAY_SOCKET_CLOSED",
          `Gateway websocket closed: ${event.code} ${event.reason || ""}`.trim(),
          502,
        );
        rejectChallenge?.(closeError);
        failAllPending(closeError);
      });
    };

    const cleanup = () => {
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("error", handleError);
      ws.removeEventListener("message", handleMessage);
      ws.removeEventListener("close", handleClose);
    };

    ws.addEventListener("open", handleOpen);
    ws.addEventListener("error", handleError);
    ws.addEventListener("message", handleMessage);
    ws.addEventListener("close", handleClose);

    const timeoutMs = options?.timeoutMs ?? GATEWAY_WS_TIMEOUT_MS;
    const timeoutHandle = setTimeout(() => {
      settle(() => {
        cleanup();
        const timeoutError = new ClawNowServiceError(
          "GATEWAY_TIMEOUT",
          "Gateway request timed out",
          504,
        );
        rejectChallenge?.(timeoutError);
        failAllPending(timeoutError);
        try {
          ws.close();
        } catch {}
      });
    }, timeoutMs);

    try {
      try {
        await openPromise;
      } catch {
        const diagnosis = await this.diagnoseGatewayWebSocketOpenFailure(gatewayWebSocketUrl);
        throw new ClawNowServiceError(
          "GATEWAY_CONNECT_FAILED",
          `Gateway websocket failed to open (${diagnosis})`,
          502,
        );
      }
      await challengePromise;
      await sendConnect();
      return await operation(sendRequest);
    } catch (error) {
      throw error instanceof ClawNowServiceError
        ? error
        : new ClawNowServiceError("GATEWAY_REQUEST_FAILED", safeErrorMessage(error), 502);
    } finally {
      clearTimeout(timeoutHandle);
      settle(() => {
        cleanup();
        failAllPending(new Error("Gateway socket finalized"));
      });
      try {
        ws.close();
      } catch {}
    }
  }

  private resolveGatewayDeviceIdentity(): GatewayDeviceIdentity {
    const configuredPrivateKeyPem = this.readConfiguredGatewayDevicePrivateKeyPem();
    if (configuredPrivateKeyPem) {
      try {
        const privateKey = createPrivateKey(configuredPrivateKeyPem);
        const publicKeyPem = createPublicKey(privateKey)
          .export({ type: "spki", format: "pem" })
          .toString();
        const publicKeyRaw = this.derivePublicKeyRaw(publicKeyPem);
        const deviceId = createHash("sha256").update(publicKeyRaw).digest("hex");
        return {
          deviceId,
          publicKeyBase64Url: publicKeyRaw.toString("base64url"),
          privateKeyPem: configuredPrivateKeyPem,
        };
      } catch (error) {
        throw new ClawNowServiceError(
          "CONFIG_INVALID",
          `Invalid CLAWNOW_GATEWAY_DEVICE_PRIVATE_KEY_* value: ${safeErrorMessage(error)}`,
          503,
        );
      }
    }
    return this.generateGatewayDeviceIdentity();
  }

  private readConfiguredGatewayDevicePrivateKeyPem(): string | null {
    const pemRaw = process.env.CLAWNOW_GATEWAY_DEVICE_PRIVATE_KEY_PEM?.trim();
    if (pemRaw) {
      // Support env values where newlines are escaped as "\n".
      return pemRaw.includes("\\n") ? pemRaw.replace(/\\n/g, "\n") : pemRaw;
    }

    const base64Raw = process.env.CLAWNOW_GATEWAY_DEVICE_PRIVATE_KEY_B64?.trim();
    if (!base64Raw) {
      return null;
    }
    try {
      const decoded = Buffer.from(base64Raw, "base64").toString("utf8").trim();
      if (!decoded) {
        throw new Error("decoded key is empty");
      }
      return decoded.includes("\\n") ? decoded.replace(/\\n/g, "\n") : decoded;
    } catch (error) {
      throw new ClawNowServiceError(
        "CONFIG_INVALID",
        `Invalid CLAWNOW_GATEWAY_DEVICE_PRIVATE_KEY_B64 value: ${safeErrorMessage(error)}`,
        503,
      );
    }
  }

  private generateGatewayDeviceIdentity(): GatewayDeviceIdentity {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyRaw = this.derivePublicKeyRaw(publicKeyPem);
    const deviceId = createHash("sha256").update(publicKeyRaw).digest("hex");
    return {
      deviceId,
      publicKeyBase64Url: publicKeyRaw.toString("base64url"),
      privateKeyPem,
    };
  }

  private derivePublicKeyRaw(publicKeyPem: string): Buffer {
    const publicKeyDer = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
    const derBuffer = Buffer.isBuffer(publicKeyDer) ? publicKeyDer : Buffer.from(publicKeyDer);
    if (
      derBuffer.length === ED25519_SPKI_PREFIX.length + 32 &&
      derBuffer.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ) {
      return derBuffer.subarray(ED25519_SPKI_PREFIX.length);
    }
    return derBuffer;
  }

  private buildGatewayDeviceAuth(params: {
    nonce: string;
    token: string;
    role: string;
    clientId: string;
    clientMode: string;
    scopes: string[];
  }): {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce: string;
  } {
    const signedAt = Date.now();
    const payload = [
      "v2",
      this.gatewayDeviceIdentity.deviceId,
      params.clientId,
      params.clientMode,
      params.role,
      params.scopes.join(","),
      String(signedAt),
      params.token,
      params.nonce,
    ].join("|");
    const signature = signPayload(
      null,
      Buffer.from(payload, "utf8"),
      createPrivateKey(this.gatewayDeviceIdentity.privateKeyPem),
    ).toString("base64url");

    return {
      id: this.gatewayDeviceIdentity.deviceId,
      publicKey: this.gatewayDeviceIdentity.publicKeyBase64Url,
      signature,
      signedAt,
      nonce: params.nonce,
    };
  }

  private async probeGatewayReadiness(
    gatewayUrl: string | null,
  ): Promise<{ ready: boolean; reason?: string }> {
    if (!gatewayUrl) {
      return { ready: false, reason: "Gateway URL missing" };
    }

    const healthUrl = joinUrl(gatewayUrl, GATEWAY_HEALTH_PATH);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GATEWAY_HEALTH_TIMEOUT_MS);

    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "user-agent": "clawnow-control-plane/gateway-health-probe",
        },
      });

      if (!response.ok) {
        let payload: { error?: string; code?: string } = {};
        try {
          payload = (await response.json()) as { error?: string; code?: string };
        } catch {
          payload = {};
        }
        const legacyMode = await this.detectLegacyHttpGatewayMode(gatewayUrl);
        if (legacyMode) {
          return { ready: false, reason: LEGACY_HTTP_GATEWAY_REASON };
        }
        const reason = payload.error?.trim();
        return {
          ready: false,
          reason: reason
            ? `Gateway health returned HTTP ${response.status}: ${reason}`
            : `Gateway health returned HTTP ${response.status}`,
        };
      }

      let payload: { success?: boolean } = {};
      try {
        payload = (await response.json()) as { success?: boolean };
      } catch {
        payload = {};
      }

      if (payload.success === false) {
        return { ready: false, reason: "Gateway health payload is not ready" };
      }

      return { ready: true };
    } catch (error) {
      if (isAbortError(error)) {
        return { ready: false, reason: "Gateway health probe timed out" };
      }
      const legacyMode = await this.detectLegacyHttpGatewayMode(gatewayUrl);
      if (legacyMode) {
        return { ready: false, reason: LEGACY_HTTP_GATEWAY_REASON };
      }
      return { ready: false, reason: safeErrorMessage(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async detectLegacyHttpGatewayMode(gatewayUrl: string): Promise<boolean> {
    const legacyUrl = this.toLegacyHttpGatewayUrl(gatewayUrl);
    if (!legacyUrl) {
      return false;
    }

    const healthUrl = joinUrl(legacyUrl, GATEWAY_HEALTH_PATH);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "user-agent": "clawnow-control-plane/legacy-probe",
        },
      });
      if (!response.ok) {
        return false;
      }
      let payload: { success?: boolean } = {};
      try {
        payload = (await response.json()) as { success?: boolean };
      } catch {
        payload = {};
      }
      return payload.success !== false;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private toLegacyHttpGatewayUrl(gatewayUrl: string): string | null {
    try {
      const parsed = new URL(gatewayUrl);
      if (parsed.protocol !== "https:") {
        return null;
      }
      if (!parsed.hostname.endsWith(".sslip.io")) {
        return null;
      }
      const ip = parsed.hostname.slice(0, -".sslip.io".length);
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        return null;
      }
      return `http://${ip}:18790`;
    } catch {
      return null;
    }
  }

  private async ensureControlUiLaunchable(
    instance: ClawInstance,
    launchUrl: string,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONTROL_UI_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(launchUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "clawnow-control-plane/health-probe",
        },
      });

      if (response.ok) {
        return;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        return;
      }

      let payload: { error?: string; code?: string } = {};
      try {
        payload = (await response.json()) as { error?: string; code?: string };
      } catch {
        payload = {};
      }

      const isUpstreamBootingError =
        response.status >= 500 ||
        payload.code === "upstream_error" ||
        payload.error?.includes("ECONNREFUSED") === true;

      if (isUpstreamBootingError) {
        await this.updateInstance(instance.id, {
          status: "provisioning",
          last_error: "OpenClaw services are still booting on your VM. Please retry shortly.",
        });
        throw new ClawNowServiceError(
          "INSTANCE_BOOTING",
          "VM is online, but OpenClaw is still starting (usually 1-3 minutes on first boot). Please retry in a moment.",
          409,
        );
      }

      throw new ClawNowServiceError(
        "CONTROL_UI_UNAVAILABLE",
        payload.error || `Control UI probe failed with HTTP ${response.status}`,
        502,
      );
    } catch (error) {
      if (error instanceof ClawNowServiceError) {
        throw error;
      }

      const bootingMessage = isAbortError(error)
        ? "VM is online, but OpenClaw startup is still in progress. Please retry in a moment."
        : "OpenClaw endpoint is not reachable yet. Please retry in a moment.";

      await this.updateInstance(instance.id, {
        status: "provisioning",
        last_error: "OpenClaw services are still booting on your VM. Please retry shortly.",
      });

      throw new ClawNowServiceError("INSTANCE_BOOTING", bootingMessage, 409);
    } finally {
      clearTimeout(timeout);
    }
  }

  private renderCloudInit(userId: string, instanceId: string): string {
    let rendered: string;

    if (this.config.defaultCloudInit) {
      rendered = this.config.defaultCloudInit
        .replaceAll("{{USER_ID}}", userId)
        .replaceAll("{{INSTANCE_ID}}", instanceId)
        .replaceAll("{{GATEWAY_BASE_URL}}", this.config.gatewayBaseUrl || "")
        .replaceAll("{{PROXY_SHARED_SECRET}}", this.config.proxySharedSecret)
        .replaceAll("{{CONTROL_UI_PATH}}", this.config.controlUiPath)
        .replaceAll("{{NOVNC_PATH}}", this.config.novncPath);
    } else if (this.config.openClawBootstrapCommand) {
      const bootstrapCommandRaw = this.config.openClawBootstrapCommand
        .replaceAll("{{USER_ID}}", userId)
        .replaceAll("{{INSTANCE_ID}}", instanceId)
        .replaceAll("{{GATEWAY_BASE_URL}}", this.config.gatewayBaseUrl || "")
        .replaceAll("{{PROXY_SHARED_SECRET}}", this.config.proxySharedSecret)
        .replaceAll("{{CONTROL_UI_PATH}}", this.config.controlUiPath)
        .replaceAll("{{NOVNC_PATH}}", this.config.novncPath);
      rendered = this.buildCompactBootstrapCloudInit(bootstrapCommandRaw, userId, instanceId);
    } else {
      rendered = this.buildCompactBootstrapCloudInit(
        this.buildDefaultBootstrapCommand(instanceId),
        userId,
        instanceId,
      );
    }

    if (rendered.length > CLAWNOW_CLOUD_INIT_MAX_BYTES) {
      throw new ClawNowServiceError(
        "CLOUD_INIT_TOO_LARGE",
        "Cloud-init payload is too large for Hetzner API. Configure CLAWNOW_OPENCLAW_BOOTSTRAP_COMMAND or CLAWNOW_HETZNER_CLOUD_INIT with a lighter script.",
        400,
      );
    }
    return rendered;
  }

  private buildCompactBootstrapCloudInit(
    bootstrapCommandRaw: string,
    userId: string,
    instanceId: string,
  ): string {
    const bootstrapCommand = `bash -lc '${escapeForSingleQuotedBash(bootstrapCommandRaw)}'`;
    return `#cloud-config
package_update: true
packages:
  - curl
  - ca-certificates
runcmd:
  - ${bootstrapCommand}
  - echo "ClawNow bootstrap user=${userId} instance=${instanceId}" > /var/log/clawnow-bootstrap.log
`;
  }

  private buildDefaultBootstrapCommand(instanceId: string): string {
    const { bootstrapScriptUrl, proxyScriptUrl, controlUiUpdaterScriptUrl } =
      this.resolveBootstrapScriptUrls();
    const controlPrefix = `/${this.config.controlUiPath}`;
    const noVncPrefix = `/${this.config.novncPath}`;
    const usePublicHttpGateway = this.usesPublicHttpGatewayTemplate();
    const proxyBind = usePublicHttpGateway ? "0.0.0.0" : "127.0.0.1";
    return [
      `curl -fsSL ${bootstrapScriptUrl}`,
      "| bash -s --",
      `--proxy-secret '${this.config.proxySharedSecret}'`,
      `--proxy-bind ${proxyBind}`,
      "--proxy-port 18790",
      "--gateway-port 18789",
      `--control-prefix '${controlPrefix}'`,
      `--novnc-prefix '${noVncPrefix}'`,
      `--instance-id '${instanceId}'`,
      `--gateway-origin-template '${this.config.instanceGatewayTemplate}'`,
      `--control-plane-device-id '${this.gatewayDeviceIdentity.deviceId}'`,
      `--control-plane-device-public-key '${this.gatewayDeviceIdentity.publicKeyBase64Url}'`,
      ...(this.config.controlUiAllowedOrigin
        ? [`--control-ui-origin '${this.config.controlUiAllowedOrigin}'`]
        : []),
      `--proxy-script-url '${proxyScriptUrl}'`,
      ...(this.config.controlUiManifestUrl
        ? [
            `--control-ui-manifest-url '${this.config.controlUiManifestUrl}'`,
            `--control-ui-updater-script-url '${controlUiUpdaterScriptUrl}'`,
          ]
        : []),
      ...(usePublicHttpGateway ? ["--disable-https"] : []),
    ].join(" ");
  }

  private resolveBootstrapScriptUrls(): {
    bootstrapScriptUrl: string;
    proxyScriptUrl: string;
    controlUiUpdaterScriptUrl: string;
  } {
    if (this.config.bootstrapAssetBaseUrl) {
      return {
        bootstrapScriptUrl: joinUrl(this.config.bootstrapAssetBaseUrl, LOCAL_BOOTSTRAP_SCRIPT_PATH),
        proxyScriptUrl: joinUrl(this.config.bootstrapAssetBaseUrl, LOCAL_PROXY_SCRIPT_PATH),
        controlUiUpdaterScriptUrl: joinUrl(
          this.config.bootstrapAssetBaseUrl,
          LOCAL_CONTROL_UI_UPDATER_SCRIPT_PATH,
        ),
      };
    }
    return {
      bootstrapScriptUrl: DEFAULT_BOOTSTRAP_SCRIPT_URL,
      proxyScriptUrl: DEFAULT_PROXY_SCRIPT_URL,
      controlUiUpdaterScriptUrl: DEFAULT_CONTROL_UI_UPDATER_SCRIPT_URL,
    };
  }

  private usesPublicHttpGatewayTemplate(): boolean {
    const sample = this.config.instanceGatewayTemplate
      .replaceAll("{{IPV4}}", "127.0.0.1")
      .replaceAll("{{INSTANCE_ID}}", "instance")
      .replaceAll("{{SERVER_ID}}", "1");
    try {
      const parsed = new URL(sample);
      return parsed.protocol === "http:";
    } catch {
      return false;
    }
  }

  private mapHetznerStatus(status: string): ClawInstanceStatus {
    const normalized = status.toLowerCase();
    if (normalized === "running") {
      return "running";
    }
    if (normalized === "off") {
      return "stopped";
    }
    if (normalized === "deleting") {
      return "deleting";
    }
    if (normalized === "stopping" || normalized === "migrating") {
      return "recovering";
    }
    if (normalized === "starting" || normalized === "initializing" || normalized === "rebuilding") {
      return "provisioning";
    }
    return "error";
  }

  private isProvisioningStale(value: string): boolean {
    const startedAt = new Date(value).getTime();
    if (!Number.isFinite(startedAt)) {
      return true;
    }
    return Date.now() - startedAt > this.config.provisioningTimeoutSeconds * 1000;
  }

  private async normalizeDetachedInstance(instance: ClawInstance): Promise<ClawInstance> {
    if (
      instance.status === "provisioning" ||
      instance.status === "terminated" ||
      instance.status === "deleting"
    ) {
      return instance;
    }

    const fallbackMessage =
      instance.last_error?.trim() || "No active VM found. Deploy a new Claw to continue.";
    return this.updateInstance(instance.id, {
      status: "terminated",
      gateway_url: null,
      control_ui_url: null,
      novnc_url: null,
      provisioned_at: null,
      novnc_enabled_until: null,
      last_heartbeat_at: new Date().toISOString(),
      last_error: fallbackMessage,
    });
  }

  private normalizeProviderError(error: unknown): ClawNowServiceError {
    if (error instanceof ClawNowServiceError) {
      return error;
    }
    if (error instanceof HetznerApiError) {
      if (error.status === 401 || error.status === 403) {
        return new ClawNowServiceError(
          "HETZNER_AUTH_FAILED",
          "Hetzner API authentication failed. Check CLAWNOW_HETZNER_API_TOKEN.",
          503,
        );
      }
      const normalized = JSON.stringify(error.details || {});
      const message = `${error.message} ${normalized}`.toLowerCase();
      if (message.includes("user_data")) {
        return new ClawNowServiceError(
          "HETZNER_USER_DATA_REJECTED",
          "Hetzner rejected user_data. Bootstrap payload is too large or malformed. Keep CLAWNOW_HETZNER_CLOUD_INIT empty, then deploy again.",
          422,
        );
      }
      return new ClawNowServiceError("HETZNER_ERROR", error.message, 502);
    }
    return new ClawNowServiceError("PROVISION_FAILED", safeErrorMessage(error), 500);
  }

  private isProviderServerMissing(error: unknown): boolean {
    return error instanceof HetznerApiError && error.status === 404;
  }

  private async markInstanceTerminated(
    instance: ClawInstance,
    userId: string,
    reason: string,
  ): Promise<ClawInstance> {
    const metadata = {
      ...instance.metadata,
      externally_deleted_at: new Date().toISOString(),
    };

    const updated = await this.updateInstance(instance.id, {
      status: "terminated",
      hetzner_server_id: null,
      ipv4: null,
      ipv6: null,
      gateway_url: null,
      control_ui_url: null,
      novnc_url: null,
      provisioned_at: null,
      last_heartbeat_at: new Date().toISOString(),
      last_error: "This VM was deleted externally. Deploy a new VM to continue.",
      metadata,
    });

    await this.logEvent(
      updated.id,
      userId,
      "instance.terminated",
      reason,
      {
        reason,
        previousHetznerServerId: instance.hetzner_server_id,
      },
      "warn",
    );

    return updated;
  }

  private async logEvent(
    instanceId: string,
    userId: string,
    eventType: string,
    message: string,
    payload: Record<string, unknown> = {},
    level: "info" | "warn" | "error" = "info",
  ): Promise<void> {
    const { error } = await supabaseAdmin.from("claw_instance_events").insert({
      instance_id: instanceId,
      user_id: userId,
      event_type: eventType,
      level,
      message,
      payload,
    });

    if (error) {
      console.error("[ClawNow] Failed to persist event", {
        instanceId,
        eventType,
        error: error.message,
      });
    }
  }
}
