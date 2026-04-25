import { createHash, createHmac, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/server-auth";
import { type OctogenAgent, type OctogenAgentStatus } from "@/lib/services/octogen-agent.service";
import {
  type OctogenHermesRuntimeAction,
  type OctogenHermesRuntimeActionStatus,
  type OctogenHermesRuntimeStatus,
} from "@/lib/services/octogen-hermes-adapter.service";
import { OctogenServiceError } from "@/lib/services/octogen.service";

interface RunnerVmRow {
  id: string;
  workspace_id: string;
  status: string;
}

interface RunnerActionRow extends OctogenHermesRuntimeAction {}

interface RunnerAgentRow extends OctogenAgent {}

export interface OctogenHermesRunnerAuthContext {
  vmId: string;
  workspaceId: string;
  signedAtSeconds: number;
}

export interface OctogenHermesRunnerClaimResult {
  action: OctogenHermesRuntimeAction | null;
  agent: RunnerAgentView | null;
  retryAfterSeconds: number;
  message: string;
}

export interface OctogenHermesRunnerReportResult {
  action: OctogenHermesRuntimeAction;
  agent: RunnerAgentView;
  runtimeStatus: OctogenHermesRuntimeStatus;
  message: string;
}

interface RunnerAgentView {
  id: string;
  workspace_id: string;
  vm_id: string | null;
  name: string;
  status: OctogenAgentStatus;
  runtime_kind: "hermes";
  runtime_agent_id: string | null;
  hermes_profile_id: string | null;
  metadata: Record<string, unknown>;
}

type RunnerReportStatus = Extract<
  OctogenHermesRuntimeActionStatus,
  "running" | "succeeded" | "failed"
>;

const HERMES_RUNTIME_CONTRACT = "octogen.hermes.v1";
const RUNNER_SIGNATURE_WINDOW_SECONDS = 5 * 60;

function getRunnerSharedSecret(): string {
  const secret =
    process.env.OCTOGEN_RUNNER_SHARED_SECRET?.trim() ||
    process.env.OCTOGEN_PROXY_SHARED_SECRET?.trim();
  if (!secret) {
    throw new OctogenServiceError(
      "RUNNER_SECRET_NOT_CONFIGURED",
      "Octogen runner shared secret is not configured.",
      503,
    );
  }
  return secret;
}

function normalizeHeader(value: string | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSignature(value: string): string {
  const raw = value.trim();
  return raw.toLowerCase().startsWith("sha256=") ? raw.slice("sha256=".length) : raw;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonObject(bodyText: string): Record<string, unknown> {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new OctogenServiceError("INVALID_JSON", "Runner request body must be JSON.", 400);
  }
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeRunnerId(value: unknown): string | null {
  const runnerId = normalizeString(value);
  return runnerId ? runnerId.slice(0, 120) : null;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeString(entry))
    .filter(Boolean)
    .map((entry) => entry.slice(0, 80));
}

function isRunnerReportStatus(value: unknown): value is RunnerReportStatus {
  return value === "running" || value === "succeeded" || value === "failed";
}

function normalizeRuntimeStatus(
  value: unknown,
  reportStatus: RunnerReportStatus,
): OctogenHermesRuntimeStatus {
  const allowed = new Set<OctogenHermesRuntimeStatus>([
    "unknown",
    "pending",
    "provisioning",
    "runtime_ready",
    "needs_provider",
    "needs_channel",
    "ready",
    "degraded",
    "error",
    "offline",
  ]);
  if (typeof value === "string" && allowed.has(value as OctogenHermesRuntimeStatus)) {
    return value as OctogenHermesRuntimeStatus;
  }
  if (reportStatus === "failed") {
    return "error";
  }
  if (reportStatus === "running") {
    return "provisioning";
  }
  return "runtime_ready";
}

function runtimeStatusToAgentStatus(
  runtimeStatus: OctogenHermesRuntimeStatus,
  reportStatus: RunnerReportStatus,
): OctogenAgentStatus {
  if (reportStatus === "running") {
    return "provisioning";
  }
  if (reportStatus === "failed" || runtimeStatus === "error") {
    return "error";
  }
  if (runtimeStatus === "offline") {
    return "stopped";
  }
  if (runtimeStatus === "runtime_ready") {
    return "runtime_ready";
  }
  if (runtimeStatus === "needs_provider") {
    return "needs_provider";
  }
  if (runtimeStatus === "needs_channel") {
    return "needs_channel";
  }
  if (runtimeStatus === "ready") {
    return "ready";
  }
  if (runtimeStatus === "degraded") {
    return "degraded";
  }
  return "provisioning";
}

function runtimeStatusToOnboardingStage(runtimeStatus: OctogenHermesRuntimeStatus): string {
  if (runtimeStatus === "runtime_ready" || runtimeStatus === "needs_provider") {
    return "provider";
  }
  if (runtimeStatus === "needs_channel") {
    return "channel";
  }
  if (runtimeStatus === "ready") {
    return "ready";
  }
  return "runtime";
}

function toRuntimeAction(row: Partial<RunnerActionRow> | null): OctogenHermesRuntimeAction | null {
  if (!row?.id || !row.workspace_id || !row.agent_id || !row.action_type || !row.status) {
    return null;
  }
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    agent_id: row.agent_id,
    vm_id: row.vm_id || null,
    adapter_kind: "hermes",
    adapter_contract: row.adapter_contract || HERMES_RUNTIME_CONTRACT,
    action_type: row.action_type,
    status: row.status,
    requested_by_user_id: row.requested_by_user_id || null,
    request_payload: normalizeRecord(row.request_payload),
    result_payload: normalizeRecord(row.result_payload),
    last_error: row.last_error || null,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
  };
}

function toRunnerAgentView(agent: RunnerAgentRow): RunnerAgentView {
  return {
    id: agent.id,
    workspace_id: agent.workspace_id,
    vm_id: agent.vm_id,
    name: agent.name,
    status: agent.status,
    runtime_kind: agent.runtime_kind,
    runtime_agent_id: agent.runtime_agent_id,
    hermes_profile_id: agent.hermes_profile_id,
    metadata: normalizeRecord(agent.metadata),
  };
}

export class OctogenHermesRunnerService {
  parseBody(bodyText: string): Record<string, unknown> {
    return parseJsonObject(bodyText);
  }

  async authenticateRequest(
    request: NextRequest,
    bodyText: string,
  ): Promise<OctogenHermesRunnerAuthContext> {
    const vmId = normalizeHeader(request.headers.get("x-octogen-vm-id"));
    const timestampRaw = normalizeHeader(request.headers.get("x-octogen-runner-timestamp"));
    const signature = normalizeSignature(
      normalizeHeader(request.headers.get("x-octogen-runner-signature")),
    );

    if (!vmId || !timestampRaw || !signature) {
      throw new OctogenServiceError(
        "RUNNER_AUTH_REQUIRED",
        "Runner authentication headers are required.",
        401,
      );
    }

    const signedAtSeconds = Number(timestampRaw);
    if (!Number.isFinite(signedAtSeconds)) {
      throw new OctogenServiceError(
        "RUNNER_AUTH_INVALID_TIMESTAMP",
        "Runner timestamp must be a Unix timestamp in seconds.",
        401,
      );
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - signedAtSeconds) > RUNNER_SIGNATURE_WINDOW_SECONDS) {
      throw new OctogenServiceError(
        "RUNNER_AUTH_EXPIRED",
        "Runner signature timestamp is outside the allowed window.",
        401,
      );
    }

    const path = request.nextUrl.pathname;
    const bodyHash = sha256Hex(bodyText);
    const signingPayload = [request.method.toUpperCase(), path, vmId, timestampRaw, bodyHash].join(
      "\n",
    );
    const expected = createHmac("sha256", getRunnerSharedSecret())
      .update(signingPayload)
      .digest("hex");
    if (!constantTimeEqual(signature, expected)) {
      throw new OctogenServiceError("RUNNER_AUTH_FAILED", "Invalid runner signature.", 401);
    }

    const { data, error } = await supabaseAdmin
      .from("octogen_vms")
      .select("id, workspace_id, status")
      .eq("id", vmId)
      .maybeSingle();

    if (error) {
      throw new OctogenServiceError(
        "RUNNER_VM_FETCH_FAILED",
        error.message || "Failed to verify runner VM.",
        500,
      );
    }
    const vm = data as RunnerVmRow | null;
    if (!vm || vm.status === "terminated") {
      throw new OctogenServiceError("RUNNER_VM_NOT_FOUND", "Runner VM is not registered.", 401);
    }

    return {
      vmId: vm.id,
      workspaceId: vm.workspace_id,
      signedAtSeconds,
    };
  }

  async claimNextAction(
    auth: OctogenHermesRunnerAuthContext,
    input: Record<string, unknown>,
  ): Promise<OctogenHermesRunnerClaimResult> {
    const runnerId = normalizeRunnerId(input.runnerId) || `vm-${auth.vmId}`;
    const capabilities = normalizeStringList(input.capabilities);
    const now = new Date().toISOString();

    const { data: queuedActionData, error: queuedActionError } = await supabaseAdmin
      .from("octogen_agent_runtime_actions")
      .select("*")
      .eq("workspace_id", auth.workspaceId)
      .eq("vm_id", auth.vmId)
      .eq("adapter_kind", "hermes")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (queuedActionError) {
      throw new OctogenServiceError(
        "RUNNER_ACTION_FETCH_FAILED",
        queuedActionError.message || "Failed to fetch queued Hermes runtime action.",
        500,
      );
    }

    const queuedAction = toRuntimeAction(queuedActionData as Partial<RunnerActionRow> | null);
    if (!queuedAction) {
      return {
        action: null,
        agent: null,
        retryAfterSeconds: 10,
        message: "No queued Hermes runtime action for this VM.",
      };
    }

    const resultPayload = {
      ...queuedAction.result_payload,
      claim: {
        runner_id: runnerId,
        capabilities,
        claimed_at: now,
      },
    };

    const { data: updatedActionData, error: updateError } = await supabaseAdmin
      .from("octogen_agent_runtime_actions")
      .update({
        status: "running",
        started_at: now,
        result_payload: resultPayload,
      })
      .eq("workspace_id", auth.workspaceId)
      .eq("vm_id", auth.vmId)
      .eq("id", queuedAction.id)
      .eq("status", "queued")
      .select("*")
      .maybeSingle();

    if (updateError) {
      throw new OctogenServiceError(
        "RUNNER_ACTION_CLAIM_FAILED",
        updateError.message || "Failed to claim Hermes runtime action.",
        500,
      );
    }

    const action = toRuntimeAction(updatedActionData as Partial<RunnerActionRow> | null);
    if (!action) {
      return {
        action: null,
        agent: null,
        retryAfterSeconds: 1,
        message: "Queued action was claimed by another runner. Poll again.",
      };
    }

    const agent = await this.fetchAgent(auth.workspaceId, action.agent_id);
    await Promise.all([
      this.insertRuntimeSnapshot(auth, agent, "provisioning", runnerId, {
        action_id: action.id,
        adapter_mode: "runner_observed",
        claimed_at: now,
        capabilities,
      }),
      this.logAgentEvent(
        auth.workspaceId,
        action.agent_id,
        "runtime.action_claimed",
        "Hermes runner claimed runtime action.",
        {
          actionId: action.id,
          vmId: auth.vmId,
          runnerId,
          capabilities,
        },
      ),
    ]);

    return {
      action,
      agent: toRunnerAgentView(agent),
      retryAfterSeconds: 0,
      message: "Hermes runtime action claimed.",
    };
  }

  async reportAction(
    auth: OctogenHermesRunnerAuthContext,
    input: Record<string, unknown>,
  ): Promise<OctogenHermesRunnerReportResult> {
    const actionId = normalizeString(input.actionId);
    if (!actionId) {
      throw new OctogenServiceError("ACTION_REQUIRED", "actionId is required.", 400);
    }
    if (!isRunnerReportStatus(input.status)) {
      throw new OctogenServiceError(
        "INVALID_ACTION_STATUS",
        "status must be running, succeeded, or failed.",
        400,
      );
    }

    const runnerId = normalizeRunnerId(input.runnerId) || `vm-${auth.vmId}`;
    const reportStatus = input.status;
    const runtimeStatus = normalizeRuntimeStatus(input.runtimeStatus, reportStatus);
    const now = new Date().toISOString();
    const lastError = normalizeString(input.lastError) || null;
    const resultPayload = normalizeRecord(input.resultPayload);
    const observedPayload = normalizeRecord(input.observedPayload);
    const runtimeAgentId = normalizeString(input.runtimeAgentId) || null;
    const hermesVersion = normalizeString(input.hermesVersion) || null;
    const runnerVersion = normalizeString(input.runnerVersion) || null;

    const action = await this.fetchAction(auth, actionId);
    if (
      ["succeeded", "failed", "cancelled"].includes(action.status) &&
      action.status !== reportStatus
    ) {
      throw new OctogenServiceError(
        "RUNNER_ACTION_ALREADY_COMPLETED",
        "Runtime action is already completed with a different status.",
        409,
      );
    }
    const agent = await this.fetchAgent(auth.workspaceId, action.agent_id);
    const mergedResultPayload = {
      ...action.result_payload,
      report: {
        runner_id: runnerId,
        reported_at: now,
        status: reportStatus,
        runtime_status: runtimeStatus,
        result_payload: resultPayload,
      },
    };

    const { data: updatedActionData, error: updateError } = await supabaseAdmin
      .from("octogen_agent_runtime_actions")
      .update({
        status: reportStatus,
        result_payload: mergedResultPayload,
        last_error:
          reportStatus === "failed" ? lastError || "Hermes runner reported failure." : null,
        completed_at: reportStatus === "running" ? null : now,
      })
      .eq("workspace_id", auth.workspaceId)
      .eq("vm_id", auth.vmId)
      .eq("id", action.id)
      .select("*")
      .single();

    const updatedAction = toRuntimeAction(updatedActionData as Partial<RunnerActionRow> | null);
    if (updateError || !updatedAction) {
      throw new OctogenServiceError(
        "RUNNER_ACTION_REPORT_FAILED",
        updateError?.message || "Failed to update Hermes runtime action.",
        500,
      );
    }

    await this.insertRuntimeSnapshot(
      auth,
      agent,
      runtimeStatus,
      runnerId,
      {
        ...observedPayload,
        action_id: action.id,
        adapter_mode: "runner_observed",
        reported_at: now,
        report_status: reportStatus,
        result_payload: resultPayload,
        ...(runtimeAgentId ? { runtime_agent_id: runtimeAgentId } : {}),
        ...(hermesVersion ? { hermes_version: hermesVersion } : {}),
        ...(runnerVersion ? { runner_version: runnerVersion } : {}),
      },
      {
        runtimeAgentId,
        hermesVersion,
        runnerVersion,
        lastError:
          reportStatus === "failed" ? lastError || "Hermes runner reported failure." : lastError,
      },
    );

    await this.updateAgentAfterReport(auth, agent, {
      actionId: action.id,
      runnerId,
      reportStatus,
      runtimeStatus,
      runtimeAgentId,
      lastError,
      reportedAt: now,
    });

    await this.logAgentEvent(
      auth.workspaceId,
      action.agent_id,
      "runtime.action_reported",
      `Hermes runner reported ${reportStatus} for runtime action.`,
      {
        actionId: action.id,
        vmId: auth.vmId,
        runnerId,
        reportStatus,
        runtimeStatus,
      },
      reportStatus === "failed" ? "error" : "info",
    );

    const updatedAgent = await this.fetchAgent(auth.workspaceId, action.agent_id);
    return {
      action: updatedAction,
      agent: toRunnerAgentView(updatedAgent),
      runtimeStatus,
      message: "Hermes runtime action report accepted.",
    };
  }

  private async fetchAction(
    auth: OctogenHermesRunnerAuthContext,
    actionId: string,
  ): Promise<OctogenHermesRuntimeAction> {
    const { data, error } = await supabaseAdmin
      .from("octogen_agent_runtime_actions")
      .select("*")
      .eq("workspace_id", auth.workspaceId)
      .eq("vm_id", auth.vmId)
      .eq("id", actionId)
      .maybeSingle();

    if (error) {
      throw new OctogenServiceError(
        "RUNNER_ACTION_FETCH_FAILED",
        error.message || "Failed to fetch Hermes runtime action.",
        500,
      );
    }
    const action = toRuntimeAction(data as Partial<RunnerActionRow> | null);
    if (!action) {
      throw new OctogenServiceError("RUNNER_ACTION_NOT_FOUND", "Runtime action not found.", 404);
    }
    return action;
  }

  private async fetchAgent(workspaceId: string, agentId: string): Promise<RunnerAgentRow> {
    const { data, error } = await supabaseAdmin
      .from("octogen_agents")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("id", agentId)
      .maybeSingle();

    if (error) {
      throw new OctogenServiceError(
        "RUNNER_AGENT_FETCH_FAILED",
        error.message || "Failed to fetch Hermes agent.",
        500,
      );
    }
    if (!data) {
      throw new OctogenServiceError("RUNNER_AGENT_NOT_FOUND", "Hermes agent not found.", 404);
    }
    return {
      ...(data as RunnerAgentRow),
      metadata: normalizeRecord((data as RunnerAgentRow).metadata),
    };
  }

  private async insertRuntimeSnapshot(
    auth: OctogenHermesRunnerAuthContext,
    agent: RunnerAgentRow,
    runtimeStatus: OctogenHermesRuntimeStatus,
    runnerId: string,
    observedPayload: Record<string, unknown>,
    options: {
      runtimeAgentId?: string | null;
      hermesVersion?: string | null;
      runnerVersion?: string | null;
      lastError?: string | null;
    } = {},
  ): Promise<void> {
    const { error } = await supabaseAdmin.from("octogen_agent_runtime_snapshots").insert({
      workspace_id: auth.workspaceId,
      agent_id: agent.id,
      vm_id: auth.vmId,
      adapter_kind: "hermes",
      adapter_contract: HERMES_RUNTIME_CONTRACT,
      runtime_status: runtimeStatus,
      runtime_agent_id: options.runtimeAgentId || agent.runtime_agent_id,
      hermes_profile_id: agent.hermes_profile_id,
      hermes_version: options.hermesVersion || null,
      runner_version: options.runnerVersion || null,
      last_heartbeat_at: new Date().toISOString(),
      last_error: options.lastError || null,
      observed_payload: {
        ...observedPayload,
        runner_id: runnerId,
      },
    });

    if (error) {
      throw new OctogenServiceError(
        "RUNNER_SNAPSHOT_CREATE_FAILED",
        error.message || "Failed to record Hermes runtime snapshot.",
        500,
      );
    }
  }

  private async updateAgentAfterReport(
    auth: OctogenHermesRunnerAuthContext,
    agent: RunnerAgentRow,
    report: {
      actionId: string;
      runnerId: string;
      reportStatus: RunnerReportStatus;
      runtimeStatus: OctogenHermesRuntimeStatus;
      runtimeAgentId: string | null;
      lastError: string | null;
      reportedAt: string;
    },
  ): Promise<void> {
    const metadata = normalizeRecord(agent.metadata);
    const previousProvisioning = normalizeRecord(metadata.runtime_provisioning);
    const nextStatus = runtimeStatusToAgentStatus(report.runtimeStatus, report.reportStatus);
    const { error } = await supabaseAdmin
      .from("octogen_agents")
      .update({
        status: nextStatus,
        runtime_agent_id: report.runtimeAgentId || agent.runtime_agent_id,
        last_seen_at: report.reportedAt,
        last_error:
          report.reportStatus === "failed"
            ? report.lastError || "Hermes runner reported failure."
            : null,
        metadata: {
          ...metadata,
          onboarding_stage: runtimeStatusToOnboardingStage(report.runtimeStatus),
          runtime_contract: HERMES_RUNTIME_CONTRACT,
          runtime_last_report: {
            action_id: report.actionId,
            runner_id: report.runnerId,
            reported_at: report.reportedAt,
            status: report.reportStatus,
            runtime_status: report.runtimeStatus,
          },
          runtime_provisioning: {
            ...previousProvisioning,
            action_id: report.actionId,
            runner_id: report.runnerId,
            status: report.reportStatus,
            runtime_status: report.runtimeStatus,
            updated_at: report.reportedAt,
            ...(report.reportStatus === "running" ? {} : { completed_at: report.reportedAt }),
          },
        },
      })
      .eq("workspace_id", auth.workspaceId)
      .eq("vm_id", auth.vmId)
      .eq("id", agent.id);

    if (error) {
      throw new OctogenServiceError(
        "RUNNER_AGENT_UPDATE_FAILED",
        error.message || "Failed to update Hermes agent after runner report.",
        500,
      );
    }
  }

  private async logAgentEvent(
    workspaceId: string,
    agentId: string,
    eventType: string,
    message: string,
    payload: Record<string, unknown>,
    level: "info" | "warn" | "error" = "info",
  ): Promise<void> {
    const { error } = await supabaseAdmin.from("octogen_agent_events").insert({
      workspace_id: workspaceId,
      agent_id: agentId,
      actor_user_id: null,
      event_type: eventType,
      level,
      message,
      payload,
    });

    if (error) {
      console.error("[Octogen Console] Failed to persist Hermes runner event", {
        workspaceId,
        agentId,
        eventType,
        error: error.message,
      });
    }
  }
}
