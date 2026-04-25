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
  OctogenHetznerService,
  HetznerApiError,
  type HetznerServer,
} from "@/lib/services/octogen-hetzner.service";
import {
  buildOctogenGatewayDefaultsPatch,
  buildOctogenTrustedProxyAllowUsersPatch,
  OPENAI_MEMORY_EMBED_MODEL,
} from "./octogen-gateway-defaults";
import {
  describeGatewayPayloadError,
  formatGatewayBootstrapFailureReason,
  parseGatewayBootstrapState,
} from "./octogen-gateway-probe";

export type OctogenVmStatus =
  | "provisioning"
  | "running"
  | "recovering"
  | "stopped"
  | "error"
  | "deleting"
  | "terminated";

export type OctogenSessionType = "control_ui" | "desktop" | "novnc";

export interface OctogenVm {
  id: string;
  workspace_id: string;
  created_by_user_id: string | null;
  provider: "hetzner";
  region: string;
  server_type: string;
  image: string;
  server_name: string;
  hetzner_server_id: number | null;
  status: OctogenVmStatus;
  ipv4: string | null;
  ipv6: string | null;
  gateway_url: string | null;
  control_ui_url: string | null;
  desktop_url: string | null;
  /** @deprecated Use desktop_url. */
  novnc_url: string | null;
  provisioning_started_at: string;
  provisioned_at: string | null;
  last_heartbeat_at: string | null;
  desktop_enabled_until: string | null;
  /** @deprecated Use desktop_enabled_until. */
  novnc_enabled_until: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface OctogenRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  controlUiOrigin?: string | null;
}

export interface OctogenVmHealth {
  vm: OctogenVm | null;
  providerStatus: string | null;
  checkedAt: string;
  error?: string;
}

export interface OctogenWorkspaceBillingSummary {
  status: "ok" | "unavailable";
  currency: "USD";
  organizationMembershipCount: number;
  organizationSubscriptionCount: number;
  organizationPrepaidBalance: number;
  selectedOrganizationId: string | null;
  selectedOrganizationName: string | null;
  selectedOrganizationPrepaidBalance: number | null;
  organizations: OctogenWorkspaceBillingOrganization[];
  message?: string;
}

export interface OctogenWorkspaceBillingOrganization {
  id: string;
  name: string;
  slug: string | null;
  prepaidBalance: number;
  hasActiveSubscription: boolean;
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
  organizations?:
    | {
        id?: string | null;
        name?: string | null;
        slug?: string | null;
      }
    | Array<{
        id?: string | null;
        name?: string | null;
        slug?: string | null;
      }>
    | null;
}

interface OrganizationSubscriptionBalanceRow {
  id: string;
  organization_id: string | null;
  prepaid_balance: number | null;
  created_at: string;
}

type OctogenWizardAuthMethod = "openai_api_key" | "openai_codex_oauth";

interface PendingGatewayAuthState {
  providerId: "openai-codex";
  accessToken: string;
  createdAtMs: number;
}

const OCTOGEN_WIZARD_STEP_AUTH_METHOD = "octogen.setup.auth_method";
const OCTOGEN_WIZARD_STEP_OPENAI_API_KEY = "octogen.setup.openai_api_key";
const OCTOGEN_WIZARD_STEP_CODEX_CALLBACK_URL = "octogen.setup.codex_callback_url";

export class OctogenServiceError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "OctogenServiceError";
    this.code = code;
    this.status = status;
  }
}

interface OctogenConfig {
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
  vmGatewayTemplate: string;
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
  openClawInstallSpec: string | null;
}

interface GatewayDeviceIdentity {
  deviceId: string;
  publicKeyBase64Url: string;
  privateKeyPem: string;
}

const DEFAULT_PROVISIONING_TIMEOUT_SECONDS = 15 * 60;
const GATEWAY_HEALTH_TIMEOUT_MS = 8000;
const GATEWAY_BOOTSTRAP_TIMEOUT_MS = 3000;
const GATEWAY_LAUNCH_PROBE_TIMEOUT_MS = 12000;
const GATEWAY_WS_TIMEOUT_MS = 20_000;
const GATEWAY_DIAGNOSE_PROBE_TIMEOUT_MS = 8_000;
const GATEWAY_CONFIG_PATCH_MAX_ATTEMPTS = 3;
const GATEWAY_CONFIG_PATCH_RETRY_DELAY_MS = 400;
const GATEWAY_HEALTH_PATH = "__octogen/health";
const GATEWAY_BOOTSTRAP_PATH = "__octogen/bootstrap";
const GATEWAY_REPAIR_PATH = "__octogen/repair/gateway";
const WORKSPACE_RELEASE_SYNC_PATH = "__octogen/repair/release";
// First boot can be slow (apt + Node + OpenClaw + desktop/browser deps). Avoid
// marking the VM as errored too early; defer hard failure to provisioningTimeoutSeconds.
const GATEWAY_UPSTREAM_BOOT_TIMEOUT_MS = 12 * 60 * 1000;
const GATEWAY_UNVERIFIED_READY_GRACE_MS = 3 * 60 * 1000;
const GATEWAY_WARMUP_RETRY_WINDOW_MS = 45 * 1000;
const GATEWAY_WARMUP_RETRY_BACKOFF_BASE_MS = 1000;
const GATEWAY_WARMUP_RETRY_BACKOFF_MAX_MS = 5000;
const OCTOGEN_CLOUD_INIT_MAX_BYTES = 16000;
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
const OCTOGEN_DEFAULT_OPENCLAW_VERSION = "2026.3.13";
const OCTOGEN_DEFAULT_CONTROL_SESSION_TTL_SECONDS = 2 * 60 * 60;
const OCTOGEN_MIN_CONTROL_SESSION_TTL_SECONDS = 30 * 60;
const DEFAULT_MAIN_SESSION_KEY = "main";
const DEFAULT_BOOTSTRAP_SCRIPT_URL =
  "https://raw.githubusercontent.com/cayden970207/octogen/main/octogen-console/scripts/octogen-vm-bootstrap.sh";
const DEFAULT_PROXY_SCRIPT_URL =
  "https://raw.githubusercontent.com/cayden970207/octogen/main/octogen-console/scripts/octogen-proxy.mjs";
const DEFAULT_HERMES_RUNNER_SCRIPT_URL =
  "https://raw.githubusercontent.com/cayden970207/octogen/main/octogen-console/scripts/octogen-hermes-runner.mjs";
const DEFAULT_CONTROL_UI_UPDATER_SCRIPT_URL =
  "https://raw.githubusercontent.com/cayden970207/octogen/main/octogen-console/scripts/octogen-control-ui-updater.sh";
const LOCAL_BOOTSTRAP_SCRIPT_PATH = "api/octogen/bootstrap/vm";
const LOCAL_PROXY_SCRIPT_PATH = "api/octogen/bootstrap/proxy";
const LOCAL_HERMES_RUNNER_SCRIPT_PATH = "api/octogen/bootstrap/hermes-runner";
const LOCAL_CONTROL_UI_UPDATER_SCRIPT_PATH = "api/octogen/bootstrap/control-ui-updater";
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
  bootstrapPhase?: string;
  bootstrapStatus?: string;
  bootstrapMessage?: string;
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

function formatEnvName(name: string): string {
  return name;
}

function readEnv(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function getRequiredEnv(name: string): string {
  const value = readEnv(name);
  if (!value) {
    throw new OctogenServiceError(
      "CONFIG_MISSING",
      `Missing required environment variable: ${formatEnvName(name)}`,
      503,
    );
  }
  return value;
}

function getOptionalEnv(name: string): string | null {
  return readEnv(name);
}

function getNumberEnv(name: string, defaultValue: number): number {
  const raw = readEnv(name);
  if (!raw) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

function _clampPort(value: number, fallback: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value) : fallback;
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 65535) {
    return fallback;
  }
  return normalized;
}

