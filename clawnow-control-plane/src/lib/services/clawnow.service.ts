import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
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

export interface ClawWorkspaceBillingSummary {
  status: "ok" | "unavailable";
  currency: "USD";
  organizationMembershipCount: number;
  organizationSubscriptionCount: number;
  organizationPrepaidBalance: number;
  message?: string;
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

interface OrganizationMembershipRow {
  organization_id: string;
}

interface OrganizationSubscriptionBalanceRow {
  id: string;
  organization_id: string | null;
  prepaid_balance: number | null;
  created_at: string;
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
  openClawVersion: string | null;
}

interface GatewayDeviceIdentity {
  deviceId: string;
  publicKeyBase64Url: string;
  privateKeyPem: string;
}

const DEFAULT_PROVISIONING_TIMEOUT_SECONDS = 15 * 60;
const GATEWAY_HEALTH_TIMEOUT_MS = 8000;
const GATEWAY_LAUNCH_PROBE_TIMEOUT_MS = 12000;
const GATEWAY_WS_TIMEOUT_MS = 20_000;
const GATEWAY_DIAGNOSE_PROBE_TIMEOUT_MS = 8_000;
const GATEWAY_CONFIG_PATCH_MAX_ATTEMPTS = 3;
const GATEWAY_CONFIG_PATCH_RETRY_DELAY_MS = 400;
const GATEWAY_HEALTH_PATH = "__clawnow/health";
const GATEWAY_REPAIR_PATH = "__clawnow/repair/gateway";
const GATEWAY_UPSTREAM_BOOT_TIMEOUT_MS = 7 * 60 * 1000;
const GATEWAY_UNVERIFIED_READY_GRACE_MS = 3 * 60 * 1000;
const GATEWAY_WARMUP_RETRY_WINDOW_MS = 45 * 1000;
const GATEWAY_WARMUP_RETRY_BACKOFF_BASE_MS = 1000;
const GATEWAY_WARMUP_RETRY_BACKOFF_MAX_MS = 5000;
const LEGACY_HTTP_GATEWAY_REASON = "legacy_http_gateway_detected";
const CLAWNOW_CLOUD_INIT_MAX_BYTES = 16000;
const OPENAI_PROVIDER_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const OPENAI_CODEX_PROVIDER_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_DEFAULT_MODEL = "openai/gpt-5.1-codex";
const OPENAI_CODEX_DEFAULT_MODEL = "openai-codex/gpt-5.3-codex";
const OPENAI_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_CODEX_OAUTH_SCOPE = "openid profile email offline_access";
const OPENAI_CODEX_OAUTH_ORIGINATOR = "pi";
const OPENAI_CODEX_OAUTH_SESSION_TTL_MS = 30 * 60 * 1000;
const OPENAI_MEMORY_EMBED_MODEL = "text-embedding-3-small";
const CLAWNOW_DEFAULT_OPENCLAW_VERSION = "2026.2.23";
const CLAWNOW_DEFAULT_CHANNEL_IDS = ["telegram", "whatsapp"] as const;
const DEFAULT_MAIN_SESSION_KEY = "main";
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

interface GatewayReadinessProbeResult {
  ready: boolean;
  reason?: string;
  code?: string;
  openclawUpstreamReady?: boolean;
  openclawUpstreamError?: string;
}

interface OnboardingCodexOAuthState {
  sessionId: string;
  state: string;
  verifier: string;
  authUrl: string;
  createdAtMs: number;
  accessToken?: string;
}

interface ParsedCodexCallbackInput {
  code: string | null;
  state: string | null;
  error: string | null;
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

function clampPort(value: number, fallback: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value) : fallback;
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 65535) {
    return fallback;
  }
  return normalized;
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

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asTrimmedStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
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
    openClawVersion: getOptionalEnv("CLAWNOW_OPENCLAW_VERSION") || CLAWNOW_DEFAULT_OPENCLAW_VERSION,
  };
}

function isUniqueViolation(error: PostgrestError | null): boolean {
  return Boolean(error && error.code === "23505");
}

