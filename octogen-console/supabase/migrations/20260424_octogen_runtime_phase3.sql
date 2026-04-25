-- Octogen Console Phase 3: Hermes runtime action and status boundary
-- The console records runtime intent now; a VM-side Hermes runner can execute and report later.

ALTER TABLE public.octogen_agents
    ALTER COLUMN status SET DEFAULT 'provisioning';

CREATE TABLE IF NOT EXISTS public.octogen_agent_runtime_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    agent_id UUID NOT NULL REFERENCES public.octogen_agents(id) ON DELETE CASCADE,
    vm_id UUID REFERENCES public.octogen_vms(id) ON DELETE SET NULL,
    adapter_kind TEXT NOT NULL DEFAULT 'hermes' CHECK (adapter_kind = 'hermes'),
    adapter_contract TEXT NOT NULL DEFAULT 'octogen.hermes.v1',
    action_type TEXT NOT NULL CHECK (
        action_type IN ('provision_runtime', 'sync_status', 'configure_provider', 'test_chat', 'connect_channel')
    ),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (
        status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
    ),
    requested_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_error TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_octogen_agent_runtime_actions_workspace_created_at
    ON public.octogen_agent_runtime_actions(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_octogen_agent_runtime_actions_agent_created_at
    ON public.octogen_agent_runtime_actions(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_octogen_agent_runtime_actions_status
    ON public.octogen_agent_runtime_actions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.octogen_agent_runtime_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    agent_id UUID NOT NULL REFERENCES public.octogen_agents(id) ON DELETE CASCADE,
    vm_id UUID REFERENCES public.octogen_vms(id) ON DELETE SET NULL,
    adapter_kind TEXT NOT NULL DEFAULT 'hermes' CHECK (adapter_kind = 'hermes'),
    adapter_contract TEXT NOT NULL DEFAULT 'octogen.hermes.v1',
    runtime_status TEXT NOT NULL DEFAULT 'pending' CHECK (
        runtime_status IN (
            'unknown',
            'pending',
            'provisioning',
            'runtime_ready',
            'needs_provider',
            'needs_channel',
            'ready',
            'degraded',
            'error',
            'offline'
        )
    ),
    runtime_agent_id TEXT,
    hermes_profile_id TEXT,
    hermes_version TEXT,
    runner_version TEXT,
    last_heartbeat_at TIMESTAMPTZ,
    last_error TEXT,
    observed_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_octogen_agent_runtime_snapshots_workspace_created_at
    ON public.octogen_agent_runtime_snapshots(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_octogen_agent_runtime_snapshots_agent_created_at
    ON public.octogen_agent_runtime_snapshots(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_octogen_agent_runtime_snapshots_status
    ON public.octogen_agent_runtime_snapshots(runtime_status, created_at DESC);

ALTER TABLE public.octogen_agent_runtime_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.octogen_agent_runtime_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "octogen_agent_runtime_actions_select_workspace" ON public.octogen_agent_runtime_actions;
CREATE POLICY "octogen_agent_runtime_actions_select_workspace"
    ON public.octogen_agent_runtime_actions FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.organization_members om WHERE om.organization_id = workspace_id AND om.user_id = auth.uid()));

DROP POLICY IF EXISTS "octogen_agent_runtime_snapshots_select_workspace" ON public.octogen_agent_runtime_snapshots;
CREATE POLICY "octogen_agent_runtime_snapshots_select_workspace"
    ON public.octogen_agent_runtime_snapshots FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.organization_members om WHERE om.organization_id = workspace_id AND om.user_id = auth.uid()));

DROP TRIGGER IF EXISTS octogen_agent_runtime_actions_updated_at ON public.octogen_agent_runtime_actions;
CREATE TRIGGER octogen_agent_runtime_actions_updated_at
    BEFORE UPDATE ON public.octogen_agent_runtime_actions
    FOR EACH ROW
    EXECUTE FUNCTION public.update_octogen_agent_resource_updated_at();

DROP TRIGGER IF EXISTS octogen_agent_runtime_snapshots_updated_at ON public.octogen_agent_runtime_snapshots;
CREATE TRIGGER octogen_agent_runtime_snapshots_updated_at
    BEFORE UPDATE ON public.octogen_agent_runtime_snapshots
    FOR EACH ROW
    EXECUTE FUNCTION public.update_octogen_agent_resource_updated_at();

COMMENT ON TABLE public.octogen_agent_runtime_actions IS 'Workspace-scoped requested Hermes runtime operations. A VM-side runner can claim and complete these actions.';
COMMENT ON TABLE public.octogen_agent_runtime_snapshots IS 'Observed Hermes runtime status snapshots reported by the adapter or VM-side runner.';