function getListEnv(name: string): string[] {
  const raw = readEnv(name);
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
  const explicit = getOptionalEnv("OCTOGEN_BOOTSTRAP_ASSET_BASE_URL");
  if (explicit) {
    return ensureAbsoluteUrl("OCTOGEN_BOOTSTRAP_ASSET_BASE_URL", explicit);
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
  const explicit = getOptionalEnv("OCTOGEN_CONTROL_UI_ALLOWED_ORIGIN");
  if (explicit) {
    return ensureAbsoluteUrl("OCTOGEN_CONTROL_UI_ALLOWED_ORIGIN", explicit);
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
    throw new OctogenServiceError(
      "CONFIG_INVALID",
      `Environment variable ${formatEnvName(name)} must be an absolute URL`,
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
    throw new OctogenServiceError(
      "CONFIG_INVALID",
      `Environment variable ${formatEnvName(name)} must be a clean path segment`,
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

function getModelPrimaryValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  const record = asObjectRecord(value);
  return typeof record?.primary === "string" ? record.primary.trim() : "";
}

function resolveDefaultAgentIdFromGatewayConfig(configRaw: unknown): string {
  const config = asObjectRecord(configRaw);
  const agentsList = Array.isArray(asObjectRecord(config?.agents)?.list)
    ? (asObjectRecord(config?.agents)?.list as unknown[])
    : [];
  if (agentsList.length === 0) {
    return "main";
  }
  const normalizedEntries = agentsList
    .map((entry) => asObjectRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .filter((entry) => typeof entry.id === "string" && entry.id.trim().length > 0);
  if (normalizedEntries.length === 0) {
    return "main";
  }
  const explicitDefault = normalizedEntries.find((entry) => entry.default === true);
  const chosen = explicitDefault ?? normalizedEntries[0];
  return typeof chosen.id === "string" && chosen.id.trim() ? chosen.id.trim() : "main";
}

function resolveGatewayPrimaryModelRef(configRaw: unknown): string {
  const config = asObjectRecord(configRaw);
  const agents = asObjectRecord(config?.agents);
  const agentDefaults = asObjectRecord(agents?.defaults);
  const agentsList = Array.isArray(agents?.list) ? agents.list : [];
  const defaultAgentId = resolveDefaultAgentIdFromGatewayConfig(configRaw);
  const defaultAgentEntry = agentsList
    .map((entry) => asObjectRecord(entry))
    .find(
      (entry) =>
        typeof entry?.id === "string" &&
        entry.id.trim().toLowerCase() === defaultAgentId.toLowerCase(),
    );
  return (
    getModelPrimaryValue(defaultAgentEntry?.model) || getModelPrimaryValue(agentDefaults?.model)
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function escapeForSingleQuotedBash(value: string): string {
  return value.replace(/'/g, `'"'"'`);
}

function loadOctogenConfig(): OctogenConfig {
  const gatewayBaseRaw = getOptionalEnv("OCTOGEN_GATEWAY_BASE_URL");
  const gatewayBase = gatewayBaseRaw
    ? ensureAbsoluteUrl("OCTOGEN_GATEWAY_BASE_URL", gatewayBaseRaw)
    : null;
  const controlUiBaseRaw = getOptionalEnv("OCTOGEN_CONTROL_UI_BASE_URL");
  const novncBaseRaw = getOptionalEnv("OCTOGEN_NOVNC_BASE_URL");

  const controlUiBase = controlUiBaseRaw
    ? ensureAbsoluteUrl("OCTOGEN_CONTROL_UI_BASE_URL", controlUiBaseRaw)
    : gatewayBase
      ? joinUrl(gatewayBase, "octogen")
      : null;
  const novncBase = novncBaseRaw
    ? ensureAbsoluteUrl("OCTOGEN_NOVNC_BASE_URL", novncBaseRaw)
    : gatewayBase
      ? joinUrl(gatewayBase, "novnc")
      : null;
  const bootstrapAssetBaseUrl = resolveBootstrapAssetBaseUrl();
  const controlUiManifestRaw = getOptionalEnv("OCTOGEN_CONTROL_UI_MANIFEST_URL");
  const controlUiManifestUrl = controlUiManifestRaw
    ? ensureAbsoluteUrl("OCTOGEN_CONTROL_UI_MANIFEST_URL", controlUiManifestRaw)
    : null;

  const vmGatewayTemplate =
    getOptionalEnv("OCTOGEN_VM_GATEWAY_TEMPLATE") || "https://{{IPV4}}.sslip.io";
  if (
    !vmGatewayTemplate.includes("{{IPV4}}") &&
    !vmGatewayTemplate.includes("{{VM_ID}}") &&
    !vmGatewayTemplate.includes("{{INSTANCE_ID}}")
  ) {
    throw new OctogenServiceError(
      "CONFIG_INVALID",
      `${formatEnvName("OCTOGEN_VM_GATEWAY_TEMPLATE")} must include {{IPV4}}, {{VM_ID}}, or {{INSTANCE_ID}}`,
      503,
    );
  }

  const controlSessionTtlSeconds = Math.max(
    OCTOGEN_MIN_CONTROL_SESSION_TTL_SECONDS,
    Math.floor(
      getNumberEnv(
        "OCTOGEN_CONTROL_SESSION_TTL_SECONDS",
        OCTOGEN_DEFAULT_CONTROL_SESSION_TTL_SECONDS,
      ),
    ),
  );

  const openClawInstallSpec = getOptionalEnv("OCTOGEN_OPENCLAW_INSTALL_SPEC") || null;
  const openClawVersion =
    getOptionalEnv("OCTOGEN_OPENCLAW_VERSION") || OCTOGEN_DEFAULT_OPENCLAW_VERSION;

  return {
    hetznerApiToken: getRequiredEnv("OCTOGEN_HETZNER_API_TOKEN"),
    hetznerLocation: getOptionalEnv("OCTOGEN_HETZNER_LOCATION") || "sin",
    hetznerServerType: getOptionalEnv("OCTOGEN_HETZNER_SERVER_TYPE") || "cpx31",
    hetznerImage: getOptionalEnv("OCTOGEN_HETZNER_IMAGE") || "ubuntu-22.04",
    hetznerSshKeys: getListEnv("OCTOGEN_HETZNER_SSH_KEYS").map(normalizeHetznerSshKeyRef),
    bootstrapAssetBaseUrl,
    controlUiManifestUrl,
    vmNamePrefix: (getOptionalEnv("OCTOGEN_VM_NAME_PREFIX") || "octogen").toLowerCase(),
    gatewayBaseUrl: gatewayBase,
    controlUiBaseUrl: controlUiBase,
    novncBaseUrl: novncBase,
    vmGatewayTemplate,
    controlUiPath: normalizePathSegment(
      "OCTOGEN_CONTROL_UI_PATH",
      getOptionalEnv("OCTOGEN_CONTROL_UI_PATH"),
      "octogen",
    ),
    novncPath: normalizePathSegment(
      "OCTOGEN_NOVNC_PATH",
      getOptionalEnv("OCTOGEN_NOVNC_PATH"),
      "novnc",
    ),
    controlUiAllowedOrigin: resolveControlUiAllowedOrigin(),
    proxySharedSecret: getRequiredEnv("OCTOGEN_PROXY_SHARED_SECRET"),
    controlSessionTtlSeconds,
    novncSessionTtlMinutes: getNumberEnv("OCTOGEN_NOVNC_TTL_MINUTES", 30),
    provisioningTimeoutSeconds: getNumberEnv(
      "OCTOGEN_PROVISIONING_TIMEOUT_SECONDS",
      DEFAULT_PROVISIONING_TIMEOUT_SECONDS,
    ),
    defaultCloudInit: getOptionalEnv("OCTOGEN_HETZNER_CLOUD_INIT") || "",
    openClawBootstrapCommand: getOptionalEnv("OCTOGEN_OPENCLAW_BOOTSTRAP_COMMAND") || "",
    openClawVersion,
    openClawInstallSpec,
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

export class OctogenService {
  private readonly config: OctogenConfig;
  private readonly hetzner: OctogenHetznerService;
  private readonly gatewayDeviceIdentity: GatewayDeviceIdentity;

  constructor(config?: OctogenConfig) {
    this.config = config || loadOctogenConfig();
    this.hetzner = new OctogenHetznerService(this.config.hetznerApiToken);
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
      openClawInstallSpec: this.config.openClawInstallSpec || undefined,
      gatewayBaseUrl: this.config.gatewayBaseUrl,
      gatewayMode: this.config.vmGatewayTemplate ? "per_instance" : "shared_proxy",
      controlUiPath: this.config.controlUiPath,
      novncPath: this.config.novncPath,
    };
  }

  async getCurrentWorkspaceVm(userId: string, workspaceId: string): Promise<OctogenVm | null> {
    const health = await this.getVmHealth(userId, workspaceId, { syncProvider: true });
    return health.vm;
  }

  async getWorkspaceBillingSummary(
    userId: string,
    options?: { workspaceId?: string | null; organizationId?: string | null },
  ): Promise<OctogenWorkspaceBillingSummary> {
    const requestedOrganizationId =
      options?.workspaceId?.trim() || options?.organizationId?.trim() || null;
    const baseSummary: OctogenWorkspaceBillingSummary = {
      status: "ok",
      currency: "USD",
      organizationMembershipCount: 0,
      organizationSubscriptionCount: 0,
      organizationPrepaidBalance: 0,
      selectedOrganizationId: null,
      selectedOrganizationName: null,
      selectedOrganizationPrepaidBalance: null,
      organizations: [],
    };

    try {
      const { data: memberships, error: membershipError } = await supabaseAdmin
        .from("organization_members")
        .select("organization_id, organizations(id, name, slug)")
        .eq("user_id", userId);

      if (membershipError) {
        throw membershipError;
      }

      const membershipsList = (memberships as OrganizationMembershipRow[] | null) || [];
      const organizationProfiles = new Map<
        string,
        { id: string; name: string; slug: string | null }
      >();

      for (const row of membershipsList) {
        const organizationId =
          typeof row.organization_id === "string" ? row.organization_id.trim() : "";
        if (!organizationId) {
          continue;
        }
        if (!organizationProfiles.has(organizationId)) {
          organizationProfiles.set(organizationId, {
            id: organizationId,
            name: "Workspace",
            slug: null,
          });
        }

        const rawOrg = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
        if (!rawOrg || typeof rawOrg !== "object") {
          continue;
        }
        const profile = organizationProfiles.get(organizationId);
        if (!profile) {
          continue;
        }

        const name = typeof rawOrg.name === "string" ? rawOrg.name.trim() : "";
        const slug = typeof rawOrg.slug === "string" ? rawOrg.slug.trim() : "";
        profile.name = name || profile.name;
        profile.slug = slug || profile.slug;
      }

      const organizationIds = [...organizationProfiles.keys()];

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

      const organizations = organizationIds
        .map((organizationId) => {
          const profile = organizationProfiles.get(organizationId);
          const prepaidBalance = latestBalancePerOrg.get(organizationId) ?? 0;
          return {
            id: organizationId,
            name: profile?.name || "Workspace",
            slug: profile?.slug || null,
            prepaidBalance,
            hasActiveSubscription: latestBalancePerOrg.has(organizationId),
          } satisfies OctogenWorkspaceBillingOrganization;
        })
        .toSorted((left, right) => left.name.localeCompare(right.name));

      const selectedOrganization =
        requestedOrganizationId && organizationProfiles.has(requestedOrganizationId)
          ? organizations.find((organization) => organization.id === requestedOrganizationId) ||
            null
          : organizations.length === 1
            ? organizations[0]
            : null;

      const selectionWarning =
        requestedOrganizationId && !organizationProfiles.has(requestedOrganizationId)
          ? "Selected workspace is not available to your account. Showing all workspace balances."
          : undefined;

      return {
        ...baseSummary,
        organizationMembershipCount: organizationIds.length,
        organizationSubscriptionCount: latestBalancePerOrg.size,
        organizationPrepaidBalance,
        selectedOrganizationId: selectedOrganization?.id || null,
        selectedOrganizationName: selectedOrganization?.name || null,
        selectedOrganizationPrepaidBalance: selectedOrganization?.prepaidBalance ?? null,
        organizations,
        ...(selectionWarning ? { message: selectionWarning } : {}),
      };
    } catch (error) {
      const schemaNotReady = isSchemaAvailabilityError(error);
      if (!schemaNotReady) {
        console.error("[Octogen Console] Failed to load organization prepaid balance", {
          userId,
          error: safeErrorMessage(error),
        });
      }

      return {
        ...baseSummary,
        status: "unavailable",
        message: schemaNotReady
          ? "Workspace billing data is not initialized yet."
          : "Workspace billing data is temporarily unavailable.",
      };
    }
  }

  async provisionWorkspaceVm(
    userId: string,
    workspaceId: string,
  ): Promise<{
    vm: OctogenVm;
    created: boolean;
    reused: boolean;
  }> {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId) {
      throw new OctogenServiceError("WORKSPACE_REQUIRED", "Workspace ID is required", 400);
    }

    let vm = await this.findPrimaryVmByWorkspaceId(normalizedWorkspaceId);
    let forceProvision = false;

    if (vm?.hetzner_server_id) {
      try {
        const providerServer = await this.hetzner.getServer(vm.hetzner_server_id);
        const providerStatus = this.mapHetznerStatus(providerServer.status);
        const startupTimedOut =
          providerStatus === "running" &&
          !vm.provisioned_at &&
          this.isProvisioningStale(vm.provisioning_started_at);
        const shouldReprovision = vm.status === "error" || startupTimedOut;

        if (shouldReprovision) {
          await this.logEvent(
            vm.id,
            userId,
            "reprovision.start",
            "Reprovisioning VM after startup failure",
            {
              previousHetznerServerId: providerServer.id,
              previousStatus: vm.status,
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

          vm = await this.resetVmForProvisioning(vm, userId, normalizedWorkspaceId);
          forceProvision = true;
        } else {
          const provisionedAtPatch =
            providerStatus === "running" && !vm.provisioned_at
              ? { provisioned_at: new Date().toISOString() }
              : {};
          const synced = await this.persistProviderState(vm.id, providerServer, {
            status: providerStatus,
            last_error: null,
            ...provisionedAtPatch,
          });
          return {
            vm: synced,
            created: false,
            reused: true,
          };
        }
      } catch (error) {
        if (this.isProviderServerMissing(error)) {
          vm = await this.markVmTerminated(vm, userId, "VM was deleted from Hetzner.");
        } else {
          throw this.normalizeProviderError(error);
        }
      }
    }

    if (
      !forceProvision &&
      vm &&
      vm.status === "provisioning" &&
      !this.isProvisioningStale(vm.provisioning_started_at)
    ) {
      return {
        vm,
        created: false,
        reused: true,
      };
    }

    if (!vm) {
      vm = await this.createSeedVm(userId, normalizedWorkspaceId);
    } else if (!forceProvision) {
      vm = await this.resetVmForProvisioning(vm, userId, normalizedWorkspaceId);
    }

    await this.logEvent(vm.id, userId, "provision.start", "Provisioning dedicated Hetzner VM", {
      location: this.config.hetznerLocation,
      serverType: this.config.hetznerServerType,
      image: this.config.hetznerImage,
    });

    try {
      const cloudInit = this.renderCloudInit(userId, vm.id);
      const createResult = await this.hetzner.createServer({
        name: vm.server_name,
        serverType: this.config.hetznerServerType,
        image: this.config.hetznerImage,
        location: this.config.hetznerLocation,
        sshKeys: this.config.hetznerSshKeys.length > 0 ? this.config.hetznerSshKeys : undefined,
        userData: cloudInit || undefined,
        labels: {
          product: "octogen",
          tenant: normalizedWorkspaceId,
          environment: "phase1",
        },
      });

      const metadata = {
        ...vm.metadata,
        hetzner_action_id: createResult.actionId,
        trusted_proxy_mode: "trusted-proxy",
      };

      const updated = await this.persistProviderState(vm.id, createResult.server, {
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
        vm: updated,
        created: true,
        reused: false,
      };
    } catch (error) {
      const normalizedError = this.normalizeProviderError(error);
      const provisionRejectedBeforeServerCreation =
        !vm.hetzner_server_id &&
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

      await this.updateVm(vm.id, patch);
      await this.logEvent(
        vm.id,
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

  async getVmHealth(
    userId: string,
    workspaceId: string,
    options?: { syncProvider?: boolean },
  ): Promise<OctogenVmHealth> {
    const checkedAt = new Date().toISOString();
    const current = await this.findPrimaryVmByWorkspaceId(workspaceId);

    if (!current) {
      return {
        vm: null,
        providerStatus: null,
        checkedAt,
      };
    }

    if (options?.syncProvider === false) {
      return {
        vm: current,
        providerStatus: current.status,
        checkedAt,
      };
    }

    if (!current.hetzner_server_id) {
      const normalizedCurrent = await this.normalizeDetachedVm(current);
      return {
        vm: normalizedCurrent,
        providerStatus: normalizedCurrent.status,
        checkedAt,
      };
    }

    try {
      const providerServer = await this.hetzner.getServer(current.hetzner_server_id);
      const providerStatus = this.mapHetznerStatus(providerServer.status);
      let derivedStatus: OctogenVmStatus = providerStatus;
      let derivedError: string | null = null;
      let provisionedAtPatch: Record<string, unknown> = {};

      if (providerStatus === "running") {
        const gatewayUrl =
          this.buildVmGatewayUrl({
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
          if (gatewayProbe.code === "bootstrap_failed") {
            derivedStatus = "error";
            derivedError = gatewayProbe.reason || "OpenClaw bootstrap failed.";
          } else {
            // Once the gateway has been reachable at least once, transient probe failures
            // should not bounce the UI back into "Starting" (especially mid-wizard).
            if (!everReady) {
              const provisioningElapsedMs =
                Date.now() - new Date(current.provisioning_started_at).getTime();
              const probeTimedOut = (gatewayProbe.reason || "")
                .toLowerCase()
                .includes("probe timed out");
              // Some environments can intermittently fail console -> VM probes even while
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
                  ? `OpenClaw startup timed out (${gatewayProbe.reason || "gateway not reachable"}). Click Redeploy VM to replace this VM.`
                  : gatewayStalled
                    ? `OpenClaw gateway did not become reachable after ${Math.round(
                        GATEWAY_UPSTREAM_BOOT_TIMEOUT_MS / 60_000,
                      )} minutes (${gatewayProbe.reason || "openclaw upstream unavailable"}). Click Redeploy VM to replace this VM.`
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
      const synced = await this.syncPendingGatewayAuthAfterHealthCheck(updated, userId);

      return {
        vm: synced,
        providerStatus: providerServer.status,
        checkedAt,
      };
    } catch (error) {
      if (this.isProviderServerMissing(error)) {
        await this.markVmTerminated(current, userId, "VM was deleted from Hetzner.");
        return {
          vm: null,
          providerStatus: null,
          checkedAt,
          error: "Your previous VM was removed. Deploy a new one to continue.",
        };
      }

      const message = safeErrorMessage(error);
      await this.updateVm(current.id, {
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

      const refreshed = await this.findPrimaryVmByWorkspaceId(workspaceId);
      return {
        vm: refreshed || current,
        providerStatus: null,
        checkedAt,
        error: message,
      };
    }
  }

  async recoverVm(
    userId: string,
    workspaceId: string,
  ): Promise<{
    vm: OctogenVm;
    action: "poweron" | "reboot";
  }> {
    const vm = await this.requireVmWithServer(workspaceId);
    const serverId = vm.hetzner_server_id;
    if (!serverId) {
      throw new OctogenServiceError("VM_NOT_READY", "VM has not finished provisioning", 409);
    }

    const server = await this.hetzner.getServer(serverId);
    const action: "poweron" | "reboot" = server.status === "off" ? "poweron" : "reboot";

    await this.hetzner.runAction(serverId, action);
    const updated = await this.updateVm(vm.id, {
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
      vm: updated,
      action,
    };
  }

  async launchControlUi(
    userId: string,
    workspaceId: string,
    requestMeta?: OctogenRequestMeta,
  ): Promise<{
    vm: OctogenVm;
    launchUrl: string;
    expiresAt: string;
  }> {
    const health = await this.getVmHealth(userId, workspaceId, { syncProvider: true });
    if (!health.vm) {
      throw new OctogenServiceError("VM_NOT_FOUND", "No VM exists for this workspace yet", 404);
    }
    if (health.vm.status !== "running") {
      throw new OctogenServiceError(
        "VM_NOT_RUNNING",
        "VM is not running. Please recover first.",
        409,
      );
    }
    if (!this.isTerminalOnboardingCompleted(health.vm)) {
      throw new OctogenServiceError(
        "ONBOARDING_REQUIRED",
        "Complete terminal onboarding before launching gateway.",
        409,
      );
    }

    let launchVm = health.vm;

    const session = await this.createControlGatewaySession(launchVm, userId, requestMeta, {
      syncControlUiOrigins: true,
      strictControlUiOriginSync: true,
    });

    launchVm = await this.applyPendingGatewayAuthIfPresent({
      vm: launchVm,
      userId,
      gatewayWebSocketUrl: session.gatewayWebSocketUrl,
      token: session.token,
      requestMeta,
    });
    await this.syncManagedTrustedProxyAllowUserBestEffort({
      instanceId: launchVm.id,
      userId,
      gatewayWebSocketUrl: session.gatewayWebSocketUrl,
      token: session.token,
      reason: "launch",
    });

    const controlUiBase = this.ensureTrailingSlash(
      this.resolveLaunchBaseUrl(launchVm, "control_ui"),
    );
    const gatewayWebSocketUrl = this.withQuery(this.toWebSocketUrl(controlUiBase), {
      instanceId: launchVm.id,
      token: session.token,
      mode: "trusted-proxy",
    });
    const launchUrl = this.withQuery(controlUiBase, {
      instanceId: launchVm.id,
      token: session.token,
      mode: "trusted-proxy",
      gatewayUrl: gatewayWebSocketUrl,
      session: DEFAULT_MAIN_SESSION_KEY,
    });

    const gatewayBaseUrl = launchVm.gateway_url || this.buildGatewayTenantUrl(launchVm.id);
    const shouldPreflightLaunch = !launchVm.provisioned_at;
    if (shouldPreflightLaunch) {
      await this.ensureControlUiLaunchable(launchVm, launchUrl, gatewayBaseUrl);
    }
    await this.syncGatewayMainSessionModelBestEffort({
      instanceId: launchVm.id,
      userId,
      gatewayWebSocketUrl,
      token: session.token,
      reason: "launch",
    });

    await this.logEvent(
      launchVm.id,
      userId,
      "session.control_ui",
      "Control UI launch session created",
      {
        expiresAt: session.expiresAt,
        ip: requestMeta?.ip || null,
      },
    );

    return {
      vm: launchVm,
      launchUrl,
      expiresAt: session.expiresAt,
    };
  }

  async configureOpenAiApiKey(
    userId: string,
    workspaceId: string,
    apiKey: string,
    requestMeta?: OctogenRequestMeta,
  ): Promise<{ vm: OctogenVm }> {
    const normalizedApiKey = apiKey.trim();
    if (!normalizedApiKey) {
      throw new OctogenServiceError("OPENAI_KEY_REQUIRED", "OpenAI API key is required", 400);
    }

    const health = await this.getVmHealth(userId, workspaceId, { syncProvider: true });
    if (!health.vm) {
      throw new OctogenServiceError("VM_NOT_FOUND", "No VM exists for this workspace yet", 404);
    }
    if (health.vm.status !== "running") {
      throw new OctogenServiceError(
        "VM_NOT_RUNNING",
        "VM is not running. Please recover first.",
        409,
      );
    }

    const session = await this.createControlGatewaySession(health.vm, userId, requestMeta, {
      syncControlUiOrigins: true,
      strictControlUiOriginSync: false,
    });
    await this.patchOpenAiProviderAndWorkspaceDefaults({
      userId,
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
      health.vm.id,
      userId,
      "auth.openai_api_key.updated",
      "Updated OpenAI API key for workspace",
      {
        ip: requestMeta?.ip || null,
        keyPrefix: normalizedApiKey.slice(0, 7),
      },
    );

    return { vm: health.vm };
  }

  async configureOpenAiCodexAccessToken(
    userId: string,
    workspaceId: string,
    accessToken: string,
    requestMeta?: OctogenRequestMeta,
  ): Promise<{ vm: OctogenVm }> {
    const normalizedAccessToken = accessToken.trim();
    if (!normalizedAccessToken) {
      throw new OctogenServiceError(
        "CODEX_TOKEN_REQUIRED",
        "OpenAI Codex access token is required",
        400,
      );
    }

    const health = await this.getVmHealth(userId, workspaceId, { syncProvider: true });
    if (!health.vm) {
      throw new OctogenServiceError("VM_NOT_FOUND", "No VM exists for this workspace yet", 404);
    }
    if (health.vm.status !== "running") {
      throw new OctogenServiceError(
        "VM_NOT_RUNNING",
        "VM is not running. Please recover first.",
        409,
      );
    }

    const session = await this.createControlGatewaySession(health.vm, userId, requestMeta, {
      syncControlUiOrigins: true,
      strictControlUiOriginSync: false,
    });
    await this.patchOpenAiProviderAndWorkspaceDefaults({
      userId,
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
      health.vm.id,
      userId,
      "auth.openai_codex_oauth.updated",
      "Updated OpenAI Codex OAuth access token for workspace",
      {
        ip: requestMeta?.ip || null,
        tokenPrefix: normalizedAccessToken.slice(0, 7),
      },
    );

    return { vm: health.vm };
  }

  private async applyPendingGatewayAuthIfPresent(params: {
    vm: OctogenVm;
    userId: string;
    gatewayWebSocketUrl: string;
    token: string;
    requestMeta?: OctogenRequestMeta;
    source?: string;
  }): Promise<OctogenVm> {
    const metadata =
      params.vm.metadata && typeof params.vm.metadata === "object" ? params.vm.metadata : {};
    const pending = this.readPendingGatewayAuthState(metadata);
    if (!pending) {
      return params.vm;
    }

    try {
      await this.patchOpenAiProviderAndWorkspaceDefaults({
        userId: params.userId,
        gatewayWebSocketUrl: params.gatewayWebSocketUrl,
        token: params.token,
        providerId: pending.providerId,
        apiKey: pending.accessToken,
        fallbackBaseUrl: OPENAI_CODEX_PROVIDER_DEFAULT_BASE_URL,
        modelRef: OPENAI_CODEX_DEFAULT_MODEL,
        alias: "Codex",
      });
      await this.patchGatewayMainSessionModel({
        gatewayWebSocketUrl: params.gatewayWebSocketUrl,
        token: params.token,
        modelRef: OPENAI_CODEX_DEFAULT_MODEL,
      });

      const updated = await this.updateVm(params.vm.id, {
        metadata: {
          ...metadata,
          pending_gateway_auth: null,
        },
      });

      await this.logEvent(
        updated.id,
        params.userId,
        "auth.pending.openai_codex_oauth.applied",
        `Applied pending OpenAI Codex OAuth auth during ${params.source || "launch"}`,
        {
          ip: params.requestMeta?.ip || null,
          tokenPrefix: pending.accessToken.slice(0, 7),
        },
      );

      return updated;
    } catch (error) {
      await this.logEvent(
        params.vm.id,
        params.userId,
        "auth.pending.openai_codex_oauth.apply_failed",
        `Failed to apply pending OpenAI Codex OAuth auth during ${params.source || "launch"}: ${safeErrorMessage(error)}`,
        {
          error: safeErrorMessage(error),
        },
        "warn",
      );
      return params.vm;
    }
  }

  private async syncPendingGatewayAuthAfterHealthCheck(
    vm: OctogenVm,
    userId: string,
  ): Promise<OctogenVm> {
    if (vm.status !== "running" || !vm.provisioned_at || !this.isTerminalOnboardingCompleted(vm)) {
      return vm;
    }
    const metadata = vm.metadata && typeof vm.metadata === "object" ? vm.metadata : {};
    if (!this.readPendingGatewayAuthState(metadata)) {
      return vm;
    }

    try {
      const session = await this.createControlGatewaySession(vm, userId, undefined, {
        syncControlUiOrigins: false,
        strictControlUiOriginSync: false,
      });
      return await this.applyPendingGatewayAuthIfPresent({
        vm,
        userId,
        gatewayWebSocketUrl: session.gatewayWebSocketUrl,
        token: session.token,
        source: "health sync",
      });
    } catch {
      return vm;
    }
  }

  async restartGateway(
    userId: string,
    workspaceId: string,
    requestMeta?: OctogenRequestMeta,
  ): Promise<{ vm: OctogenVm; restarted: boolean }> {
    const vm = await this.requireRunningVm(userId, workspaceId);
    const session = await this.createControlGatewaySession(vm, userId, requestMeta, {
      syncControlUiOrigins: true,
      strictControlUiOriginSync: false,
    });
    await this.syncManagedTrustedProxyAllowUserBestEffort({
      instanceId: vm.id,
      userId,
      gatewayWebSocketUrl: session.gatewayWebSocketUrl,
      token: session.token,
      reason: "gateway restart",
    });
    let managedUpdaterAttempted = false;
    let managedUpdaterApplied = false;
    if (this.config.controlUiManifestUrl) {
      managedUpdaterAttempted = true;
      const scriptUrls = this.resolveBootstrapScriptUrls();
      try {
        const updaterResult = await this.syncWorkspaceReleaseViaProxy({
          gatewayWebSocketUrl: session.gatewayWebSocketUrl,
          token: session.token,
          manifestUrl: this.config.controlUiManifestUrl,
          updaterScriptUrl: scriptUrls.controlUiUpdaterScriptUrl,
          proxyScriptUrl: scriptUrls.proxyScriptUrl,
        });
        managedUpdaterApplied = updaterResult.updated;
      } catch {
        managedUpdaterApplied = false;
      }
    }
    const restarted = await this.repairGatewayViaProxy({
      gatewayWebSocketUrl: session.gatewayWebSocketUrl,
      token: session.token,
      reason: "manual-gateway-restart",
    });
    await this.syncGatewayMainSessionModelBestEffort({
      instanceId: vm.id,
      userId,
      gatewayWebSocketUrl: session.gatewayWebSocketUrl,
      token: session.token,
      reason: "gateway restart",
    });

    await this.logEvent(
      vm.id,
      userId,
      restarted ? "gateway.restart" : "gateway.restart.degraded",
      restarted
        ? "Gateway restart requested from workspace"
        : "Gateway restart requested from workspace, but upstream did not report ready",
      {
        restarted,
        managedUpdaterAttempted,
        managedUpdaterApplied,
        ip: requestMeta?.ip || null,
      },
      restarted ? "info" : "warn",
    );

    return { vm, restarted };
  }

  async syncWorkspaceRelease(
    userId: string,
    workspaceId: string,
    requestMeta?: OctogenRequestMeta,
  ): Promise<{ vm: OctogenVm; updated: boolean; message: string }> {
    const vm = await this.requireRunningVm(userId, workspaceId);
    const session = await this.createControlGatewaySession(vm, userId, requestMeta, {
      syncControlUiOrigins: true,
      strictControlUiOriginSync: false,
    });

    if (!this.config.controlUiManifestUrl) {
      throw new OctogenServiceError(
        "WORKSPACE_RELEASE_MANIFEST_MISSING",
        "Workspace release manifest URL is not configured on this deployment.",
        503,
      );
    }

    const scriptUrls = this.resolveBootstrapScriptUrls();
    const result = await this.syncWorkspaceReleaseViaProxy({
      gatewayWebSocketUrl: session.gatewayWebSocketUrl,
      token: session.token,
      manifestUrl: this.config.controlUiManifestUrl,
      updaterScriptUrl: scriptUrls.controlUiUpdaterScriptUrl,
      proxyScriptUrl: scriptUrls.proxyScriptUrl,
    });
    await this.syncManagedTrustedProxyAllowUserBestEffort({
      instanceId: vm.id,
      userId,
      gatewayWebSocketUrl: session.gatewayWebSocketUrl,
      token: session.token,
      reason: "workspace release update",
    });
    await this.syncGatewayMainSessionModelBestEffort({
      instanceId: vm.id,
      userId,
      gatewayWebSocketUrl: session.gatewayWebSocketUrl,
      token: session.token,
      reason: "workspace release update",
    });
    const message = result.updated
      ? "Workspace release updated on this VM. Refresh Gateway to load the latest runtime and interface."
      : "Workspace release is already on the latest version for this VM.";

    await this.logEvent(
      vm.id,
      userId,
      "workspace.release.sync",
      result.updated ? "Updated workspace release on VM" : "Workspace release already up to date",
      {
        updated: result.updated,
        currentRoot: result.currentRoot,
        ip: requestMeta?.ip || null,
      },
    );

    return { vm, updated: result.updated, message };
  }

  private async patchOpenAiProviderAndWorkspaceDefaults(params: {
    userId: string;
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

    const defaultsPatch = buildOctogenGatewayDefaultsPatch(snapshot?.config, false);
    const trustedProxyAllowUsersPatch = buildOctogenTrustedProxyAllowUsersPatch(
      snapshot?.config,
      params.userId,
      true,
    );
    const defaultsAgentDefaults = asObjectRecord(asObjectRecord(defaultsPatch?.agents)?.defaults);
    const defaultsMemorySearch = asObjectRecord(defaultsAgentDefaults?.memorySearch);
    const defaultsMemoryRemote = asObjectRecord(defaultsMemorySearch?.remote);
    const defaultsMemoryBatch = asObjectRecord(defaultsMemoryRemote?.batch);

    let mergedMemorySearch: Record<string, unknown> | undefined = defaultsMemorySearch
      ? { ...defaultsMemorySearch }
      : undefined;
    if (params.providerId === "openai") {
      const existingBatchConcurrency =
        typeof defaultsMemoryBatch?.concurrency === "number" &&
        Number.isFinite(defaultsMemoryBatch.concurrency)
          ? Math.max(1, Math.floor(defaultsMemoryBatch.concurrency))
          : 2;
      mergedMemorySearch = {
        ...mergedMemorySearch,
        enabled: true,
        provider: "openai",
        model: OPENAI_MEMORY_EMBED_MODEL,
        fallback: "openai",
        remote: {
          ...defaultsMemoryRemote,
          apiKey: params.apiKey,
          batch: {
            ...defaultsMemoryBatch,
            enabled:
              typeof defaultsMemoryBatch?.enabled === "boolean"
                ? defaultsMemoryBatch.enabled
                : true,
            wait: typeof defaultsMemoryBatch?.wait === "boolean" ? defaultsMemoryBatch.wait : true,
            concurrency: existingBatchConcurrency,
          },
        },
      };
    }

    const currentDefaultAgentId = resolveDefaultAgentIdFromGatewayConfig(snapshot?.config);
    const configAgents = asObjectRecord(config?.agents);
    const configAgentsList = Array.isArray(configAgents?.list) ? configAgents.list : [];
    const hasExplicitDefaultAgent = configAgentsList.some((entry) => {
      const record = asObjectRecord(entry);
      return (
        typeof record?.id === "string" &&
        record.id.trim().toLowerCase() === currentDefaultAgentId.toLowerCase()
      );
    });

    const mergedAgentDefaults: Record<string, unknown> = {
      ...defaultsAgentDefaults,
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
      ...defaultsPatch,
      ...trustedProxyAllowUsersPatch,
      models: {
        providers: {
          [params.providerId]: providerPatch,
        },
      },
      agents: {
        defaults: mergedAgentDefaults,
        ...(hasExplicitDefaultAgent
          ? {
              list: [
                {
                  id: currentDefaultAgentId,
                  model: {
                    primary: modelRef,
                  },
                },
              ],
            }
          : {}),
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
      await this.requestGatewayMethod(params.gatewayWebSocketUrl, params.token, "sessions.patch", {
        key: DEFAULT_MAIN_SESSION_KEY,
        model: modelRef,
      });
    } catch {
      // Best-effort: keep auth setup successful even if main session wasn't created yet.
    }
  }

  private async syncGatewayMainSessionModelFromConfig(params: {
    gatewayWebSocketUrl: string;
    token: string;
  }): Promise<void> {
    const snapshot = await this.requestGatewayMethod<{ config?: unknown }>(
      params.gatewayWebSocketUrl,
      params.token,
      "config.get",
      {},
    );
    const modelRef = resolveGatewayPrimaryModelRef(snapshot?.config);
    if (!modelRef) {
      return;
    }
    await this.patchGatewayMainSessionModel({
      gatewayWebSocketUrl: params.gatewayWebSocketUrl,
      token: params.token,
      modelRef,
    });
  }

  private async syncGatewayMainSessionModelBestEffort(params: {
    instanceId: string;
    userId: string;
    gatewayWebSocketUrl: string;
    token: string;
    reason: string;
  }): Promise<void> {
    try {
      await this.syncGatewayMainSessionModelFromConfig({
        gatewayWebSocketUrl: params.gatewayWebSocketUrl,
        token: params.token,
      });
    } catch (error) {
      await this.logEvent(
        params.instanceId,
        params.userId,
        "gateway.main_session_model.sync_failed",
        `Failed to sync main chat session model during ${params.reason}: ${safeErrorMessage(error)}`,
        { error: safeErrorMessage(error), reason: params.reason },
        "warn",
      );
    }
  }

  private async syncManagedTrustedProxyAllowUser(params: {
    userId: string;
    gatewayWebSocketUrl: string;
    token: string;
    force?: boolean;
  }): Promise<void> {
    const snapshot = await this.requestGatewayMethod<{ config?: unknown }>(
      params.gatewayWebSocketUrl,
      params.token,
      "config.get",
      {},
    );
    const patch = buildOctogenTrustedProxyAllowUsersPatch(
      snapshot?.config,
      params.userId,
      params.force !== false,
    );
    if (!patch) {
      return;
    }
    await this.patchGatewayConfig(params.gatewayWebSocketUrl, params.token, patch);
  }

  private async syncManagedTrustedProxyAllowUserBestEffort(params: {
    instanceId: string;
    userId: string;
    gatewayWebSocketUrl: string;
    token: string;
    reason: string;
  }): Promise<void> {
    try {
      await this.syncManagedTrustedProxyAllowUser({
        userId: params.userId,
        gatewayWebSocketUrl: params.gatewayWebSocketUrl,
        token: params.token,
      });
    } catch (error) {
      await this.logEvent(
        params.instanceId,
        params.userId,
        "gateway.trusted_proxy_allow_users.sync_failed",
        `Failed to sync trusted-proxy allowUsers during ${params.reason}: ${safeErrorMessage(error)}`,
        { error: safeErrorMessage(error), reason: params.reason },
        "warn",
      );
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

  private readPendingGatewayAuthState(
    metadata: Record<string, unknown>,
  ): PendingGatewayAuthState | null {
    const raw = (metadata as { pending_gateway_auth?: unknown }).pending_gateway_auth;
    const record = asObjectRecord(raw);
    if (!record) {
      return null;
    }
    const providerId = typeof record.providerId === "string" ? record.providerId.trim() : "";
    const accessToken = typeof record.accessToken === "string" ? record.accessToken.trim() : "";
    const createdAtMsRaw =
      typeof record.createdAtMs === "number" && Number.isFinite(record.createdAtMs)
        ? Math.floor(record.createdAtMs)
        : typeof record.createdAtMs === "string"
          ? Number(record.createdAtMs)
          : Number.NaN;
    if (providerId !== "openai-codex" || !accessToken || !Number.isFinite(createdAtMsRaw)) {
      return null;
    }
    return {
      providerId: "openai-codex",
      accessToken,
      createdAtMs: createdAtMsRaw,
    };
  }

  private createPendingGatewayAuthState(accessToken: string): PendingGatewayAuthState {
    return {
      providerId: "openai-codex",
      accessToken: accessToken.trim(),
      createdAtMs: Date.now(),
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
        typeof payloadRecord?.error_description === "string" &&
        payloadRecord.error_description.trim()
          ? payloadRecord.error_description.trim()
          : typeof payloadRecord?.error === "string" && payloadRecord.error.trim()
            ? payloadRecord.error.trim()
            : null;
      throw new OctogenServiceError(
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
      throw new OctogenServiceError(
        "CODEX_OAUTH_EXCHANGE_FAILED",
        "ChatGPT OAuth did not return an access token. Please retry login.",
        409,
      );
    }
    return { accessToken };
  }

  async startTerminalOnboarding(
    userId: string,
    workspaceId: string,
    requestMeta?: OctogenRequestMeta,
  ): Promise<{ vm: OctogenVm; sessionId: string; result: OnboardingWizardResult }> {
    const vm = await this.requireRunningVm(userId, workspaceId);

    // Octogen Console uses a stateless (console managed) wizard. We intentionally
    // avoid OpenClaw's in-memory gateway wizard sessions because any restart
    // wipes progress and causes flaky UX in hosted VM setups.
    const sessionId = randomUUID();
    const metadata = vm.metadata && typeof vm.metadata === "object" ? vm.metadata : {};
    const updatedVm = await this.updateVm(vm.id, {
      metadata: {
        ...metadata,
        trusted_proxy_mode: "trusted-proxy",
        onboarding_completed: false,
        onboarding_completed_at: null,
        onboarding_last_status: "running",
        onboarding_session_id: sessionId,
        onboarding_step_id: OCTOGEN_WIZARD_STEP_AUTH_METHOD,
        onboarding_auth_method: null,
        onboarding_codex_session_id: null,
        onboarding_codex_oauth: null,
      },
    });

    await this.logEvent(
      vm.id,
      userId,
      "onboarding.octogen.start",
      "Started OCTOGEN CONSOLE setup wizard",
      {
        sessionId,
        ip: requestMeta?.ip || null,
      },
    );

    return {
      vm: updatedVm,
      sessionId,
      result: {
        done: false,
        status: "running",
        step: {
          id: OCTOGEN_WIZARD_STEP_AUTH_METHOD,
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
    workspaceId: string,
    params: {
      sessionId: string;
      answer?: {
        stepId: string;
        value: unknown;
      };
    },
    requestMeta?: OctogenRequestMeta,
  ): Promise<{ vm: OctogenVm; result: OnboardingWizardResult }> {
    const sessionId = params.sessionId.trim();
    if (!sessionId) {
      throw new OctogenServiceError(
        "WIZARD_SESSION_REQUIRED",
        "Onboarding session ID is required",
        400,
      );
    }

    const vm = await this.requireRunningVm(userId, workspaceId);
    const metadata = vm.metadata && typeof vm.metadata === "object" ? vm.metadata : {};
    const activeSessionId =
      typeof (metadata as { onboarding_session_id?: unknown }).onboarding_session_id === "string"
        ? String((metadata as { onboarding_session_id: string }).onboarding_session_id).trim()
        : "";
    const stepId =
      typeof (metadata as { onboarding_step_id?: unknown }).onboarding_step_id === "string"
        ? String((metadata as { onboarding_step_id: string }).onboarding_step_id).trim()
        : "";

    if (!activeSessionId || activeSessionId !== sessionId || !stepId) {
      throw new OctogenServiceError(
        "WIZARD_SESSION_EXPIRED",
        "Setup wizard session expired. Please start cooking wizard again.",
        409,
      );
    }

    const answer = params.answer;
    const answerStepId = answer?.stepId?.trim() || "";
    const answerValue = answer?.value;
    if (!answerStepId) {
      throw new OctogenServiceError("WIZARD_STEP_REQUIRED", "Onboarding step ID is required", 400);
    }
    if (answerStepId !== stepId) {
      throw new OctogenServiceError(
        "WIZARD_STEP_MISMATCH",
        "Wizard step mismatch. Please refresh and retry.",
        409,
      );
    }

    const setWizardState = async (patch: Record<string, unknown>): Promise<OctogenVm> => {
      return await this.updateVm(vm.id, {
        metadata: {
          ...metadata,
          ...patch,
        },
      });
    };

    if (stepId === OCTOGEN_WIZARD_STEP_AUTH_METHOD) {
      const methodRaw = typeof answerValue === "string" ? answerValue.trim() : "";
      const authMethod: OctogenWizardAuthMethod | null =
        methodRaw === "openai_api_key" || methodRaw === "openai_codex_oauth"
          ? (methodRaw as OctogenWizardAuthMethod)
          : null;
      if (!authMethod) {
        throw new OctogenServiceError("WIZARD_INVALID_VALUE", "Invalid auth method selection", 400);
      }

      if (authMethod === "openai_api_key") {
        const updated = await setWizardState({
          onboarding_step_id: OCTOGEN_WIZARD_STEP_OPENAI_API_KEY,
          onboarding_auth_method: authMethod,
          onboarding_codex_session_id: null,
          onboarding_codex_oauth: null,
        });
        return {
          vm: updated,
          result: {
            done: false,
            status: "running",
            step: {
              id: OCTOGEN_WIZARD_STEP_OPENAI_API_KEY,
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
        onboarding_step_id: OCTOGEN_WIZARD_STEP_CODEX_CALLBACK_URL,
        onboarding_auth_method: authMethod,
        onboarding_codex_session_id: null,
        onboarding_codex_oauth: null,
      });
      return {
        vm: updated,
        result: {
          done: false,
          status: "running",
          step: {
            id: OCTOGEN_WIZARD_STEP_CODEX_CALLBACK_URL,
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

    if (stepId === OCTOGEN_WIZARD_STEP_OPENAI_API_KEY) {
      const apiKey = typeof answerValue === "string" ? answerValue.trim() : "";
      if (!apiKey) {
        throw new OctogenServiceError("OPENAI_API_KEY_REQUIRED", "API key is required", 400);
      }

      await this.configureGatewayAuthWithWarmupRetry(() =>
        this.configureOpenAiApiKey(userId, workspaceId, apiKey, requestMeta),
      );
      const cleared = await this.finishTerminalOnboarding(vm);

      return {
        vm: cleared,
        result: { done: true, status: "done" },
      };
    }

    if (stepId === OCTOGEN_WIZARD_STEP_CODEX_CALLBACK_URL) {
      const callbackUrl = typeof answerValue === "string" ? answerValue.trim() : "";
      const oauthState = this.readOnboardingCodexOAuthState(metadata);
      if (!oauthState) {
        throw new OctogenServiceError(
          "CODEX_OAUTH_NOT_STARTED",
          'Click "Login with ChatGPT" first, then paste the callback URL here.',
          409,
        );
      }
      if (this.isOnboardingCodexOAuthStateExpired(oauthState)) {
        throw new OctogenServiceError(
          "CODEX_OAUTH_EXPIRED",
          "OAuth session expired. Click Login with ChatGPT again and paste the new callback URL.",
          409,
        );
      }

      let accessToken = oauthState.accessToken?.trim() || "";
      if (!accessToken) {
        if (!callbackUrl) {
          throw new OctogenServiceError(
            "CODEX_CALLBACK_URL_REQUIRED",
            "Redirect URL is required",
            400,
          );
        }
        const parsed = this.parseCodexCallbackInput(callbackUrl);
        if (parsed.error) {
          throw new OctogenServiceError(
            "CODEX_CALLBACK_REJECTED",
            `ChatGPT OAuth callback returned an error: ${parsed.error}`,
            409,
          );
        }
        if (!parsed.code) {
          throw new OctogenServiceError(
            "CODEX_CALLBACK_URL_INVALID",
            "Callback URL is missing an authorization code.",
            400,
          );
        }
        if (parsed.state && parsed.state !== oauthState.state) {
          throw new OctogenServiceError(
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

      let cleared: OctogenVm;
      try {
        await this.configureGatewayAuthWithWarmupRetry(() =>
          this.configureOpenAiCodexAccessToken(userId, workspaceId, accessToken, requestMeta),
        );
        cleared = await this.finishTerminalOnboarding(vm);
      } catch (error) {
        if (!(error instanceof OctogenServiceError) || error.code !== "GATEWAY_WARMING_UP") {
          throw error;
        }
        cleared = await this.finishTerminalOnboarding(vm, {
          pending_gateway_auth: this.createPendingGatewayAuthState(accessToken),
        });
      }

      return {
        vm: cleared,
        result: { done: true, status: "done" },
      };
    }

    throw new OctogenServiceError(
      "WIZARD_STEP_UNKNOWN",
      "Wizard step not found. Please start cooking wizard again.",
      409,
    );
  }

  async cancelTerminalOnboarding(
    userId: string,
    workspaceId: string,
    sessionId: string,
    requestMeta?: OctogenRequestMeta,
  ): Promise<{ vm: OctogenVm; status: OnboardingWizardStatusResult }> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new OctogenServiceError(
        "WIZARD_SESSION_REQUIRED",
        "Onboarding session ID is required",
        400,
      );
    }

    const vm = await this.requireRunningVm(userId, workspaceId);
    const metadata = vm.metadata && typeof vm.metadata === "object" ? vm.metadata : {};
    const activeSessionId =
      typeof (metadata as { onboarding_session_id?: unknown }).onboarding_session_id === "string"
        ? String((metadata as { onboarding_session_id: string }).onboarding_session_id).trim()
        : "";
    if (activeSessionId && activeSessionId !== normalizedSessionId) {
      throw new OctogenServiceError(
        "WIZARD_SESSION_EXPIRED",
        "Setup wizard session expired. Please start cooking wizard again.",
        409,
      );
    }

    const updatedVm = await this.updateOnboardingState(vm, {
      completed: false,
      status: "cancelled",
    });
    const cleared = await this.updateVm(updatedVm.id, {
      metadata: {
        ...(updatedVm.metadata && typeof updatedVm.metadata === "object" ? updatedVm.metadata : {}),
        onboarding_session_id: null,
        onboarding_step_id: null,
        onboarding_auth_method: null,
        onboarding_codex_session_id: null,
        onboarding_codex_oauth: null,
      },
    });

    await this.logEvent(
      vm.id,
      userId,
      "onboarding.octogen.cancel",
      "Cancelled OCTOGEN CONSOLE setup wizard",
      {
        sessionId: normalizedSessionId,
        ip: requestMeta?.ip || null,
      },
      "warn",
    );

    return {
      vm: cleared,
      status: {
        status: "cancelled",
      },
    };
  }

  async getLatestOpenAiCodexOAuthUrl(
    userId: string,
    workspaceId: string,
    requestMeta?: OctogenRequestMeta,
  ): Promise<{ vm: OctogenVm; authUrl: string | null }> {
    const vm = await this.requireRunningVm(userId, workspaceId);
    const metadata = vm.metadata && typeof vm.metadata === "object" ? vm.metadata : {};
    const stepId =
      typeof (metadata as { onboarding_step_id?: unknown }).onboarding_step_id === "string"
        ? String((metadata as { onboarding_step_id: string }).onboarding_step_id).trim()
        : "";
    const sessionId =
      typeof (metadata as { onboarding_session_id?: unknown }).onboarding_session_id === "string"
        ? String((metadata as { onboarding_session_id: string }).onboarding_session_id).trim()
        : "";

    if (!sessionId || stepId !== OCTOGEN_WIZARD_STEP_CODEX_CALLBACK_URL) {
      throw new OctogenServiceError(
        "CODEX_OAUTH_NOT_READY",
        "Start the cooking wizard and select OpenAI Codex (ChatGPT OAuth) first.",
        409,
      );
    }

    const existingOAuth = this.readOnboardingCodexOAuthState(metadata);
    if (existingOAuth && !this.isOnboardingCodexOAuthStateExpired(existingOAuth)) {
      return {
        vm,
        authUrl: existingOAuth.authUrl,
      };
    }

    const oauth = this.createOnboardingCodexOAuthState();
    const updatedVm = await this.updateVm(vm.id, {
      metadata: {
        ...metadata,
        onboarding_codex_session_id: oauth.sessionId,
        onboarding_codex_oauth: oauth,
      },
    });

    await this.logEvent(
      vm.id,
      userId,
      "auth.openai_codex_oauth.start",
      "Started OpenAI Codex OAuth session",
      {
        sessionId: oauth.sessionId,
        ip: requestMeta?.ip || null,
      },
    );

    return {
      vm: updatedVm,
      authUrl: oauth.authUrl,
    };
  }

  private async createSeedVm(userId: string, workspaceId: string): Promise<OctogenVm> {
    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from("octogen_vms")
      .insert({
        workspace_id: workspaceId,
        created_by_user_id: userId,
        provider: "hetzner",
        region: this.config.hetznerLocation,
        server_type: this.config.hetznerServerType,
        image: this.config.hetznerImage,
        server_name: this.buildServerName(workspaceId),
        status: "provisioning",
        provisioning_started_at: now,
        metadata: this.buildProvisioningMetadata(undefined, workspaceId),
        gateway_url: null,
        control_ui_url: null,
        novnc_url: null,
      })
      .select("*")
      .single();

    if (error || !data) {
      if (isUniqueViolation(error)) {
        const existing = await this.findPrimaryVmByWorkspaceId(workspaceId);
        if (existing) {
          return existing;
        }
      }
      throw new OctogenServiceError(
        "DB_INSERT_FAILED",
        error?.message || "Failed to create VM record",
        500,
      );
    }

    return data as OctogenVm;
  }

  private async persistProviderState(
    instanceId: string,
    providerServer: HetznerServer,
    override: Partial<OctogenVm> = {},
  ): Promise<OctogenVm> {
    const ipv4 = providerServer.public_net?.ipv4?.ip || null;
    const ipv6 = providerServer.public_net?.ipv6?.ip || null;
    const gatewayUrl =
      this.buildVmGatewayUrl({
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
    return this.updateVm(instanceId, merged);
  }

  private async updateVm(instanceId: string, patch: Record<string, unknown>): Promise<OctogenVm> {
    const { data, error } = await supabaseAdmin
      .from("octogen_vms")
      .update(patch)
      .eq("id", instanceId)
      .select("*")
      .single();

    if (error || !data) {
      throw new OctogenServiceError(
        "DB_UPDATE_FAILED",
        error?.message || "Failed to update VM record",
        500,
      );
    }

    return data as OctogenVm;
  }

  private async resetVmForProvisioning(
    vm: OctogenVm,
    userId: string,
    workspaceId: string,
  ): Promise<OctogenVm> {
    const { data, error } = await supabaseAdmin
      .from("octogen_vms")
      .update({
        status: "provisioning",
        provisioning_started_at: new Date().toISOString(),
        last_error: null,
        region: this.config.hetznerLocation,
        server_type: this.config.hetznerServerType,
        image: this.config.hetznerImage,
        server_name: this.buildServerName(workspaceId),
        hetzner_server_id: null,
        ipv4: null,
        ipv6: null,
        gateway_url: null,
        control_ui_url: null,
        novnc_url: null,
        provisioned_at: null,
        last_heartbeat_at: null,
        novnc_enabled_until: null,
        metadata: this.buildProvisioningMetadata(vm.metadata, workspaceId),
      })
      .eq("id", vm.id)
      .select("*")
      .single();

    if (error || !data) {
      throw new OctogenServiceError(
        "DB_UPDATE_FAILED",
        error?.message || "Failed to update VM state",
        500,
      );
    }

    return data as OctogenVm;
  }

  private async findPrimaryVmByWorkspaceId(workspaceId: string): Promise<OctogenVm | null> {
    const { data, error } = await supabaseAdmin
      .from("octogen_vms")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new OctogenServiceError(
        "DB_FETCH_FAILED",
        error.message || "Failed to fetch VM record",
        500,
      );
    }

    return (data as OctogenVm | null) || null;
  }

  private async requireVmWithServer(workspaceId: string): Promise<OctogenVm> {
    const vm = await this.findPrimaryVmByWorkspaceId(workspaceId);
    if (!vm) {
      throw new OctogenServiceError("VM_NOT_FOUND", "No VM exists for this workspace yet", 404);
    }
    if (!vm.hetzner_server_id) {
      throw new OctogenServiceError("VM_NOT_READY", "VM has not finished provisioning", 409);
    }
    return vm;
  }

  private async createAccessSession(
    vm: OctogenVm,
    userId: string,
    sessionType: OctogenSessionType,
    ttlSeconds: number,
    requestMeta?: OctogenRequestMeta,
  ): Promise<{ token: string; expiresAt: string }> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAtDate = new Date((nowSeconds + ttlSeconds) * 1000);
    const payload = {
      iss: "octogen-console",
      aud: "openclaw-gateway",
      sub: userId,
      jti: randomUUID(),
      iat: nowSeconds,
      exp: nowSeconds + ttlSeconds,
      instance_id: vm.id,
      session_type: sessionType,
      provider: "hetzner",
      trusted_proxy: true,
      gateway_url: vm.gateway_url,
    };
    const token = this.signToken(payload);
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = expiresAtDate.toISOString();

    const { error } = await supabaseAdmin.from("octogen_vm_access_sessions").insert({
      vm_id: vm.id,
      workspace_id: vm.workspace_id,
      actor_user_id: userId,
      session_type: sessionType,
      token_hash: tokenHash,
      expires_at: expiresAt,
      client_ip: requestMeta?.ip || null,
      user_agent: requestMeta?.userAgent || null,
      metadata: {
        trusted_proxy_mode: "trusted-proxy",
        gateway_url: vm.gateway_url,
      },
    });

    if (error) {
      throw new OctogenServiceError(
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
    requestMeta?: OctogenRequestMeta;
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
    const fallbackDisabled =
      snapshot?.config?.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === false;
    const originsChanged = !this.sameStringSet(existingOrigins, mergedOrigins);

    if (originsChanged || !fallbackDisabled) {
      await this.patchGatewayConfig(params.gatewayWebSocketUrl, params.token, {
        gateway: {
          controlUi: {
            allowedOrigins: mergedOrigins,
            dangerouslyAllowHostHeaderOriginFallback: false,
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

  private buildVmGatewayUrl(params: {
    instanceId: string;
    ipv4: string | null;
    serverId: number;
  }): string | null {
    const template = this.config.vmGatewayTemplate;
    if (!params.ipv4 && template.includes("{{IPV4}}")) {
      return null;
    }

    const rendered = template
      .replaceAll("{{IPV4}}", params.ipv4 || "")
      .replaceAll("{{VM_ID}}", params.instanceId)
      .replaceAll("{{INSTANCE_ID}}", params.instanceId)
      .replaceAll("{{SERVER_ID}}", String(params.serverId));

    if (!rendered.trim()) {
      return null;
    }
    return ensureAbsoluteUrl("OCTOGEN_VM_GATEWAY_TEMPLATE", rendered);
  }

  private resolveLaunchBaseUrl(vm: OctogenVm, sessionType: OctogenSessionType): string {
    const perVmUrl = sessionType === "control_ui" ? vm.control_ui_url : vm.novnc_url;
    if (perVmUrl) {
      return perVmUrl;
    }

    const sharedUrl =
      sessionType === "control_ui"
        ? this.buildSharedControlUiUrl(vm.id)
        : this.buildSharedNoVncUrl(vm.id);
    if (sharedUrl) {
      return sharedUrl;
    }

    throw new OctogenServiceError(
      "VM_GATEWAY_MISSING",
      sessionType === "control_ui"
        ? "Control UI endpoint is not ready for this vm yet."
        : "noVNC endpoint is not ready for this vm yet.",
      409,
    );
  }

  private async requireRunningVm(userId: string, workspaceId: string): Promise<OctogenVm> {
    const health = await this.getVmHealth(userId, workspaceId, { syncProvider: true });
    if (!health.vm) {
      throw new OctogenServiceError("VM_NOT_FOUND", "No VM exists for this workspace yet", 404);
    }
    const providerStillRunning =
      health.providerStatus === "running" && Boolean(health.vm.hetzner_server_id);
    if (health.vm.status !== "running" && !providerStillRunning) {
      throw new OctogenServiceError(
        "VM_NOT_RUNNING",
        "VM is not running. Please recover first.",
        409,
      );
    }
    return health.vm;
  }

  private async createControlGatewaySession(
    vm: OctogenVm,
    userId: string,
    requestMeta?: OctogenRequestMeta,
    options?: {
      syncControlUiOrigins?: boolean;
      strictControlUiOriginSync?: boolean;
    },
  ): Promise<{ token: string; expiresAt: string; gatewayWebSocketUrl: string }> {
    const session = await this.createAccessSession(
      vm,
      userId,
      "control_ui",
      this.config.controlSessionTtlSeconds,
      requestMeta,
    );
    const controlUiBase = this.ensureTrailingSlash(this.resolveLaunchBaseUrl(vm, "control_ui"));
    const gatewayWebSocketUrl = this.withQuery(this.toWebSocketUrl(controlUiBase), {
      instanceId: vm.id,
      token: session.token,
      mode: "trusted-proxy",
    });
    if (options?.syncControlUiOrigins) {
      try {
        await this.syncControlUiAllowedOrigins({
          instanceId: vm.id,
          userId,
          gatewayWebSocketUrl,
          token: session.token,
          controlUiBase,
          requestMeta,
        });
      } catch (error) {
        if (options.strictControlUiOriginSync) {
          throw new OctogenServiceError(
            "GATEWAY_ORIGIN_SYNC_FAILED",
            `Failed to sync control UI allowed origins: ${safeErrorMessage(error)}`,
            502,
          );
        }
        try {
          await this.logEvent(
            vm.id,
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
    if (!(error instanceof OctogenServiceError)) {
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
    if (
      message.includes("probe timed out") ||
      message.includes("gateway websocket failed to open")
    ) {
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
          "user-agent": "octogen-console/gateway-repair",
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

      return payload.success !== false;
    } catch (error) {
      if (isAbortError(error)) {
        return false;
      }
      return false;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async syncWorkspaceReleaseViaProxy(params: {
    gatewayWebSocketUrl: string;
    token: string;
    manifestUrl: string;
    updaterScriptUrl: string;
    proxyScriptUrl: string;
  }): Promise<{ updated: boolean; currentRoot: string | null }> {
    const origin = this.toHttpOriginFromWebSocketUrl(params.gatewayWebSocketUrl);
    if (!origin) {
      throw new OctogenServiceError(
        "WORKSPACE_RELEASE_SYNC_FAILED",
        "Could not derive gateway origin from websocket URL.",
        502,
      );
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), 40_000);
    try {
      const url = new URL(`/${WORKSPACE_RELEASE_SYNC_PATH}`, origin).toString();
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${params.token}`,
          "content-type": "application/json; charset=utf-8",
          "user-agent": "octogen-console/workspace-release-sync",
        },
        body: JSON.stringify({
          manifestUrl: params.manifestUrl,
          updaterScriptUrl: params.updaterScriptUrl,
          proxyScriptUrl: params.proxyScriptUrl,
        }),
      });

      let payload: {
        success?: unknown;
        error?: unknown;
        code?: unknown;
        details?: {
          updated?: unknown;
          currentRoot?: unknown;
        };
      } = {};
      try {
        payload = (await response.json()) as {
          success?: unknown;
          error?: unknown;
          code?: unknown;
          details?: {
            updated?: unknown;
            currentRoot?: unknown;
          };
        };
      } catch {
        payload = {};
      }

      if (!response.ok || payload.success === false) {
        const rawCode =
          typeof payload.code === "string" && payload.code.trim()
            ? payload.code.trim().toLowerCase()
            : "";
        if (response.status === 404 || rawCode === "route_not_found") {
          throw new OctogenServiceError(
            "WORKSPACE_RELEASE_SYNC_UNSUPPORTED",
            "This VM image does not support one-click workspace release sync yet. Please redeploy the VM once, then retry.",
            409,
          );
        }
        const message =
          typeof payload.error === "string" && payload.error.trim()
            ? payload.error.trim()
            : `Workspace release update failed with HTTP ${response.status}`;
        throw new OctogenServiceError(
          "WORKSPACE_RELEASE_SYNC_FAILED",
          message,
          response.status || 502,
        );
      }

      const updatedRaw =
        payload.details && typeof payload.details === "object"
          ? payload.details.updated
          : undefined;
      const currentRootRaw =
        payload.details && typeof payload.details === "object"
          ? payload.details.currentRoot
          : undefined;
      return {
        updated: updatedRaw === true,
        currentRoot: typeof currentRootRaw === "string" ? currentRootRaw : null,
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw new OctogenServiceError(
          "WORKSPACE_RELEASE_SYNC_TIMEOUT",
          "Workspace release update request timed out while waiting for VM response.",
          504,
        );
      }
      if (error instanceof OctogenServiceError) {
        throw error;
      }
      throw new OctogenServiceError(
        "WORKSPACE_RELEASE_SYNC_FAILED",
        error instanceof Error ? error.message : "Workspace release update failed",
        502,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async diagnoseGatewayWebSocketOpenFailure(gatewayWebSocketUrl: string): Promise<string> {
    const origin = this.toHttpOriginFromWebSocketUrl(gatewayWebSocketUrl);
    if (!origin) {
      return "Could not derive gateway origin from websocket URL.";
    }

    const headers = { "user-agent": "octogen-console/gateway-probe" };

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
        fetchJson(`/${GATEWAY_BOOTSTRAP_PATH}`),
      ]);

      const parts: string[] = [];
      parts.push(`origin=${origin}`);

      if (bootstrap.timeout) {
        parts.push("bootstrap=timeout");
      } else if (bootstrap.ok) {
        const bootstrapState = parseGatewayBootstrapState(bootstrap.payload);
        if (bootstrapState?.phase && bootstrapState.status) {
          parts.push(`bootstrap=${bootstrapState.phase}/${bootstrapState.status}`);
        } else {
          parts.push("bootstrap=ok");
        }
        if (bootstrapState?.message) {
          parts.push(`bootstrapMessage=${bootstrapState.message}`);
        }
      } else {
        parts.push(
          `bootstrapHttp=${bootstrap.status}${
            describeGatewayPayloadError(bootstrap.payload)
              ? ` (${describeGatewayPayloadError(bootstrap.payload)})`
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
            describeGatewayPayloadError(health.payload)
              ? ` (${describeGatewayPayloadError(health.payload)})`
              : ""
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
      throw new OctogenServiceError(
        "WIZARD_PAYLOAD_INVALID",
        "Invalid onboarding wizard response",
        502,
      );
    }
    const sessionIdRaw = (payload as { sessionId?: unknown }).sessionId;
    const sessionId = typeof sessionIdRaw === "string" ? sessionIdRaw.trim() : "";
    if (!sessionId) {
      throw new OctogenServiceError(
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
      throw new OctogenServiceError(
        "WIZARD_PAYLOAD_INVALID",
        "Invalid onboarding wizard response",
        502,
      );
    }

    const doneRaw = (payload as { done?: unknown }).done;
    if (typeof doneRaw !== "boolean") {
      throw new OctogenServiceError(
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
      throw new OctogenServiceError(
        "WIZARD_PAYLOAD_INVALID",
        "Invalid onboarding wizard status payload",
        502,
      );
    }
    const statusRaw = (payload as { status?: unknown }).status;
    if (!this.isWizardStatus(statusRaw)) {
      throw new OctogenServiceError(
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

  private buildProvisioningMetadata(
    existing?: Record<string, unknown>,
    workspaceId?: string | null,
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      ...existing,
      trusted_proxy_mode: "trusted-proxy",
      onboarding_completed: false,
      onboarding_completed_at: null,
      onboarding_last_status: "pending",
    };
    if (typeof workspaceId === "string" && workspaceId.trim().length > 0) {
      metadata.workspace_id = workspaceId.trim();
    }
    return metadata;
  }

  private isTerminalOnboardingCompleted(vm: OctogenVm): boolean {
    const metadata = vm.metadata && typeof vm.metadata === "object" ? vm.metadata : {};
    const directCompleted = (metadata as { onboarding_completed?: unknown }).onboarding_completed;
    if (typeof directCompleted === "boolean") {
      return directCompleted;
    }
    const completedAt = (metadata as { onboarding_completed_at?: unknown }).onboarding_completed_at;
    return typeof completedAt === "string" && completedAt.trim().length > 0;
  }

  private async updateOnboardingState(
    vm: OctogenVm,
    state: {
      completed: boolean;
      status: OnboardingWizardStatus;
    },
  ): Promise<OctogenVm> {
    const metadata = vm.metadata && typeof vm.metadata === "object" ? vm.metadata : {};
    return await this.updateVm(vm.id, {
      metadata: {
        ...metadata,
        trusted_proxy_mode: "trusted-proxy",
        onboarding_completed: state.completed,
        onboarding_completed_at: state.completed ? new Date().toISOString() : null,
        onboarding_last_status: state.status,
      },
    });
  }

  private async finishTerminalOnboarding(
    vm: OctogenVm,
    extraMetadata?: Record<string, unknown>,
  ): Promise<OctogenVm> {
    const doneVm = await this.updateOnboardingState(vm, {
      completed: true,
      status: "done",
    });
    const metadata = doneVm.metadata && typeof doneVm.metadata === "object" ? doneVm.metadata : {};
    return await this.updateVm(doneVm.id, {
      metadata: {
        ...metadata,
        onboarding_session_id: null,
        onboarding_step_id: null,
        onboarding_codex_session_id: null,
        onboarding_codex_oauth: null,
        ...extraMetadata,
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
    throw new OctogenServiceError(
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
        if (error instanceof OctogenServiceError) {
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
      error instanceof OctogenServiceError &&
      error.code === "GATEWAY_REQUEST_FAILED" &&
      method === "wizard.next" &&
      /wizard not found|wizard not running/i.test(error.message)
    ) {
      throw new OctogenServiceError(
        "WIZARD_SESSION_EXPIRED",
        "Setup wizard session expired. Please start cooking wizard again.",
        409,
      );
    }
    if (
      error instanceof OctogenServiceError &&
      error.code === "GATEWAY_REQUEST_FAILED" &&
      /pairing required/i.test(error.message)
    ) {
      throw new OctogenServiceError(
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

    throw new OctogenServiceError(
      "GATEWAY_WARMING_UP",
      "OpenAI auth is saved, but the gateway is still warming up. Leave this page open a little longer, or try Restart Gateway once.",
      409,
    );
  }

  private isGatewayWarmupTransientError(error: unknown): boolean {
    if (error instanceof OctogenServiceError) {
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
      if (error.code === "VM_BOOTING") {
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
    if (!(error instanceof OctogenServiceError)) {
      return false;
    }
    if (error.code !== "GATEWAY_REQUEST_FAILED" && error.code !== "GATEWAY_SOCKET_CLOSED") {
      return false;
    }
    return /invalid handshake|first request must be connect/i.test(error.message);
  }

  private shouldRecoverWizardNextByResync(error: unknown): boolean {
    if (!(error instanceof OctogenServiceError)) {
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
    if (!(error instanceof OctogenServiceError)) {
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

    throw lastError instanceof OctogenServiceError
      ? lastError
      : new OctogenServiceError(
          "GATEWAY_CONFIG_PATCH_FAILED",
          `Failed to patch gateway config: ${safeErrorMessage(lastError)}`,
          502,
        );
  }

  private shouldRetryGatewayConfigPatch(error: unknown): boolean {
    if (!(error instanceof OctogenServiceError)) {
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
            throw new OctogenServiceError(
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
      throw error instanceof OctogenServiceError
        ? error
        : new OctogenServiceError(
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
    if (!(error instanceof OctogenServiceError)) {
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
      : new OctogenServiceError("GATEWAY_CONNECT_FAILED", "Gateway websocket failed to open", 502);
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
      throw new OctogenServiceError(
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
        new OctogenServiceError("GATEWAY_CONNECT_FAILED", "Gateway websocket failed to open", 502),
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
        throw new OctogenServiceError(
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
        throw new OctogenServiceError(
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
          version: "octogen-console",
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
        new OctogenServiceError(
          "GATEWAY_REQUEST_FAILED",
          this.formatGatewayErrorMessage(response.error),
          502,
        ),
      );
    };

    const handleClose = (event: CloseEvent) => {
      settle(() => {
        cleanup();
        const closeError = new OctogenServiceError(
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
        const timeoutError = new OctogenServiceError(
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
        throw new OctogenServiceError(
          "GATEWAY_CONNECT_FAILED",
          `Gateway websocket failed to open (${diagnosis})`,
          502,
        );
      }
      await challengePromise;
      await sendConnect();
      return await operation(sendRequest);
    } catch (error) {
      throw error instanceof OctogenServiceError
        ? error
        : new OctogenServiceError("GATEWAY_REQUEST_FAILED", safeErrorMessage(error), 502);
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
        throw new OctogenServiceError(
          "CONFIG_INVALID",
          `Invalid ${formatEnvName("OCTOGEN_GATEWAY_DEVICE_PRIVATE_KEY_PEM")} value: ${safeErrorMessage(error)}`,
          503,
        );
      }
    }
    return this.generateGatewayDeviceIdentity();
  }

  private readConfiguredGatewayDevicePrivateKeyPem(): string | null {
    const pemRaw = getOptionalEnv("OCTOGEN_GATEWAY_DEVICE_PRIVATE_KEY_PEM");
    if (pemRaw) {
      // Support env values where newlines are escaped as "\n".
      return pemRaw.includes("\\n") ? pemRaw.replace(/\\n/g, "\n") : pemRaw;
    }

    const base64Raw = getOptionalEnv("OCTOGEN_GATEWAY_DEVICE_PRIVATE_KEY_B64");
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
      throw new OctogenServiceError(
        "CONFIG_INVALID",
        `Invalid ${formatEnvName("OCTOGEN_GATEWAY_DEVICE_PRIVATE_KEY_B64")} value: ${safeErrorMessage(error)}`,
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
    const bootstrapUrl = joinUrl(gatewayUrl, GATEWAY_BOOTSTRAP_PATH);

    const fetchJsonProbe = async (
      url: string,
      userAgent: string,
      timeoutMs: number,
    ): Promise<{ ok: boolean; status: number; payload: unknown; timeout: boolean }> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          headers: {
            "user-agent": userAgent,
          },
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
        clearTimeout(timeout);
      }
    };

    try {
      const [health, bootstrap] = await Promise.all([
        fetchJsonProbe(
          healthUrl,
          "octogen-console/gateway-health-probe",
          GATEWAY_HEALTH_TIMEOUT_MS,
        ),
        fetchJsonProbe(
          bootstrapUrl,
          "octogen-console/bootstrap-state-probe",
          GATEWAY_BOOTSTRAP_TIMEOUT_MS,
        ),
      ]);
      const bootstrapState = bootstrap.ok ? parseGatewayBootstrapState(bootstrap.payload) : null;
      const bootstrapFailureReason = formatGatewayBootstrapFailureReason(bootstrapState);

      if (!health.ok) {
        if (bootstrapFailureReason) {
          return {
            ready: false,
            code: "bootstrap_failed",
            reason: bootstrapFailureReason,
            bootstrapPhase: bootstrapState?.phase ?? undefined,
            bootstrapStatus: bootstrapState?.status ?? undefined,
            bootstrapMessage: bootstrapState?.message ?? undefined,
          };
        }
        const payload =
          health.payload && typeof health.payload === "object" && !Array.isArray(health.payload)
            ? (health.payload as {
                error?: string;
                code?: string;
                upstream?: {
                  openclaw?: {
                    ok?: unknown;
                    error?: unknown;
                  };
                };
              })
            : {};
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
        // /__octogen/health returns combined upstream health (openclaw + novnc).
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
        const reason =
          typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : "";
        const upstreamHint = openclawUpstreamError
          ? ` (openclaw upstream: ${openclawUpstreamError})`
          : "";
        return {
          ready: false,
          code: payload.code,
          openclawUpstreamReady,
          openclawUpstreamError,
          reason: reason
            ? `Gateway health returned HTTP ${health.status}: ${reason}${upstreamHint}`
            : health.timeout
              ? "Gateway health probe timed out"
              : `Gateway health returned HTTP ${health.status}${upstreamHint}`,
          bootstrapPhase: bootstrapState?.phase ?? undefined,
          bootstrapStatus: bootstrapState?.status ?? undefined,
          bootstrapMessage: bootstrapState?.message ?? undefined,
        };
      }

      const payload =
        health.payload && typeof health.payload === "object" && !Array.isArray(health.payload)
          ? (health.payload as { success?: boolean })
          : {};

      if (payload.success === false) {
        if (bootstrapFailureReason) {
          return {
            ready: false,
            code: "bootstrap_failed",
            reason: bootstrapFailureReason,
            bootstrapPhase: bootstrapState?.phase ?? undefined,
            bootstrapStatus: bootstrapState?.status ?? undefined,
            bootstrapMessage: bootstrapState?.message ?? undefined,
          };
        }
        return {
          ready: false,
          reason: "Gateway health payload is not ready",
          bootstrapPhase: bootstrapState?.phase ?? undefined,
          bootstrapStatus: bootstrapState?.status ?? undefined,
          bootstrapMessage: bootstrapState?.message ?? undefined,
        };
      }

      return { ready: true };
    } catch (error) {
      if (isAbortError(error)) {
        return { ready: false, reason: "Gateway health probe timed out" };
      }
      return { ready: false, reason: safeErrorMessage(error) };
    }
  }

  private shouldAttemptAutoGatewayRepair(
    vm: OctogenVm,
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

    const metadata = vm.metadata && typeof vm.metadata === "object" ? vm.metadata : {};
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
    vm: OctogenVm,
    userId: string,
    gatewayUrl: string,
  ): Promise<boolean> {
    const nowIso = new Date().toISOString();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const metadata = vm.metadata && typeof vm.metadata === "object" ? vm.metadata : {};

    const recordAttempt = async (status: "attempted" | "repaired" | "failed") => {
      try {
        await this.updateVm(vm.id, {
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
      iss: "octogen-console",
      aud: "openclaw-gateway",
      sub: userId,
      jti: randomUUID(),
      iat: nowSeconds,
      exp: nowSeconds + 120,
      instance_id: vm.id,
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

  private async allowOptimisticControlUiLaunch(
    vm: OctogenVm,
    launchUrl: string,
    gatewayBaseUrl: string | null,
    cause: string,
  ): Promise<boolean> {
    if (!gatewayBaseUrl) {
      return false;
    }

    const probe = await this.probeGatewayReadiness(gatewayBaseUrl);
    if (!probe.ready) {
      return false;
    }

    await this.logEvent(
      vm.id,
      vm.created_by_user_id,
      "gateway.launch.probe.softened",
      "Control UI launch preflight failed, but gateway health is ready; continuing with optimistic launch.",
      {
        launchUrl,
        gatewayBaseUrl,
        cause,
        readinessCode: probe.code ?? null,
        readinessReason: probe.reason ?? null,
      },
      "warn",
    );
    return true;
  }

  private async ensureControlUiLaunchable(
    vm: OctogenVm,
    launchUrl: string,
    gatewayBaseUrl: string | null,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GATEWAY_LAUNCH_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(launchUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "octogen-console/health-probe",
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
        if (
          await this.allowOptimisticControlUiLaunch(
            vm,
            launchUrl,
            gatewayBaseUrl,
            `http-${response.status}:${payload.code || "unknown"}`,
          )
        ) {
          return;
        }
        await this.updateVm(vm.id, {
          status: "provisioning",
          last_error: "OpenClaw services are still booting on your VM. Please retry shortly.",
        });
        throw new OctogenServiceError(
          "VM_BOOTING",
          "VM is online, but OpenClaw is still starting (usually 1-3 minutes on first boot). Please retry in a moment.",
          409,
        );
      }

      throw new OctogenServiceError(
        "CONTROL_UI_UNAVAILABLE",
        payload.error || `Control UI probe failed with HTTP ${response.status}`,
        502,
      );
    } catch (error) {
      if (error instanceof OctogenServiceError) {
        throw error;
      }

      if (isAbortError(error)) {
        // Do not block launch on console probe timeout. End-user browser connectivity
        // can still succeed even when this server-side preflight is slow/intermittent.
        await this.logEvent(
          vm.id,
          vm.created_by_user_id,
          "gateway.launch.probe.timeout",
          "Control-plane launch probe timed out; continuing with optimistic launch.",
          { launchUrl },
          "warn",
        );
        return;
      }

      if (
        await this.allowOptimisticControlUiLaunch(
          vm,
          launchUrl,
          gatewayBaseUrl,
          safeErrorMessage(error),
        )
      ) {
        return;
      }

      const bootingMessage = "OpenClaw endpoint is not reachable yet. Please retry in a moment.";

      await this.updateVm(vm.id, {
        status: "provisioning",
        last_error: "OpenClaw services are still booting on your VM. Please retry shortly.",
      });

      throw new OctogenServiceError("VM_BOOTING", bootingMessage, 409);
    } finally {
      clearTimeout(timeout);
    }
  }

  private renderCloudInit(userId: string, instanceId: string): string {
    let rendered: string;

    if (this.config.defaultCloudInit) {
      rendered = this.config.defaultCloudInit
        .replaceAll("{{USER_ID}}", userId)
        .replaceAll("{{VM_ID}}", instanceId)
        .replaceAll("{{INSTANCE_ID}}", instanceId)
        .replaceAll("{{GATEWAY_BASE_URL}}", this.config.gatewayBaseUrl || "")
        .replaceAll("{{PROXY_SHARED_SECRET}}", this.config.proxySharedSecret)
        .replaceAll("{{CONTROL_UI_PATH}}", this.config.controlUiPath)
        .replaceAll("{{NOVNC_PATH}}", this.config.novncPath);
    } else if (this.config.openClawBootstrapCommand) {
      const bootstrapCommandRaw = this.config.openClawBootstrapCommand
        .replaceAll("{{USER_ID}}", userId)
        .replaceAll("{{VM_ID}}", instanceId)
        .replaceAll("{{INSTANCE_ID}}", instanceId)
        .replaceAll("{{GATEWAY_BASE_URL}}", this.config.gatewayBaseUrl || "")
        .replaceAll("{{PROXY_SHARED_SECRET}}", this.config.proxySharedSecret)
        .replaceAll("{{CONTROL_UI_PATH}}", this.config.controlUiPath)
        .replaceAll("{{NOVNC_PATH}}", this.config.novncPath);
      rendered = this.buildCompactBootstrapCloudInit(bootstrapCommandRaw, userId, instanceId);
    } else {
      rendered = this.buildCompactBootstrapCloudInit(
        this.buildDefaultBootstrapCommand(userId, instanceId),
        userId,
        instanceId,
      );
    }

    if (rendered.length > OCTOGEN_CLOUD_INIT_MAX_BYTES) {
      throw new OctogenServiceError(
        "CLOUD_INIT_TOO_LARGE",
        "Cloud-init payload is too large for Hetzner API. Configure OCTOGEN_OPENCLAW_BOOTSTRAP_COMMAND or OCTOGEN_HETZNER_CLOUD_INIT with a lighter script.",
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
  - echo "Octogen Console bootstrap user=${userId} vm=${instanceId}" > /var/log/octogen-bootstrap.log
`;
  }

  private buildDefaultBootstrapCommand(userId: string, instanceId: string): string {
    const { bootstrapScriptUrl, proxyScriptUrl, hermesRunnerScriptUrl, controlUiUpdaterScriptUrl } =
      this.resolveBootstrapScriptUrls();
    const controlPrefix = `/${this.config.controlUiPath}`;
    const noVncPrefix = `/${this.config.novncPath}`;
    const usePublicHttpGateway = this.usesPublicHttpGatewayTemplate();
    const proxyBind = usePublicHttpGateway ? "0.0.0.0" : "127.0.0.1";
    // Cache-bust bootstrap assets so newly provisioned VMs never pick up a stale script
    // from CDN caches right after a console deploy.
    const withCacheBust = (raw: string): string => {
      try {
        const url = new URL(raw);
        url.searchParams.set("v", instanceId);
        return url.toString();
      } catch {
        return raw;
      }
    };
    const bootstrapScriptUrlWithBust = withCacheBust(bootstrapScriptUrl);
    const proxyScriptUrlWithBust = withCacheBust(proxyScriptUrl);
    const hermesRunnerScriptUrlWithBust = withCacheBust(hermesRunnerScriptUrl);
    const controlUiUpdaterScriptUrlWithBust = withCacheBust(controlUiUpdaterScriptUrl);
    return [
      `curl -fsSL ${bootstrapScriptUrlWithBust}`,
      "| bash -s --",
      `--proxy-secret '${this.config.proxySharedSecret}'`,
      `--proxy-bind ${proxyBind}`,
      "--proxy-port 18790",
      "--gateway-port 18789",
      `--control-prefix '${controlPrefix}'`,
      `--novnc-prefix '${noVncPrefix}'`,
      `--vm-id '${instanceId}'`,
      `--trusted-proxy-user '${userId}'`,
      `--gateway-origin-template '${this.config.vmGatewayTemplate}'`,
      `--console-device-id '${this.gatewayDeviceIdentity.deviceId}'`,
      `--console-device-public-key '${this.gatewayDeviceIdentity.publicKeyBase64Url}'`,
      ...(this.config.bootstrapAssetBaseUrl
        ? [`--console-api-base-url '${this.config.bootstrapAssetBaseUrl}'`]
        : []),
      ...(this.config.controlUiAllowedOrigin
        ? [`--control-ui-origin '${this.config.controlUiAllowedOrigin}'`]
        : []),
      `--proxy-script-url '${proxyScriptUrlWithBust}'`,
      `--hermes-runner-script-url '${hermesRunnerScriptUrlWithBust}'`,
      ...(this.config.controlUiManifestUrl
        ? [
            `--control-ui-manifest-url '${this.config.controlUiManifestUrl}'`,
            `--control-ui-updater-script-url '${controlUiUpdaterScriptUrlWithBust}'`,
          ]
        : [
            ...(this.config.openClawVersion
              ? [`--openclaw-version '${this.config.openClawVersion}'`]
              : []),
            ...(this.config.openClawInstallSpec
              ? [`--openclaw-install-spec '${this.config.openClawInstallSpec}'`]
              : []),
          ]),
      ...(usePublicHttpGateway ? ["--disable-https"] : []),
    ].join(" ");
  }

  private resolveBootstrapScriptUrls(): {
    bootstrapScriptUrl: string;
    proxyScriptUrl: string;
    hermesRunnerScriptUrl: string;
    controlUiUpdaterScriptUrl: string;
  } {
    if (this.config.bootstrapAssetBaseUrl) {
      return {
        bootstrapScriptUrl: joinUrl(this.config.bootstrapAssetBaseUrl, LOCAL_BOOTSTRAP_SCRIPT_PATH),
        proxyScriptUrl: joinUrl(this.config.bootstrapAssetBaseUrl, LOCAL_PROXY_SCRIPT_PATH),
        hermesRunnerScriptUrl: joinUrl(
          this.config.bootstrapAssetBaseUrl,
          LOCAL_HERMES_RUNNER_SCRIPT_PATH,
        ),
        controlUiUpdaterScriptUrl: joinUrl(
          this.config.bootstrapAssetBaseUrl,
          LOCAL_CONTROL_UI_UPDATER_SCRIPT_PATH,
        ),
      };
    }
    return {
      bootstrapScriptUrl: DEFAULT_BOOTSTRAP_SCRIPT_URL,
      proxyScriptUrl: DEFAULT_PROXY_SCRIPT_URL,
      hermesRunnerScriptUrl: DEFAULT_HERMES_RUNNER_SCRIPT_URL,
      controlUiUpdaterScriptUrl: DEFAULT_CONTROL_UI_UPDATER_SCRIPT_URL,
    };
  }

  private usesPublicHttpGatewayTemplate(): boolean {
    const sample = this.config.vmGatewayTemplate
      .replaceAll("{{IPV4}}", "127.0.0.1")
      .replaceAll("{{VM_ID}}", "vm")
      .replaceAll("{{SERVER_ID}}", "1");
    try {
      const parsed = new URL(sample);
      return parsed.protocol === "http:";
    } catch {
      return false;
    }
  }

  private mapHetznerStatus(status: string): OctogenVmStatus {
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

  private async normalizeDetachedVm(vm: OctogenVm): Promise<OctogenVm> {
    if (vm.status === "provisioning" || vm.status === "terminated" || vm.status === "deleting") {
      return vm;
    }

    const fallbackMessage =
      vm.last_error?.trim() || "No active VM found. Deploy a new VM to continue.";
    return this.updateVm(vm.id, {
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

  private normalizeProviderError(error: unknown): OctogenServiceError {
    if (error instanceof OctogenServiceError) {
      return error;
    }
    if (error instanceof HetznerApiError) {
      if (error.status === 401 || error.status === 403) {
        return new OctogenServiceError(
          "HETZNER_AUTH_FAILED",
          "Hetzner API authentication failed. Check OCTOGEN_HETZNER_API_TOKEN.",
          503,
        );
      }
      const normalized = JSON.stringify(error.details || {});
      const message = `${error.message} ${normalized}`.toLowerCase();
      if (message.includes("user_data")) {
        return new OctogenServiceError(
          "HETZNER_USER_DATA_REJECTED",
          "Hetzner rejected user_data. Bootstrap payload is too large or malformed. Keep OCTOGEN_HETZNER_CLOUD_INIT empty, then deploy again.",
          422,
        );
      }
      return new OctogenServiceError("HETZNER_ERROR", error.message, 502);
    }
    return new OctogenServiceError("PROVISION_FAILED", safeErrorMessage(error), 500);
  }

  private isProviderServerMissing(error: unknown): boolean {
    return error instanceof HetznerApiError && error.status === 404;
  }

  private async markVmTerminated(
    vm: OctogenVm,
    userId: string,
    reason: string,
  ): Promise<OctogenVm> {
    const metadata = {
      ...vm.metadata,
      externally_deleted_at: new Date().toISOString(),
    };

    const updated = await this.updateVm(vm.id, {
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
      "vm.terminated",
      reason,
      {
        reason,
        previousHetznerServerId: vm.hetzner_server_id,
      },
      "warn",
    );

    return updated;
  }

  private async resolveVmWorkspaceId(instanceId: string): Promise<string | null> {
    const { data, error } = await supabaseAdmin
      .from("octogen_vms")
      .select("workspace_id")
      .eq("id", instanceId)
      .maybeSingle();

    if (error) {
      console.error("[Octogen Console] Failed to resolve VM workspace", {
        instanceId,
        error: error.message,
      });
      return null;
    }

    const workspaceId = (data as { workspace_id?: unknown } | null)?.workspace_id;
    return typeof workspaceId === "string" && workspaceId.trim() ? workspaceId.trim() : null;
  }

  private async logEvent(
    instanceId: string,
    userId: string | null,
    eventType: string,
    message: string,
    payload: Record<string, unknown> = {},
    level: "info" | "warn" | "error" = "info",
  ): Promise<void> {
    const workspaceId = await this.resolveVmWorkspaceId(instanceId);
    if (!workspaceId) {
      return;
    }

    const { error } = await supabaseAdmin.from("octogen_vm_events").insert({
      vm_id: instanceId,
      workspace_id: workspaceId,
      actor_user_id: userId,
      event_type: eventType,
      level,
      message,
      payload,
    });

    if (error) {
      console.error("[Octogen Console] Failed to persist event", {
        instanceId,
        eventType,
        error: error.message,
      });
    }
  }
}