function isSchemaAvailabilityError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const payload = error as Partial<PostgrestError>;
  const code = typeof payload.code === "string" ? payload.code : "";
  if (code === "42P01" || code === "42703" || code === "PGRST204" || code === "PGRST205") {
    return true;
  }
  const message = [
    typeof payload.message === "string" ? payload.message : "",
    typeof payload.details === "string" ? payload.details : "",
    typeof payload.hint === "string" ? payload.hint : "",
  ]
    .join(" ")
    .toLowerCase();

  return message.includes("does not exist") || message.includes("could not find");
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
      openClawVersion: this.config.openClawVersion || undefined,
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

  async getWorkspaceBillingSummary(userId: string): Promise<ClawWorkspaceBillingSummary> {
    const baseSummary: ClawWorkspaceBillingSummary = {
      status: "ok",
      currency: "USD",
      organizationMembershipCount: 0,
      organizationSubscriptionCount: 0,
      organizationPrepaidBalance: 0,
    };

    try {
      const { data: memberships, error: membershipError } = await supabaseAdmin
        .from("organization_members")
        .select("organization_id")
        .eq("user_id", userId);

      if (membershipError) {
        throw membershipError;
      }

      const organizationIds = Array.from(
        new Set(
          ((memberships as OrganizationMembershipRow[] | null) || [])
            .map((row) => row.organization_id)
            .filter((organizationId): organizationId is string =>
              typeof organizationId === "string" ? organizationId.trim().length > 0 : false,
            ),
        ),
      );

      if (organizationIds.length === 0) {
        return baseSummary;
      }

      const { data: subscriptions, error: subscriptionsError } = await supabaseAdmin
        .from("subscriptions")
        .select("id, organization_id, prepaid_balance, created_at")
        .in("organization_id", organizationIds)
        .eq("product_id", "createnow")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(100);

      if (subscriptionsError) {
        throw subscriptionsError;
      }

      // One organization should map to one active CreateNow balance.
      // If duplicate rows exist, keep the most recently created record.
      const latestBalancePerOrg = new Map<string, number>();
      for (const row of (subscriptions as OrganizationSubscriptionBalanceRow[] | null) || []) {
        if (!row.organization_id || latestBalancePerOrg.has(row.organization_id)) {
          continue;
        }
        const prepaidBalance = Number(row.prepaid_balance);
        latestBalancePerOrg.set(
          row.organization_id,
          Number.isFinite(prepaidBalance) ? prepaidBalance : 0,
        );
      }

      const organizationPrepaidBalance = Array.from(latestBalancePerOrg.values()).reduce(
        (total, balance) => total + balance,
        0,
      );

      return {
        ...baseSummary,
        organizationMembershipCount: organizationIds.length,
        organizationSubscriptionCount: latestBalancePerOrg.size,
        organizationPrepaidBalance,
      };
    } catch (error) {
      const schemaNotReady = isSchemaAvailabilityError(error);
      if (!schemaNotReady) {
        console.error("[ClawNow] Failed to load organization prepaid balance", {
          userId,
          error: safeErrorMessage(error),
        });
      }

      return {
        ...baseSummary,
        status: "unavailable",
        message: schemaNotReady
          ? "Organization billing data is not initialized yet."
          : "Organization billing data is temporarily unavailable.",
      };
    }
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
        let gatewayProbe = await this.probeGatewayReadiness(gatewayUrl);
        const everReady = Boolean(current.provisioned_at);

        if (
          !gatewayProbe.ready &&
          !everReady &&
          gatewayUrl !== null &&
          this.shouldAttemptAutoGatewayRepair(current, gatewayProbe)
        ) {
          const repaired = await this.tryAutoRepairGateway(current, userId, gatewayUrl);
          if (repaired) {
            await this.wait(700);
            gatewayProbe = await this.probeGatewayReadiness(gatewayUrl);
          }
        }

        if (!gatewayProbe.ready) {
          if (gatewayProbe.reason === LEGACY_HTTP_GATEWAY_REASON) {
            derivedStatus = "error";
            derivedError =
              "This VM is running legacy HTTP gateway mode. Click Redeploy Claw to recreate it with HTTPS.";
          } else {
            // Once the gateway has been reachable at least once, transient probe failures
            // should not bounce the UI back into "Starting" (especially mid-wizard).
            if (!everReady) {
              const provisioningElapsedMs =
                Date.now() - new Date(current.provisioning_started_at).getTime();
              const probeTimedOut =
                (gatewayProbe.reason || "").toLowerCase().includes("probe timed out");
              // Some environments can intermittently fail control-plane -> VM probes even while
              // the VM is healthy for end users. After a short grace window, allow launch and
              // let the browser perform the final direct connectivity check.
              const allowUnverifiedReady =
                probeTimedOut &&
                Number.isFinite(provisioningElapsedMs) &&
                provisioningElapsedMs >= GATEWAY_UNVERIFIED_READY_GRACE_MS;
              const gatewayStalled =
                Number.isFinite(provisioningElapsedMs) &&
                provisioningElapsedMs > GATEWAY_UPSTREAM_BOOT_TIMEOUT_MS &&
                gatewayProbe.openclawUpstreamReady === false;
              const startupTimedOut = this.isProvisioningStale(current.provisioning_started_at);
              if (allowUnverifiedReady) {
                derivedStatus = "running";
                derivedError = null;
                provisionedAtPatch = { provisioned_at: new Date().toISOString() };
              } else {
                derivedStatus = startupTimedOut || gatewayStalled ? "error" : "provisioning";
                derivedError = startupTimedOut
                  ? `OpenClaw startup timed out (${gatewayProbe.reason || "gateway not reachable"}). Click Redeploy Claw to replace this VM.`
                  : gatewayStalled
                    ? `OpenClaw gateway did not become reachable after ${Math.round(
                        GATEWAY_UPSTREAM_BOOT_TIMEOUT_MS / 60_000,
                      )} minutes (${gatewayProbe.reason || "openclaw upstream unavailable"}). Click Redeploy Claw to replace this VM.`
                    : "OpenClaw is warming up. First boot can take around 3-10 minutes.";
              }
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

    // Best-effort auto-heal for existing workspaces:
    // keep browser/channels defaults aligned to ClawNow without blocking launch.
    try {
      await this.applyClawNowGatewayDefaults({
        gatewayWebSocketUrl: session.gatewayWebSocketUrl,
        token: session.token,
        force: false,
      });
    } catch (error) {
      await this.logEvent(
        health.instance.id,
        userId,
        "gateway.defaults.autoheal.failed",
        `Failed to auto-heal gateway defaults during launch: ${safeErrorMessage(error)}`,
        { error: safeErrorMessage(error) },
        "warn",
      );
    }

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

    const session = await this.createControlGatewaySession(health.instance, userId, requestMeta, {
      syncControlUiOrigins: true,
      strictControlUiOriginSync: false,
    });
    await this.patchOpenAiProviderAndWorkspaceDefaults({
      gatewayWebSocketUrl: session.gatewayWebSocketUrl,
      token: session.token,
      providerId: "openai",
      apiKey: normalizedApiKey,
      fallbackBaseUrl: OPENAI_PROVIDER_DEFAULT_BASE_URL,
      modelRef: OPENAI_DEFAULT_MODEL,
      alias: "GPT",
    });
    await this.patchGatewayMainSessionModel({
      gatewayWebSocketUrl: session.gatewayWebSocketUrl,
      token: session.token,
      modelRef: OPENAI_DEFAULT_MODEL,
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

    const session = await this.createControlGatewaySession(health.instance, userId, requestMeta, {
      syncControlUiOrigins: true,
      strictControlUiOriginSync: false,
    });
    await this.patchOpenAiProviderAndWorkspaceDefaults({
      gatewayWebSocketUrl: session.gatewayWebSocketUrl,
      token: session.token,
      providerId: "openai-codex",
      apiKey: normalizedAccessToken,
      fallbackBaseUrl: OPENAI_CODEX_PROVIDER_DEFAULT_BASE_URL,
      modelRef: OPENAI_CODEX_DEFAULT_MODEL,
      alias: "Codex",
    });
    await this.patchGatewayMainSessionModel({
      gatewayWebSocketUrl: session.gatewayWebSocketUrl,
      token: session.token,
      modelRef: OPENAI_CODEX_DEFAULT_MODEL,
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

  async repairGatewayDefaults(
    userId: string,
    requestMeta?: ClawNowRequestMeta,
  ): Promise<{ instance: ClawInstance; changed: boolean }> {
    const instance = await this.requireRunningInstance(userId);
    const session = await this.createControlGatewaySession(instance, userId, requestMeta, {
      syncControlUiOrigins: true,
      strictControlUiOriginSync: false,
    });
    const changed = await this.applyClawNowGatewayDefaults({
      gatewayWebSocketUrl: session.gatewayWebSocketUrl,
      token: session.token,
      force: true,
    });
    if (changed) {
      // Gateway hot-reload is intentionally disabled during onboarding flows.
      // After repairing defaults, force a gateway restart so new browser/control-ui
      // settings (for example browser.noSandbox) take effect immediately.
      await this.repairGatewayViaProxy({
        gatewayWebSocketUrl: session.gatewayWebSocketUrl,
        token: session.token,
        reason: "gateway-defaults-repair",
      }).catch(() => false);
    }

    await this.logEvent(
      instance.id,
      userId,
      "gateway.defaults.repair",
      changed
        ? "Repaired gateway defaults for browser/channel setup"
        : "Gateway defaults already up to date",
      {
        changed,
        ip: requestMeta?.ip || null,
      },
    );

    return { instance, changed };
  }

  private async applyClawNowGatewayDefaults(params: {
    gatewayWebSocketUrl: string;
    token: string;
    force: boolean;
  }): Promise<boolean> {
    const snapshot = await this.requestGatewayMethod<{ config?: unknown }>(
      params.gatewayWebSocketUrl,
      params.token,
      "config.get",
      {},
    );
    const patch = this.buildClawNowGatewayDefaultsPatch(snapshot?.config, params.force);
    if (!patch) {
      return false;
    }
    await this.patchGatewayConfig(params.gatewayWebSocketUrl, params.token, patch);
    return true;
  }

  private buildClawNowGatewayDefaultsPatch(
    configRaw: unknown,
    force: boolean,
  ): Record<string, unknown> | null {
    const config = asObjectRecord(configRaw) ?? {};
    const gateway = asObjectRecord(config.gateway);
    const controlUi = asObjectRecord(gateway?.controlUi);
    const browser = asObjectRecord(config.browser);
    const web = asObjectRecord(config.web);
    const tools = asObjectRecord(config.tools);
    const exec = asObjectRecord(tools?.exec);
    const channels = asObjectRecord(config.channels);
    const plugins = asObjectRecord(config.plugins);
    const pluginEntries = asObjectRecord(plugins?.entries);

    const patch: Record<string, unknown> = {};

    const gatewayPatch: Record<string, unknown> = {};
    const controlUiPatch: Record<string, unknown> = {};
    const hostHeaderFallback = controlUi?.dangerouslyAllowHostHeaderOriginFallback;
    if (
      (force && hostHeaderFallback !== true) ||
      (!force && hostHeaderFallback === undefined)
    ) {
      controlUiPatch.dangerouslyAllowHostHeaderOriginFallback = true;
    }
    const disableDeviceAuth = controlUi?.dangerouslyDisableDeviceAuth;
    if ((force && disableDeviceAuth !== true) || (!force && disableDeviceAuth === undefined)) {
      controlUiPatch.dangerouslyDisableDeviceAuth = true;
    }
    if (Object.keys(controlUiPatch).length > 0) {
      gatewayPatch.controlUi = controlUiPatch;
    }
    if (Object.keys(gatewayPatch).length > 0) {
      patch.gateway = gatewayPatch;
    }

    const browserPatch: Record<string, unknown> = {};
    const browserEnabled = browser?.enabled;
    if ((force && browserEnabled !== true) || (!force && browserEnabled === undefined)) {
      browserPatch.enabled = true;
    }
    const browserNoSandbox = browser?.noSandbox;
    if ((force && browserNoSandbox !== true) || (!force && browserNoSandbox === undefined)) {
      // ClawNow gateway runs as root in VM bootstrap, so Chrome must use --no-sandbox.
      browserPatch.noSandbox = true;
    }
    // Keep defaults patch compatible with OpenClaw 2026.2.23 schema.
    // Avoid patching browser.extraArgs (unsupported in that pinned version).
    const browserDefaultProfile =
      typeof browser?.defaultProfile === "string" ? browser.defaultProfile.trim() : "";
    const shouldPatchDefaultProfile = force
      ? browserDefaultProfile !== "openclaw"
      : !browserDefaultProfile || browserDefaultProfile === "chrome";
    if (shouldPatchDefaultProfile) {
      // ClawNow defaults to VM-side managed browser so Desktop Live can mirror actions.
      // Keep user-custom profiles untouched.
      browserPatch.defaultProfile = "openclaw";
    }
    if (Object.keys(browserPatch).length > 0) {
      patch.browser = browserPatch;
    }

    const webEnabled = web?.enabled;
    if ((force && webEnabled !== true) || (!force && webEnabled === undefined)) {
      patch.web = { enabled: true };
    }

    const execPatch: Record<string, unknown> = {};
    const execSecurity = typeof exec?.security === "string" ? exec.security.trim().toLowerCase() : "";
    const shouldPatchExecSecurity = force
      ? execSecurity !== "allowlist"
      : !execSecurity || execSecurity === "full";
    if (shouldPatchExecSecurity) {
      // Keep managed VM shells least-privileged by default.
      execPatch.security = "allowlist";
    }
    const execAsk = typeof exec?.ask === "string" ? exec.ask.trim().toLowerCase() : "";
    const validExecAsk = execAsk === "off" || execAsk === "on-miss" || execAsk === "always";
    const shouldPatchExecAsk = force ? execAsk !== "on-miss" : !validExecAsk;
    if (shouldPatchExecAsk) {
      execPatch.ask = "on-miss";
    }
    if (Object.keys(execPatch).length > 0) {
      patch.tools = {
        exec: execPatch,
      };
    }

    const channelsPatch: Record<string, unknown> = {};
    const pluginEntriesPatch: Record<string, unknown> = {};
    for (const channelId of CLAWNOW_DEFAULT_CHANNEL_IDS) {
      const channelConfig = asObjectRecord(channels?.[channelId]);
      const channelEnabled = channelConfig?.enabled;
      if ((force && channelEnabled !== true) || (!force && channelEnabled === undefined)) {
        channelsPatch[channelId] = { enabled: true };
      }

      const pluginEntry = asObjectRecord(pluginEntries?.[channelId]);
      const pluginEnabled = pluginEntry?.enabled;
      if ((force && pluginEnabled !== true) || (!force && pluginEnabled === undefined)) {
        pluginEntriesPatch[channelId] = { enabled: true };
      }
    }
    if (Object.keys(channelsPatch).length > 0) {
      patch.channels = channelsPatch;
    }

    const pluginsPatch: Record<string, unknown> = {};
    if (Object.keys(pluginEntriesPatch).length > 0) {
      pluginsPatch.entries = pluginEntriesPatch;
    }

    const allow = asTrimmedStringArray(plugins?.allow);
    if (allow && allow.length > 0) {
      const missingAllow = CLAWNOW_DEFAULT_CHANNEL_IDS.filter((id) => !allow.includes(id));
      if (missingAllow.length > 0) {
        pluginsPatch.allow = [...allow, ...missingAllow];
      }
    }

    if (force) {
      const deny = asTrimmedStringArray(plugins?.deny);
      if (deny) {
        const managedChannelSet = new Set<string>(CLAWNOW_DEFAULT_CHANNEL_IDS);
        const nextDeny = deny.filter((entry) => !managedChannelSet.has(entry));
        if (nextDeny.length !== deny.length) {
          pluginsPatch.deny = nextDeny;
        }
      }
    }

    if (Object.keys(pluginsPatch).length > 0) {
      patch.plugins = pluginsPatch;
    }

    const agents = asObjectRecord(config.agents);
    const agentDefaults = asObjectRecord(agents?.defaults);
    const memorySearch = asObjectRecord(agentDefaults?.memorySearch);
    const memorySearchRemote = asObjectRecord(memorySearch?.remote);
    const memorySearchBatch = asObjectRecord(memorySearchRemote?.batch);
    const models = asObjectRecord(config.models);
    const providers = asObjectRecord(models?.providers);
    const openAiProvider = asObjectRecord(providers?.openai);

    const memorySearchPatch: Record<string, unknown> = {};
    const memoryRemotePatch: Record<string, unknown> = {};
    if (memorySearch?.enabled === undefined) {
      memorySearchPatch.enabled = true;
    }
    const memoryProvider =
      typeof memorySearch?.provider === "string" ? memorySearch.provider.trim() : "";
    if (!memoryProvider) {
      memorySearchPatch.provider = "openai";
    }
    const memoryModel = typeof memorySearch?.model === "string" ? memorySearch.model.trim() : "";
    if (!memoryModel) {
      memorySearchPatch.model = OPENAI_MEMORY_EMBED_MODEL;
    }
    const memoryFallback =
      typeof memorySearch?.fallback === "string" ? memorySearch.fallback.trim() : "";
    if (!memoryFallback) {
      memorySearchPatch.fallback = "openai";
    }
    const memoryRemoteApiKey =
      typeof memorySearchRemote?.apiKey === "string" ? memorySearchRemote.apiKey.trim() : "";
    const openAiApiKey =
      typeof openAiProvider?.apiKey === "string" ? openAiProvider.apiKey.trim() : "";
    if (!memoryRemoteApiKey && openAiApiKey) {
      memoryRemotePatch.apiKey = openAiApiKey;
    }

    const memoryBatchPatch: Record<string, unknown> = {};
    if (memorySearchBatch?.enabled === undefined) {
      memoryBatchPatch.enabled = true;
    }
    if (memorySearchBatch?.wait === undefined) {
      memoryBatchPatch.wait = true;
    }
    const batchConcurrency =
      typeof memorySearchBatch?.concurrency === "number" && Number.isFinite(memorySearchBatch.concurrency)
        ? Math.max(1, Math.floor(memorySearchBatch.concurrency))
        : null;
    if (batchConcurrency === null) {
      memoryBatchPatch.concurrency = 2;
    }
    if (Object.keys(memoryBatchPatch).length > 0) {
      memoryRemotePatch.batch = memoryBatchPatch;
    }
    if (Object.keys(memoryRemotePatch).length > 0) {
      memorySearchPatch.remote = memoryRemotePatch;
    }

    if (Object.keys(memorySearchPatch).length > 0) {
      patch.agents = {
        defaults: {
          memorySearch: memorySearchPatch,
        },
      };
    }

    return Object.keys(patch).length > 0 ? patch : null;
  }

  private async patchOpenAiProviderAndWorkspaceDefaults(params: {
    gatewayWebSocketUrl: string;
    token: string;
    providerId: string;
    apiKey: string;
    fallbackBaseUrl: string;
    modelRef: string;
    alias: string;
  }): Promise<void> {
    const modelRef = params.modelRef.trim();
    if (!modelRef) {
      return;
    }

    const snapshot = await this.requestGatewayMethod<{
      config?: unknown;
    }>(params.gatewayWebSocketUrl, params.token, "config.get", {});

    const config = asObjectRecord(snapshot?.config);
    const modelsConfig = asObjectRecord(config?.models);
    const providersRaw = modelsConfig?.providers;
    const providers =
      providersRaw && typeof providersRaw === "object" && !Array.isArray(providersRaw)
        ? (providersRaw as Record<string, unknown>)
        : {};
    const existingProviderRaw = providers[params.providerId];
    const existingProvider =
      existingProviderRaw &&
      typeof existingProviderRaw === "object" &&
      !Array.isArray(existingProviderRaw)
        ? (existingProviderRaw as { baseUrl?: unknown; models?: unknown })
        : {};

    const existingBaseUrl =
      typeof existingProvider.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";
    const hasModelsArray = Array.isArray(existingProvider.models);

    const providerPatch: Record<string, unknown> = {
      apiKey: params.apiKey,
    };
    if (!existingBaseUrl) {
      providerPatch.baseUrl = params.fallbackBaseUrl;
    }
    if (!hasModelsArray) {
      // Keep provider config schema-valid without replacing catalog models.
      providerPatch.models = [];
    }

    const defaultsPatch = this.buildClawNowGatewayDefaultsPatch(snapshot?.config, false);
    const defaultsAgentDefaults = asObjectRecord(asObjectRecord(defaultsPatch?.agents)?.defaults);
    const defaultsMemorySearch = asObjectRecord(defaultsAgentDefaults?.memorySearch);
    const defaultsMemoryRemote = asObjectRecord(defaultsMemorySearch?.remote);
    const defaultsMemoryBatch = asObjectRecord(defaultsMemoryRemote?.batch);

    let mergedMemorySearch: Record<string, unknown> | undefined =
      defaultsMemorySearch ? { ...defaultsMemorySearch } : undefined;
    if (params.providerId === "openai") {
      const existingBatchConcurrency =
        typeof defaultsMemoryBatch?.concurrency === "number" &&
        Number.isFinite(defaultsMemoryBatch.concurrency)
          ? Math.max(1, Math.floor(defaultsMemoryBatch.concurrency))
          : 2;
      mergedMemorySearch = {
        ...(mergedMemorySearch || {}),
        enabled: true,
        provider: "openai",
        model: OPENAI_MEMORY_EMBED_MODEL,
        fallback: "openai",
        remote: {
          ...(defaultsMemoryRemote || {}),
          apiKey: params.apiKey,
          batch: {
            ...(defaultsMemoryBatch || {}),
            enabled:
              typeof defaultsMemoryBatch?.enabled === "boolean"
                ? defaultsMemoryBatch.enabled
                : true,
            wait:
              typeof defaultsMemoryBatch?.wait === "boolean" ? defaultsMemoryBatch.wait : true,
            concurrency: existingBatchConcurrency,
          },
        },
      };
    }

    const mergedAgentDefaults: Record<string, unknown> = {
      ...(defaultsAgentDefaults || {}),
      model: {
        primary: modelRef,
      },
      models: {
        [modelRef]: {
          alias: params.alias,
        },
      },
    };
    if (mergedMemorySearch) {
      mergedAgentDefaults.memorySearch = mergedMemorySearch;
    }

    const mergedPatch: Record<string, unknown> = {
      ...(defaultsPatch || {}),
      models: {
        providers: {
          [params.providerId]: providerPatch,
        },
      },
      agents: {
        defaults: mergedAgentDefaults,
      },
    };

    await this.patchGatewayConfig(params.gatewayWebSocketUrl, params.token, mergedPatch);
  }

  private async patchGatewayMainSessionModel(params: {
    gatewayWebSocketUrl: string;
    token: string;
    modelRef: string;
  }): Promise<void> {
    const modelRef = params.modelRef.trim();
    if (!modelRef) {
      return;
    }

    try {
      await this.requestGatewayMethod(
        params.gatewayWebSocketUrl,
        params.token,
        "sessions.patch",
        {
          key: DEFAULT_MAIN_SESSION_KEY,
          model: modelRef,
        },
      );
    } catch {
      // Best-effort: keep auth setup successful even if main session wasn't created yet.
    }
  }

  private createOnboardingCodexOAuthState(): OnboardingCodexOAuthState {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("hex");
    const authUrl = new URL(OPENAI_CODEX_OAUTH_AUTHORIZE_URL);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", OPENAI_CODEX_OAUTH_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", OPENAI_CODEX_OAUTH_REDIRECT_URI);
    authUrl.searchParams.set("scope", OPENAI_CODEX_OAUTH_SCOPE);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("id_token_add_organizations", "true");
    authUrl.searchParams.set("codex_cli_simplified_flow", "true");
    authUrl.searchParams.set("originator", OPENAI_CODEX_OAUTH_ORIGINATOR);
    return {
      sessionId: randomUUID(),
      state,
      verifier,
      authUrl: authUrl.toString(),
      createdAtMs: Date.now(),
    };
  }

  private readOnboardingCodexOAuthState(
    metadata: Record<string, unknown>,
  ): OnboardingCodexOAuthState | null {
    const raw = (metadata as { onboarding_codex_oauth?: unknown }).onboarding_codex_oauth;
    const record = asObjectRecord(raw);
    if (!record) {
      return null;
    }
    const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
    const state = typeof record.state === "string" ? record.state.trim() : "";
    const verifier = typeof record.verifier === "string" ? record.verifier.trim() : "";
    const authUrl = typeof record.authUrl === "string" ? record.authUrl.trim() : "";
    const createdAtMsRaw =
      typeof record.createdAtMs === "number" && Number.isFinite(record.createdAtMs)
        ? Math.floor(record.createdAtMs)
        : typeof record.createdAtMs === "string"
          ? Number(record.createdAtMs)
          : Number.NaN;
    if (!sessionId || !state || !verifier || !authUrl || !Number.isFinite(createdAtMsRaw)) {
      return null;
    }
    const accessToken = typeof record.accessToken === "string" ? record.accessToken.trim() : "";
    return {
      sessionId,
      state,
      verifier,
      authUrl,
      createdAtMs: createdAtMsRaw,
      ...(accessToken ? { accessToken } : {}),
    };
  }

  private isOnboardingCodexOAuthStateExpired(session: OnboardingCodexOAuthState): boolean {
    return Date.now() - session.createdAtMs > OPENAI_CODEX_OAUTH_SESSION_TTL_MS;
  }

  private parseCodexCallbackInput(input: string): ParsedCodexCallbackInput {
    const value = input.trim();
    if (!value) {
      return { code: null, state: null, error: null };
    }

    const fromSearchParams = (params: URLSearchParams): ParsedCodexCallbackInput => {
      const codeRaw = params.get("code");
      const stateRaw = params.get("state");
      const errorRaw = params.get("error") ?? params.get("error_description");
      const code = typeof codeRaw === "string" && codeRaw.trim() ? codeRaw.trim() : null;
      const state = typeof stateRaw === "string" && stateRaw.trim() ? stateRaw.trim() : null;
      const error = typeof errorRaw === "string" && errorRaw.trim() ? errorRaw.trim() : null;
      return { code, state, error };
    };

    try {
      const url = new URL(value);
      return fromSearchParams(url.searchParams);
    } catch {
      // fall through: users may paste query strings or compact "code#state" values.
    }

    if (value.includes("code=") || value.includes("error=")) {
      return fromSearchParams(new URLSearchParams(value));
    }

    if (value.includes("#")) {
      const [codeRaw, stateRaw] = value.split("#", 2);
      const code = codeRaw?.trim() ? codeRaw.trim() : null;
      const state = stateRaw?.trim() ? stateRaw.trim() : null;
      return { code, state, error: null };
    }

    return { code: value, state: null, error: null };
  }

  private async exchangeOpenAiCodexAuthorizationCode(params: {
    code: string;
    verifier: string;
  }): Promise<{ accessToken: string }> {
    const response = await fetch(OPENAI_CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
        code: params.code,
        code_verifier: params.verifier,
        redirect_uri: OPENAI_CODEX_OAUTH_REDIRECT_URI,
      }),
    });
    let payload: unknown = null;
    try {
      payload = (await response.json()) as unknown;
    } catch {
      payload = null;
    }
    const payloadRecord = asObjectRecord(payload);
    if (!response.ok) {
      const oauthError =
        typeof payloadRecord?.error_description === "string" && payloadRecord.error_description.trim()
          ? payloadRecord.error_description.trim()
          : typeof payloadRecord?.error === "string" && payloadRecord.error.trim()
            ? payloadRecord.error.trim()
            : null;
      throw new ClawNowServiceError(
        "CODEX_OAUTH_EXCHANGE_FAILED",
        oauthError
          ? `ChatGPT OAuth token exchange failed: ${oauthError}`
          : "ChatGPT OAuth token exchange failed. Please click Login with ChatGPT and try again.",
        409,
      );
    }
    const accessToken =
      typeof payloadRecord?.access_token === "string" ? payloadRecord.access_token.trim() : "";
    if (!accessToken) {
      throw new ClawNowServiceError(
        "CODEX_OAUTH_EXCHANGE_FAILED",
        "ChatGPT OAuth did not return an access token. Please retry login.",
        409,
      );
    }
    return { accessToken };
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
        onboarding_codex_oauth: null,
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
          onboarding_codex_oauth: null,
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
        onboarding_codex_oauth: null,
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

      await this.configureGatewayAuthWithWarmupRetry(() =>
        this.configureOpenAiApiKey(userId, apiKey, requestMeta),
      );
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
          onboarding_codex_oauth: null,
        },
      });

      return {
        instance: cleared,
        result: { done: true, status: "done" },
      };
    }

    if (stepId === CLAWNOW_WIZARD_STEP_CODEX_CALLBACK_URL) {
      const callbackUrl = typeof answerValue === "string" ? answerValue.trim() : "";
      const oauthState = this.readOnboardingCodexOAuthState(metadata);
      if (!oauthState) {
        throw new ClawNowServiceError(
          "CODEX_OAUTH_NOT_STARTED",
          'Click "Login with ChatGPT" first, then paste the callback URL here.',
          409,
        );
      }
      if (this.isOnboardingCodexOAuthStateExpired(oauthState)) {
        throw new ClawNowServiceError(
          "CODEX_OAUTH_EXPIRED",
          "OAuth session expired. Click Login with ChatGPT again and paste the new callback URL.",
          409,
        );
      }

      let accessToken = oauthState.accessToken?.trim() || "";
      if (!accessToken) {
        if (!callbackUrl) {
          throw new ClawNowServiceError(
            "CODEX_CALLBACK_URL_REQUIRED",
            "Redirect URL is required",
            400,
          );
        }
        const parsed = this.parseCodexCallbackInput(callbackUrl);
        if (parsed.error) {
          throw new ClawNowServiceError(
            "CODEX_CALLBACK_REJECTED",
            `ChatGPT OAuth callback returned an error: ${parsed.error}`,
            409,
          );
        }
        if (!parsed.code) {
          throw new ClawNowServiceError(
            "CODEX_CALLBACK_URL_INVALID",
            "Callback URL is missing an authorization code.",
            400,
          );
        }
        if (parsed.state && parsed.state !== oauthState.state) {
          throw new ClawNowServiceError(
            "CODEX_CALLBACK_STATE_MISMATCH",
            "Callback URL does not match the latest Login with ChatGPT session. Please login again.",
            409,
          );
        }
        const exchanged = await this.exchangeOpenAiCodexAuthorizationCode({
          code: parsed.code,
          verifier: oauthState.verifier,
        });
        accessToken = exchanged.accessToken;
        await setWizardState({
          onboarding_codex_oauth: {
            ...oauthState,
            accessToken,
          },
        });
      }

      await this.configureGatewayAuthWithWarmupRetry(() =>
        this.configureOpenAiCodexAccessToken(userId, accessToken, requestMeta),
      );
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
          onboarding_codex_oauth: null,
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
        onboarding_codex_oauth: null,
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

    const existingOAuth = this.readOnboardingCodexOAuthState(metadata);
    if (existingOAuth && !this.isOnboardingCodexOAuthStateExpired(existingOAuth)) {
      return {
        instance,
        authUrl: existingOAuth.authUrl,
      };
    }

    const oauth = this.createOnboardingCodexOAuthState();
    const updatedInstance = await this.updateInstance(instance.id, {
      metadata: {
        ...metadata,
        onboarding_codex_session_id: oauth.sessionId,
        onboarding_codex_oauth: oauth,
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
      ? this.ensureNoVncViewerPath(joinUrl(gatewayUrl, this.config.novncPath))
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
    return this.withQuery(this.ensureNoVncViewerPath(this.config.novncBaseUrl), { instanceId });
  }

  private ensureNoVncViewerPath(baseUrl: string): string {
    const url = new URL(baseUrl);
    const normalizedPath = url.pathname.toLowerCase();
    const hasViewerPath =
      normalizedPath.endsWith("/vnc.html") ||
      normalizedPath.endsWith("/vnc_lite.html") ||
      normalizedPath.endsWith("/vnc_auto.html");
    if (!hasViewerPath) {
      const trimmedPath = url.pathname.replace(/\/+$/, "");
      url.pathname = `${trimmedPath || ""}/vnc.html`;
    }

    const desiredPath = `${this.config.novncPath}/websockify`;
    if (!url.searchParams.get("autoconnect")) {
      url.searchParams.set("autoconnect", "1");
    }
    if (!url.searchParams.get("reconnect")) {
      url.searchParams.set("reconnect", "true");
    }
    if (!url.searchParams.get("reconnect_delay")) {
      url.searchParams.set("reconnect_delay", "1000");
    }
    if (!url.searchParams.get("resize")) {
      url.searchParams.set("resize", "remote");
    }
    if (!url.searchParams.get("path")) {
      url.searchParams.set("path", desiredPath);
    }

    return url.toString();
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
    if (message.includes("probe timed out") || message.includes("gateway websocket failed to open")) {
      return "gateway_probe_timeout";
    }
    if (message.includes("upstream websocket connection failed")) {
      return "gateway_ws_upstream_failed";
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

      let payload: {
        success?: unknown;
        details?: {
          upstreamReady?: unknown;
        };
      } = {};
      try {
        payload = (await response.json()) as {
          success?: unknown;
          details?: {
            upstreamReady?: unknown;
          };
        };
      } catch {
        payload = {};
      }

      const upstreamReady =
        payload.details && typeof payload.details === "object"
          ? payload.details.upstreamReady
          : undefined;
      if (typeof upstreamReady === "boolean") {
        return upstreamReady;
      }

      return payload.success === false ? false : true;
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

    const headers = { "user-agent": "clawnow-control-plane/gateway-probe" };

    const fetchJson = async (
      path: string,
    ): Promise<{ ok: boolean; status: number; payload: unknown; timeout: boolean }> => {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), GATEWAY_DIAGNOSE_PROBE_TIMEOUT_MS);
      const url = new URL(path, origin).toString();
      try {
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
        return { ok: response.ok, status: response.status, payload, timeout: false };
      } catch (error) {
        if (isAbortError(error)) {
          return { ok: false, status: 0, payload: null, timeout: true };
        }
        throw error;
      } finally {
        clearTimeout(timeoutHandle);
      }
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

      if (bootstrap.timeout) {
        parts.push("bootstrap=timeout");
      } else if (bootstrap.ok) {
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

      if (health.timeout) {
        parts.push("health=timeout");
      } else if (health.ok) {
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
      return `origin=${origin}; probe failed: ${safeErrorMessage(error)}`;
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
    let lastGatewayWebSocketUrl = gatewayWebSocketUrl;
    let repaired = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.withGatewayConnectionWithFallback(
          gatewayWebSocketUrl,
          token,
          async (sendRequest) => {
            return (await sendRequest(method, params)) as T;
          },
          options,
        );
      } catch (error) {
        lastError = error;
        if (error instanceof ClawNowServiceError) {
          const candidateUrl =
            this.extractGatewayWebSocketUrlFromMessage(error.message) || gatewayWebSocketUrl;
          lastGatewayWebSocketUrl = candidateUrl;
        }
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
              gatewayWebSocketUrl: lastGatewayWebSocketUrl,
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

  private async configureGatewayAuthWithWarmupRetry(
    operation: () => Promise<unknown>,
  ): Promise<void> {
    const deadline = Date.now() + GATEWAY_WARMUP_RETRY_WINDOW_MS;
    let attempt = 0;

    while (true) {
      try {
        await operation();
        return;
      } catch (error) {
        if (!this.isGatewayWarmupTransientError(error)) {
          throw error;
        }
        if (Date.now() >= deadline) {
          break;
        }
        const delay = Math.min(
          GATEWAY_WARMUP_RETRY_BACKOFF_MAX_MS,
          GATEWAY_WARMUP_RETRY_BACKOFF_BASE_MS + attempt * 600,
        );
        attempt += 1;
        await this.wait(delay);
      }
    }

    throw new ClawNowServiceError(
      "GATEWAY_WARMING_UP",
      "ChatGPT login succeeded, but the gateway is still warming up. Click Sync Health, wait 10-20 seconds, then click Submit Step again. No need to login again.",
      409,
    );
  }

  private isGatewayWarmupTransientError(error: unknown): boolean {
    if (error instanceof ClawNowServiceError) {
      if (
        new Set([
          "GATEWAY_CONNECT_FAILED",
          "GATEWAY_SOCKET_CLOSED",
          "GATEWAY_TIMEOUT",
          "GATEWAY_REQUEST_FAILED",
          "GATEWAY_CONFIG_PATCH_FAILED",
          "GATEWAY_ORIGIN_SYNC_FAILED",
        ]).has(error.code)
      ) {
        return true;
      }
      if (error.code === "INSTANCE_BOOTING") {
        return true;
      }
    }
    const message = safeErrorMessage(error).toLowerCase();
    return (
      message.includes("gateway websocket failed to open") ||
      message.includes("probe timed out") ||
      message.includes("gateway request timed out") ||
      message.includes("upstream websocket connection failed") ||
      message.includes("econnrefused") ||
      message.includes("connection refused")
    );
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

  private formatGatewayErrorMessage(
    error:
      | {
          code?: string;
          message?: string;
          details?: unknown;
        }
      | null
      | undefined,
  ): string {
    const base = (error?.message || error?.code || "Gateway request failed").trim();
    const details = error?.details;
    if (!details || typeof details !== "object") {
      return base;
    }

    const issuesRaw = (details as { issues?: unknown }).issues;
    if (!Array.isArray(issuesRaw)) {
      return base;
    }
    const issues = issuesRaw
      .map((issue) => {
        if (!issue || typeof issue !== "object") {
          return null;
        }
        const path =
          typeof (issue as { path?: unknown }).path === "string"
            ? (issue as { path: string }).path.trim()
            : "";
        const message =
          typeof (issue as { message?: unknown }).message === "string"
            ? (issue as { message: string }).message.trim()
            : "";
        if (!path && !message) {
          return null;
        }
        return path ? `${path}: ${message || "invalid"}` : message;
      })
      .filter((line): line is string => Boolean(line));
    if (issues.length === 0) {
      return base;
    }
    return `${base} (${issues.join("; ")})`;
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
      await this.withGatewayConnectionWithFallback(
        gatewayWebSocketUrl,
        token,
        async (sendRequest) => {
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
        },
      );
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

  private extractGatewayWebSocketUrlFromMessage(message: string): string | null {
    const normalized = String(message || "");
    const match = normalized.match(/\((ws[s]?:\/\/[^\s);]+)[^)]*\)/i);
    if (match && match[1]) {
      return match[1];
    }
    return null;
  }

  private buildGatewayWebSocketCandidateUrls(gatewayWebSocketUrl: string): string[] {
    const candidates: string[] = [gatewayWebSocketUrl];
    try {
      const parsed = new URL(gatewayWebSocketUrl);
      const host = parsed.hostname.trim();
      const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
      const sslipSuffix = ".sslip.io";

      if (parsed.protocol === "ws:" && isIpv4 && (!parsed.port || parsed.port === "18790")) {
        const secureFallback = new URL(parsed.toString());
        secureFallback.protocol = "wss:";
        secureFallback.hostname = `${host}${sslipSuffix}`;
        secureFallback.port = "";
        candidates.push(secureFallback.toString());
      }

      if (parsed.protocol === "wss:" && host.endsWith(sslipSuffix) && !parsed.port) {
        const ipCandidate = host.slice(0, -sslipSuffix.length);
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ipCandidate)) {
          const insecureFallback = new URL(parsed.toString());
          insecureFallback.protocol = "ws:";
          insecureFallback.hostname = ipCandidate;
          insecureFallback.port = "18790";
          candidates.push(insecureFallback.toString());
        }
      }
    } catch {
      // Keep primary candidate only.
    }

    return candidates.filter((value, index) => candidates.indexOf(value) === index);
  }

  private shouldTryGatewayFallbackCandidate(error: unknown): boolean {
    if (!(error instanceof ClawNowServiceError)) {
      return false;
    }
    if (
      new Set(["GATEWAY_CONNECT_FAILED", "GATEWAY_SOCKET_CLOSED", "GATEWAY_TIMEOUT"]).has(
        error.code,
      )
    ) {
      return true;
    }
    if (error.code !== "GATEWAY_REQUEST_FAILED") {
      return false;
    }
    const message = error.message.toLowerCase();
    return (
      message.includes("upstream websocket connection failed") ||
      message.includes("gateway websocket failed to open") ||
      message.includes("probe timed out")
    );
  }

  private async withGatewayConnectionWithFallback<T>(
    gatewayWebSocketUrl: string,
    token: string,
    operation: (sendRequest: GatewayRequestSender) => Promise<T>,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    const candidates = this.buildGatewayWebSocketCandidateUrls(gatewayWebSocketUrl);
    let lastError: unknown = null;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      try {
        return await this.withGatewayConnection(candidate, token, operation, options);
      } catch (error) {
        lastError = error;
        const isLastCandidate = index >= candidates.length - 1;
        if (isLastCandidate || !this.shouldTryGatewayFallbackCandidate(error)) {
          break;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ClawNowServiceError("GATEWAY_CONNECT_FAILED", "Gateway websocket failed to open", 502);
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
          this.formatGatewayErrorMessage(response.error),
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
  ): Promise<GatewayReadinessProbeResult> {
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
        let payload: {
          error?: string;
          code?: string;
          upstream?: {
            openclaw?: {
              ok?: unknown;
              error?: unknown;
            };
          };
        } = {};
        try {
          payload = (await response.json()) as {
            error?: string;
            code?: string;
            upstream?: {
              openclaw?: {
                ok?: unknown;
                error?: unknown;
              };
            };
          };
        } catch {
          payload = {};
        }
        const legacyMode = await this.detectLegacyHttpGatewayMode(gatewayUrl);
        if (legacyMode) {
          return { ready: false, reason: LEGACY_HTTP_GATEWAY_REASON };
        }
        const openclawUpstream =
          payload.upstream && typeof payload.upstream === "object"
            ? payload.upstream.openclaw
            : undefined;
        const openclawUpstreamReady =
          openclawUpstream && typeof openclawUpstream === "object"
            ? typeof openclawUpstream.ok === "boolean"
              ? openclawUpstream.ok
              : undefined
            : undefined;
        const openclawUpstreamError =
          openclawUpstream && typeof openclawUpstream === "object"
            ? typeof openclawUpstream.error === "string" && openclawUpstream.error.trim()
              ? openclawUpstream.error.trim()
              : undefined
            : undefined;
        // /__clawnow/health returns combined upstream health (openclaw + novnc).
        // Workspace readiness should depend on OpenClaw gateway only; allow degraded noVNC.
        if (payload.code === "upstream_unavailable" && openclawUpstreamReady === true) {
          return {
            ready: true,
            reason: "OpenClaw upstream ready; noVNC still booting",
            code: payload.code,
            openclawUpstreamReady,
            openclawUpstreamError,
          };
        }
        const reason = payload.error?.trim();
        const upstreamHint = openclawUpstreamError
          ? ` (openclaw upstream: ${openclawUpstreamError})`
          : "";
        return {
          ready: false,
          code: payload.code,
          openclawUpstreamReady,
          openclawUpstreamError,
          reason: reason
            ? `Gateway health returned HTTP ${response.status}: ${reason}${upstreamHint}`
            : `Gateway health returned HTTP ${response.status}${upstreamHint}`,
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

  private shouldAttemptAutoGatewayRepair(
    instance: ClawInstance,
    probe: GatewayReadinessProbeResult,
  ): boolean {
    if (probe.openclawUpstreamReady !== false) {
      return false;
    }

    const code = (probe.code || "").trim().toLowerCase();
    const reason = (probe.reason || "").trim().toLowerCase();
    const hint =
      code === "upstream_unavailable" ||
      reason.includes("econnrefused") ||
      reason.includes("connection refused");
    if (!hint) {
      return false;
    }

    const metadata =
      instance.metadata && typeof instance.metadata === "object" ? instance.metadata : {};
    const rawLastAttempt = (metadata as { auto_gateway_repair_attempt_at?: unknown })
      .auto_gateway_repair_attempt_at;
    if (typeof rawLastAttempt !== "string" || !rawLastAttempt.trim()) {
      return true;
    }
    const lastAttemptMs = new Date(rawLastAttempt).getTime();
    if (!Number.isFinite(lastAttemptMs)) {
      return true;
    }
    return Date.now() - lastAttemptMs >= 90_000;
  }

  private async tryAutoRepairGateway(
    instance: ClawInstance,
    userId: string,
    gatewayUrl: string,
  ): Promise<boolean> {
    const nowIso = new Date().toISOString();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const metadata =
      instance.metadata && typeof instance.metadata === "object" ? instance.metadata : {};

    const recordAttempt = async (status: "attempted" | "repaired" | "failed") => {
      try {
        await this.updateInstance(instance.id, {
          metadata: {
            ...metadata,
            auto_gateway_repair_attempt_at: nowIso,
            auto_gateway_repair_status: status,
          },
        });
      } catch {
        // Best-effort only; readiness flow must not fail because metadata write fails.
      }
    };

    await recordAttempt("attempted");

    const token = this.signToken({
      iss: "clawnow-control-plane",
      aud: "openclaw-gateway",
      sub: userId,
      jti: randomUUID(),
      iat: nowSeconds,
      exp: nowSeconds + 120,
      instance_id: instance.id,
      session_type: "control_ui",
      provider: "hetzner",
      trusted_proxy: true,
      gateway_url: gatewayUrl,
    });

    const gatewayWebSocketUrl = this.toWebSocketUrl(this.ensureTrailingSlash(gatewayUrl));
    const repaired = await this.repairGatewayViaProxy({
      gatewayWebSocketUrl,
      token,
      reason: "auto-health-probe-upstream-down",
    });

    await recordAttempt(repaired ? "repaired" : "failed");
    return repaired;
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
    const timeout = setTimeout(() => controller.abort(), GATEWAY_LAUNCH_PROBE_TIMEOUT_MS);
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

      if (isAbortError(error)) {
        // Do not block launch on control-plane probe timeout. End-user browser connectivity
        // can still succeed even when this server-side preflight is slow/intermittent.
        await this.logEvent(
          instance.id,
          instance.user_id,
          "gateway.launch.probe.timeout",
          "Control-plane launch probe timed out; continuing with optimistic launch.",
          { launchUrl },
          "warn",
        );
        return;
      }

      const bootingMessage = "OpenClaw endpoint is not reachable yet. Please retry in a moment.";

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
      ...(this.config.openClawVersion
        ? [`--openclaw-version '${this.config.openClawVersion}'`]
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
