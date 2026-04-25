import { randomUUID } from "crypto";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/server-auth";
import { OctogenServiceError } from "@/lib/services/octogen.service";

export type OctogenAgentStatus =
  | "draft"
  | "provisioning"
  | "runtime_ready"
  | "needs_provider"
  | "provider_configuring"
  | "provider_verifying"
  | "provider_error"
  | "needs_test_chat"
  | "test_chat_running"
  | "test_chat_failed"
  | "needs_channel"
  | "channel_connecting"
  | "channel_error"
  | "ready"
  | "degraded"
  | "stopped"
  | "error"
  | "archived";

export type OctogenAgentProviderStatus =
  | "missing"
  | "configuring"
  | "verifying"
  | "verified"
  | "invalid"
  | "expired"
  | "quota_limited"
  | "error";

export type OctogenAgentChannelStatus =
  | "missing"
  | "connecting"
  | "needs_action"
  | "connected"
  | "disconnected"
  | "expired"
  | "disabled"
  | "error";

export interface OctogenAgent {
  id: string;
  workspace_id: string;
  vm_id: string | null;
  created_by_user_id: string | null;
  owner_user_id: string | null;
  runtime_kind: "hermes";
  runtime_agent_id: string | null;
  hermes_profile_id: string | null;
  name: string;
  status: OctogenAgentStatus;
  current_observed_task: string | null;
  last_seen_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface OctogenAgentProvider {
  id: string;
  workspace_id: string;
  agent_id: string;
  provider_id: string;
  model_id: string | null;
  base_url: string | null;
  credential_fingerprint: string | null;
  credential_masked_label: string | null;
  status: OctogenAgentProviderStatus;
  last_verified_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface OctogenAgentChannel {
  id: string;
  workspace_id: string;
  agent_id: string;
  channel: string;
  status: OctogenAgentChannelStatus;
  external_id: string | null;
  display_name: string | null;
  identity: Record<string, unknown>;
  last_connected_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface OctogenAgentWithRelations extends OctogenAgent {
  providers: OctogenAgentProvider[];
  channels: OctogenAgentChannel[];
}

export interface OctogenAgentWorkspaceSummary {
  status: "ok" | "unavailable";
  totalAgents: number;
  readyAgents: number;
  runtimeReadyAgents: number;
  runtimeProvisioningAgents: number;
  needsProviderAgents: number;
  needsChannelAgents: number;
  connectedChannels: number;
  missingProviders: number;
  runningTasks: number;
  latestAgent: OctogenAgent | null;
  message?: string;
}

interface AgentProviderRelationRow {
  id?: string | null;
  workspace_id?: string | null;
  agent_id?: string | null;
  provider_id?: string | null;
  model_id?: string | null;
  base_url?: string | null;
  credential_fingerprint?: string | null;
  credential_masked_label?: string | null;
  status?: string | null;
  last_verified_at?: string | null;
  last_error?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface AgentChannelRelationRow {
  id?: string | null;
  workspace_id?: string | null;
  agent_id?: string | null;
  channel?: string | null;
  status?: string | null;
  external_id?: string | null;
  display_name?: string | null;
  identity?: Record<string, unknown> | null;
  last_connected_at?: string | null;
  last_error?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface AgentRelationRow extends OctogenAgent {
  octogen_agent_providers?: AgentProviderRelationRow[] | null;
  octogen_agent_channels?: AgentChannelRelationRow[] | null;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
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
  const message = [payload.message, payload.details, payload.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return message.includes("does not exist") || message.includes("could not find");
}

function normalizeName(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "Hermes Agent";
  }
  return raw.replace(/\s+/g, " ").slice(0, 80);
}

function buildHermesProfileId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "hermes-agent"}-${randomUUID().slice(0, 8)}`;
}

function toProvider(row: AgentProviderRelationRow): OctogenAgentProvider | null {
  if (!row.id || !row.workspace_id || !row.agent_id || !row.provider_id || !row.status) {
    return null;
  }
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    agent_id: row.agent_id,
    provider_id: row.provider_id,
    model_id: row.model_id || null,
    base_url: row.base_url || null,
    credential_fingerprint: row.credential_fingerprint || null,
    credential_masked_label: row.credential_masked_label || null,
    status: row.status as OctogenAgentProviderStatus,
    last_verified_at: row.last_verified_at || null,
    last_error: row.last_error || null,
    metadata: row.metadata || {},
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
  };
}

function toChannel(row: AgentChannelRelationRow): OctogenAgentChannel | null {
  if (!row.id || !row.workspace_id || !row.agent_id || !row.channel || !row.status) {
    return null;
  }
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    agent_id: row.agent_id,
    channel: row.channel,
    status: row.status as OctogenAgentChannelStatus,
    external_id: row.external_id || null,
    display_name: row.display_name || null,
    identity: row.identity || {},
    last_connected_at: row.last_connected_at || null,
    last_error: row.last_error || null,
    metadata: row.metadata || {},
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
  };
}

function attachRelations(row: AgentRelationRow): OctogenAgentWithRelations {
  const providers = (row.octogen_agent_providers || [])
    .map(toProvider)
    .filter((provider): provider is OctogenAgentProvider => Boolean(provider));
  const channels = (row.octogen_agent_channels || [])
    .map(toChannel)
    .filter((channel): channel is OctogenAgentChannel => Boolean(channel));
  const { octogen_agent_providers: _providers, octogen_agent_channels: _channels, ...agent } = row;
  void _providers;
  void _channels;
  return {
    ...agent,
    metadata: agent.metadata || {},
    providers,
    channels,
  };
}

export class OctogenAgentService {
  async listWorkspaceAgents(workspaceId: string): Promise<OctogenAgentWithRelations[]> {
    const { data, error } = await supabaseAdmin
      .from("octogen_agents")
      .select("*, octogen_agent_providers(*), octogen_agent_channels(*)")
      .eq("workspace_id", workspaceId)
      .neq("status", "archived")
      .order("created_at", { ascending: false });

    if (error) {
      throw new OctogenServiceError(
        "AGENTS_FETCH_FAILED",
        error.message || "Failed to fetch agents",
        500,
      );
    }

    return ((data as AgentRelationRow[] | null) || []).map(attachRelations);
  }

  async getWorkspaceSummary(workspaceId: string): Promise<OctogenAgentWorkspaceSummary> {
    const emptySummary: OctogenAgentWorkspaceSummary = {
      status: "ok",
      totalAgents: 0,
      readyAgents: 0,
      runtimeReadyAgents: 0,
      runtimeProvisioningAgents: 0,
      needsProviderAgents: 0,
      needsChannelAgents: 0,
      connectedChannels: 0,
      missingProviders: 0,
      runningTasks: 0,
      latestAgent: null,
    };

    try {
      const [agentsResult, providersResult, channelsResult, tasksResult] = await Promise.all([
        supabaseAdmin
          .from("octogen_agents")
          .select(
            "id, workspace_id, status, created_at, updated_at, name, runtime_kind, runtime_agent_id, hermes_profile_id, vm_id, created_by_user_id, owner_user_id, current_observed_task, last_seen_at, last_error, metadata",
          )
          .eq("workspace_id", workspaceId)
          .neq("status", "archived")
          .order("created_at", { ascending: false }),
        supabaseAdmin
          .from("octogen_agent_providers")
          .select("id, status")
          .eq("workspace_id", workspaceId),
        supabaseAdmin
          .from("octogen_agent_channels")
          .select("id, status")
          .eq("workspace_id", workspaceId),
        supabaseAdmin
          .from("octogen_agent_tasks")
          .select("id, status")
          .eq("workspace_id", workspaceId)
          .in("status", ["queued", "running", "waiting"]),
      ]);

      if (agentsResult.error) {
        throw agentsResult.error;
      }
      if (providersResult.error) {
        throw providersResult.error;
      }
      if (channelsResult.error) {
        throw channelsResult.error;
      }
      if (tasksResult.error) {
        throw tasksResult.error;
      }

      const agents = ((agentsResult.data as OctogenAgent[] | null) || []).map((agent) => ({
        ...agent,
        metadata: agent.metadata || {},
      }));
      const providers = (providersResult.data as { id: string; status: string }[] | null) || [];
      const channels = (channelsResult.data as { id: string; status: string }[] | null) || [];
      const tasks = (tasksResult.data as { id: string; status: string }[] | null) || [];

      return {
        ...emptySummary,
        totalAgents: agents.length,
        readyAgents: agents.filter((agent) => agent.status === "ready").length,
        runtimeReadyAgents: agents.filter((agent) =>
          [
            "runtime_ready",
            "needs_provider",
            "needs_test_chat",
            "needs_channel",
            "channel_connecting",
            "ready",
            "degraded",
          ].includes(agent.status),
        ).length,
        runtimeProvisioningAgents: agents.filter((agent) =>
          ["draft", "provisioning"].includes(agent.status),
        ).length,
        needsProviderAgents: agents.filter((agent) =>
          ["needs_provider", "provider_error"].includes(agent.status),
        ).length,
        needsChannelAgents: agents.filter((agent) =>
          ["needs_channel", "channel_error"].includes(agent.status),
        ).length,
        connectedChannels: channels.filter((channel) => channel.status === "connected").length,
        missingProviders: providers.filter((provider) => provider.status === "missing").length,
        runningTasks: tasks.length,
        latestAgent: agents[0] || null,
      };
    } catch (error) {
      if (!isSchemaAvailabilityError(error)) {
        console.error("[Octogen Console] Failed to load agent summary", {
          workspaceId,
          error: safeErrorMessage(error),
        });
      }
      return {
        ...emptySummary,
        status: "unavailable",
        message: isSchemaAvailabilityError(error)
          ? "Agent schema is not initialized yet. Apply the Phase 2 migration."
          : "Agent data is temporarily unavailable.",
      };
    }
  }

  async createWorkspaceAgent(
    userId: string,
    workspaceId: string,
    input?: { name?: unknown; vmId?: unknown },
  ): Promise<{ agent: OctogenAgentWithRelations; created: boolean }> {
    const name = normalizeName(input?.name);
    const requestedVmId = typeof input?.vmId === "string" ? input.vmId.trim() : "";
    const vmId = requestedVmId || (await this.findDefaultWorkspaceVmId(workspaceId));

    if (!vmId) {
      throw new OctogenServiceError(
        "VM_REQUIRED",
        "Create a workspace VM before creating a Hermes agent.",
        409,
      );
    }

    await this.requireWorkspaceVm(workspaceId, vmId);

    const hermesProfileId = buildHermesProfileId(name);
    const { data, error } = await supabaseAdmin
      .from("octogen_agents")
      .insert({
        workspace_id: workspaceId,
        vm_id: vmId,
        created_by_user_id: userId,
        owner_user_id: userId,
        runtime_kind: "hermes",
        hermes_profile_id: hermesProfileId,
        name,
        status: "provisioning",
        metadata: {
          onboarding_stage: "runtime",
          runtime_contract: "octogen.hermes.v1",
        },
      })
      .select("*")
      .single();

    if (error || !data) {
      throw new OctogenServiceError(
        "AGENT_CREATE_FAILED",
        error?.message || "Failed to create Hermes agent",
        500,
      );
    }

    const agent = data as OctogenAgent;
    await Promise.all([
      this.seedProviderPlaceholders(workspaceId, agent.id),
      this.seedChannelPlaceholders(workspaceId, agent.id),
      this.logAgentEvent(workspaceId, agent.id, userId, "agent.created", "Created Hermes agent", {
        vmId,
        hermesProfileId,
      }),
    ]);

    const hydrated = await this.getWorkspaceAgent(workspaceId, agent.id);
    return { agent: hydrated, created: true };
  }

  async getWorkspaceAgent(
    workspaceId: string,
    agentId: string,
  ): Promise<OctogenAgentWithRelations> {
    const { data, error } = await supabaseAdmin
      .from("octogen_agents")
      .select("*, octogen_agent_providers(*), octogen_agent_channels(*)")
      .eq("workspace_id", workspaceId)
      .eq("id", agentId)
      .maybeSingle();

    if (error) {
      throw new OctogenServiceError(
        "AGENT_FETCH_FAILED",
        error.message || "Failed to fetch Hermes agent",
        500,
      );
    }
    if (!data) {
      throw new OctogenServiceError("AGENT_NOT_FOUND", "Hermes agent not found", 404);
    }

    return attachRelations(data as AgentRelationRow);
  }

  private async findDefaultWorkspaceVmId(workspaceId: string): Promise<string | null> {
    const { data, error } = await supabaseAdmin
      .from("octogen_vms")
      .select("id")
      .eq("workspace_id", workspaceId)
      .neq("status", "terminated")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new OctogenServiceError(
        "VM_FETCH_FAILED",
        error.message || "Failed to find workspace VM",
        500,
      );
    }

    const vmId = (data as { id?: unknown } | null)?.id;
    return typeof vmId === "string" && vmId.trim() ? vmId.trim() : null;
  }

  private async requireWorkspaceVm(workspaceId: string, vmId: string): Promise<void> {
    const { data, error } = await supabaseAdmin
      .from("octogen_vms")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("id", vmId)
      .maybeSingle();

    if (error) {
      throw new OctogenServiceError(
        "VM_FETCH_FAILED",
        error.message || "Failed to verify workspace VM",
        500,
      );
    }
    if (!data) {
      throw new OctogenServiceError(
        "VM_NOT_FOUND",
        "Selected VM does not belong to this workspace.",
        404,
      );
    }
  }

  private async seedProviderPlaceholders(workspaceId: string, agentId: string): Promise<void> {
    const { error } = await supabaseAdmin.from("octogen_agent_providers").insert({
      workspace_id: workspaceId,
      agent_id: agentId,
      provider_id: "openai",
      status: "missing",
      metadata: {
        setup_step: "ai_provider",
      },
    });

    if (error) {
      throw new OctogenServiceError(
        "AGENT_PROVIDER_SEED_FAILED",
        error.message || "Failed to initialize provider onboarding state",
        500,
      );
    }
  }

  private async seedChannelPlaceholders(workspaceId: string, agentId: string): Promise<void> {
    const { error } = await supabaseAdmin.from("octogen_agent_channels").insert([
      {
        workspace_id: workspaceId,
        agent_id: agentId,
        channel: "whatsapp",
        status: "missing",
        metadata: { setup_step: "channel" },
      },
      {
        workspace_id: workspaceId,
        agent_id: agentId,
        channel: "telegram",
        status: "missing",
        metadata: { setup_step: "channel" },
      },
    ]);

    if (error) {
      throw new OctogenServiceError(
        "AGENT_CHANNEL_SEED_FAILED",
        error.message || "Failed to initialize channel onboarding state",
        500,
      );
    }
  }

  private async logAgentEvent(
    workspaceId: string,
    agentId: string,
    userId: string | null,
    eventType: string,
    message: string,
    payload: Record<string, unknown> = {},
    level: "info" | "warn" | "error" = "info",
  ): Promise<void> {
    const { error } = await supabaseAdmin.from("octogen_agent_events").insert({
      workspace_id: workspaceId,
      agent_id: agentId,
      actor_user_id: userId,
      event_type: eventType,
      level,
      message,
      payload,
    });

    if (error) {
      console.error("[Octogen Console] Failed to persist agent event", {
        workspaceId,
        agentId,
        eventType,
        error: error.message,
      });
    }
  }
}
