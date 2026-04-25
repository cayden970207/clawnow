import { supabaseAdmin } from "@/lib/server-auth";
import {
  OctogenAgentService,
  type OctogenAgentStatus,
  type OctogenAgentWithRelations,
} from "@/lib/services/octogen-agent.service";
import { OctogenServiceError } from "@/lib/services/octogen.service";

export type OctogenHermesRuntimeStatus =
  | "unknown"
  | "pending"
  | "provisioning"
  | "runtime_ready"
  | "needs_provider"
  | "needs_channel"
  | "ready"
  | "degraded"
  | "error"
  | "offline";

export type OctogenHermesRuntimeActionType =
  | "provision_runtime"
  | "sync_status"
  | "configure_provider"
  | "test_chat"
  | "connect_channel";

export type OctogenHermesRuntimeActionStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface OctogenHermesRuntimeAction {
  id: string;
  workspace_id: string;
  agent_id: string;
  vm_id: string | null;
  adapter_kind: "hermes";
  adapter_contract: string;
  action_type: OctogenHermesRuntimeActionType;
  status: OctogenHermesRuntimeActionStatus;
  requested_by_user_id: string | null;
  request_payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OctogenHermesRuntimeSnapshot {
  id: string;
  workspace_id: string;
  agent_id: string;
  vm_id: string | null;
  adapter_kind: "hermes";
  adapter_contract: string;
  runtime_status: OctogenHermesRuntimeStatus;
  runtime_agent_id: string | null;
  hermes_profile_id: string | null;
  hermes_version: string | null;
  runner_version: string | null;
  last_heartbeat_at: string | null;
  last_error: string | null;
  observed_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface OctogenHermesRuntimeStatusView {
  agent: OctogenAgentWithRelations;
  status: OctogenHermesRuntimeStatus;
  adapterReady: boolean;
  adapterMode: "pending_runner" | "runner_observed";
  latestAction: OctogenHermesRuntimeAction | null;
  latestSnapshot: OctogenHermesRuntimeSnapshot | null;
  nextStep: string;
  message: string;
}

export interface OctogenHermesRuntimeProvisionResult extends OctogenHermesRuntimeStatusView {
  action: OctogenHermesRuntimeAction;
  snapshot: OctogenHermesRuntimeSnapshot;
}

const HERMES_RUNTIME_CONTRACT = "octogen.hermes.v1";
const PENDING_RUNNER_MESSAGE =
  "Hermes runtime provisioning has been queued. Connect the VM-side Hermes runner to execute it, then continue with AI Provider installation.";

function normalizeAgentId(value: unknown): string {
  const agentId = typeof value === "string" ? value.trim() : "";
  if (!agentId) {
    throw new OctogenServiceError("AGENT_REQUIRED", "Select a Hermes agent first.", 400);
  }
  return agentId;
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function agentStatusToRuntimeStatus(status: OctogenAgentStatus): OctogenHermesRuntimeStatus {
  if (status === "draft") {
    return "pending";
  }
  if (status === "provisioning") {
    return "provisioning";
  }
  if (status === "runtime_ready") {
    return "runtime_ready";
  }
  if (
    status === "needs_provider" ||
    status === "provider_configuring" ||
    status === "provider_verifying" ||
    status === "provider_error"
  ) {
    return "needs_provider";
  }
  if (status === "needs_channel" || status === "channel_connecting" || status === "channel_error") {
    return "needs_channel";
  }
  if (status === "ready") {
    return "ready";
  }
  if (status === "degraded") {
    return "degraded";
  }
  if (status === "stopped") {
    return "offline";
  }
  if (status === "error") {
    return "error";
  }
  return "unknown";
}

function isRuntimeReady(status: OctogenHermesRuntimeStatus): boolean {
  return ["runtime_ready", "needs_provider", "needs_channel", "ready", "degraded"].includes(status);
}

function buildNextStep(status: OctogenHermesRuntimeStatus): string {
  if (status === "runtime_ready" || status === "needs_provider") {
    return "Install and verify an AI Provider for this Hermes agent.";
  }
  if (status === "needs_channel") {
    return "Connect WhatsApp, Telegram, or another delivery channel.";
  }
  if (status === "ready") {
    return "Use the connected channels, tasks, skills, and activity stream.";
  }
  if (status === "error") {
    return "Inspect runtime action logs, fix the runner issue, then retry provisioning.";
  }
  if (status === "offline") {
    return "Bring the VM or Hermes runner back online, then sync runtime status.";
  }
  return "Connect the VM-side Hermes runner so Octogen can execute this runtime action.";
}

function toRuntimeAction(
  row: Partial<OctogenHermesRuntimeAction> | null,
): OctogenHermesRuntimeAction | null {
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

function toRuntimeSnapshot(
  row: Partial<OctogenHermesRuntimeSnapshot> | null,
): OctogenHermesRuntimeSnapshot | null {
  if (!row?.id || !row.workspace_id || !row.agent_id || !row.runtime_status) {
    return null;
  }
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    agent_id: row.agent_id,
    vm_id: row.vm_id || null,
    adapter_kind: "hermes",
    adapter_contract: row.adapter_contract || HERMES_RUNTIME_CONTRACT,
    runtime_status: row.runtime_status,
    runtime_agent_id: row.runtime_agent_id || null,
    hermes_profile_id: row.hermes_profile_id || null,
    hermes_version: row.hermes_version || null,
    runner_version: row.runner_version || null,
    last_heartbeat_at: row.last_heartbeat_at || null,
    last_error: row.last_error || null,
    observed_payload: normalizeRecord(row.observed_payload),
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
  };
}

function readAdapterMode(
  snapshot: OctogenHermesRuntimeSnapshot | null,
): "pending_runner" | "runner_observed" {
  const mode = snapshot?.observed_payload.adapter_mode;
  return mode === "runner_observed" ? "runner_observed" : "pending_runner";
}

export class OctogenHermesAdapterService {
  constructor(private readonly agentService = new OctogenAgentService()) {}

  async getRuntimeStatus(
    workspaceId: string,
    agentIdInput: unknown,
  ): Promise<OctogenHermesRuntimeStatusView> {
    const agentId = normalizeAgentId(agentIdInput);
    const agent = await this.agentService.getWorkspaceAgent(workspaceId, agentId);
    const [latestAction, latestSnapshot] = await Promise.all([
      this.fetchLatestAction(workspaceId, agent.id),
      this.fetchLatestSnapshot(workspaceId, agent.id),
    ]);
    const status = latestSnapshot?.runtime_status || agentStatusToRuntimeStatus(agent.status);
    const adapterReady = isRuntimeReady(status);
    return {
      agent,
      status,
      adapterReady,
      adapterMode: readAdapterMode(latestSnapshot),
      latestAction,
      latestSnapshot,
      nextStep: buildNextStep(status),
      message: adapterReady ? "Hermes runtime has reported readiness." : PENDING_RUNNER_MESSAGE,
    };
  }

  async provisionRuntime(
    userId: string,
    workspaceId: string,
    agentIdInput: unknown,
  ): Promise<OctogenHermesRuntimeProvisionResult> {
    const agentId = normalizeAgentId(agentIdInput);
    const agent = await this.agentService.getWorkspaceAgent(workspaceId, agentId);
    if (agent.runtime_kind !== "hermes") {
      throw new OctogenServiceError(
        "UNSUPPORTED_RUNTIME",
        "Only Hermes runtime agents can be provisioned here.",
        400,
      );
    }
    if (!agent.vm_id) {
      throw new OctogenServiceError(
        "VM_REQUIRED",
        "Attach this agent to a workspace VM before provisioning its runtime.",
        409,
      );
    }

    const now = new Date().toISOString();
    const requestPayload = {
      protocol: HERMES_RUNTIME_CONTRACT,
      adapter_mode: "pending_runner",
      runner_required: true,
      agent_id: agent.id,
      vm_id: agent.vm_id,
      hermes_profile_id: agent.hermes_profile_id,
      runtime_agent_id: agent.runtime_agent_id,
      requested_at: now,
      desired_capabilities: ["tasks", "logs", "activities", "skills", "channels"],
      onboarding_sequence: [
        "provision_runtime",
        "install_ai_provider",
        "run_test_chat",
        "connect_channel",
      ],
    };

    const { data: actionData, error: actionError } = await supabaseAdmin
      .from("octogen_agent_runtime_actions")
      .insert({
        workspace_id: workspaceId,
        agent_id: agent.id,
        vm_id: agent.vm_id,
        adapter_kind: "hermes",
        adapter_contract: HERMES_RUNTIME_CONTRACT,
        action_type: "provision_runtime",
        status: "queued",
        requested_by_user_id: userId,
        request_payload: requestPayload,
      })
      .select("*")
      .single();

    const action = toRuntimeAction(actionData as Partial<OctogenHermesRuntimeAction> | null);
    if (actionError || !action) {
      throw new OctogenServiceError(
        "RUNTIME_ACTION_CREATE_FAILED",
        actionError?.message || "Failed to queue Hermes runtime provisioning",
        500,
      );
    }

    const { data: snapshotData, error: snapshotError } = await supabaseAdmin
      .from("octogen_agent_runtime_snapshots")
      .insert({
        workspace_id: workspaceId,
        agent_id: agent.id,
        vm_id: agent.vm_id,
        adapter_kind: "hermes",
        adapter_contract: HERMES_RUNTIME_CONTRACT,
        runtime_status: "provisioning",
        runtime_agent_id: agent.runtime_agent_id,
        hermes_profile_id: agent.hermes_profile_id,
        observed_payload: {
          adapter_mode: "pending_runner",
          action_id: action.id,
          message: PENDING_RUNNER_MESSAGE,
          observed_at: now,
        },
      })
      .select("*")
      .single();

    const snapshot = toRuntimeSnapshot(
      snapshotData as Partial<OctogenHermesRuntimeSnapshot> | null,
    );
    if (snapshotError || !snapshot) {
      throw new OctogenServiceError(
        "RUNTIME_SNAPSHOT_CREATE_FAILED",
        snapshotError?.message || "Failed to record Hermes runtime status",
        500,
      );
    }

    const metadata = normalizeRecord(agent.metadata);
    const { error: updateError } = await supabaseAdmin
      .from("octogen_agents")
      .update({
        status: "provisioning",
        last_error: null,
        metadata: {
          ...metadata,
          onboarding_stage: "runtime",
          runtime_contract: HERMES_RUNTIME_CONTRACT,
          runtime_provisioning: {
            action_id: action.id,
            adapter_mode: "pending_runner",
            queued_at: now,
            runner_required: true,
          },
        },
      })
      .eq("workspace_id", workspaceId)
      .eq("id", agent.id);

    if (updateError) {
      throw new OctogenServiceError(
        "AGENT_RUNTIME_UPDATE_FAILED",
        updateError.message || "Failed to update Hermes agent runtime status",
        500,
      );
    }

    await this.logAgentEvent(
      workspaceId,
      agent.id,
      userId,
      "runtime.provision_queued",
      PENDING_RUNNER_MESSAGE,
      {
        actionId: action.id,
        vmId: agent.vm_id,
        hermesProfileId: agent.hermes_profile_id,
      },
    );

    const hydratedAgent = await this.agentService.getWorkspaceAgent(workspaceId, agent.id);
    return {
      agent: hydratedAgent,
      status: snapshot.runtime_status,
      adapterReady: false,
      adapterMode: "pending_runner",
      latestAction: action,
      latestSnapshot: snapshot,
      action,
      snapshot,
      nextStep: buildNextStep(snapshot.runtime_status),
      message: PENDING_RUNNER_MESSAGE,
    };
  }

  private async fetchLatestAction(
    workspaceId: string,
    agentId: string,
  ): Promise<OctogenHermesRuntimeAction | null> {
    const { data, error } = await supabaseAdmin
      .from("octogen_agent_runtime_actions")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new OctogenServiceError(
        "RUNTIME_ACTION_FETCH_FAILED",
        error.message || "Failed to fetch Hermes runtime action",
        500,
      );
    }
    return toRuntimeAction(data as Partial<OctogenHermesRuntimeAction> | null);
  }

  private async fetchLatestSnapshot(
    workspaceId: string,
    agentId: string,
  ): Promise<OctogenHermesRuntimeSnapshot | null> {
    const { data, error } = await supabaseAdmin
      .from("octogen_agent_runtime_snapshots")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new OctogenServiceError(
        "RUNTIME_SNAPSHOT_FETCH_FAILED",
        error.message || "Failed to fetch Hermes runtime status",
        500,
      );
    }
    return toRuntimeSnapshot(data as Partial<OctogenHermesRuntimeSnapshot> | null);
  }

  private async logAgentEvent(
    workspaceId: string,
    agentId: string,
    userId: string | null,
    eventType: string,
    message: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await supabaseAdmin.from("octogen_agent_events").insert({
      workspace_id: workspaceId,
      agent_id: agentId,
      actor_user_id: userId,
      event_type: eventType,
      level: "info",
      message,
      payload,
    });

    if (error) {
      console.error("[Octogen Console] Failed to persist Hermes runtime event", {
        workspaceId,
        agentId,
        eventType,
        error: error.message,
      });
    }
  }
}
