-- Octogen Console Phase 2: workspace-owned Hermes agent foundation
-- Agents are the user-facing workers hosted on managed Octogen VMs.

CREATE TABLE IF NOT EXISTS public.octogen_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    vm_id UUID REFERENCES public.octogen_vms(id) ON DELETE SET NULL,
    created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    runtime_kind TEXT NOT NULL DEFAULT 'hermes' CHECK (runtime_kind = 'hermes'),
    runtime_agent_id TEXT,
    hermes_profile_id TEXT,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'needs_provider' CHECK (
        status IN (
            'draft',
            'provisioning',
            'runtime_ready',
            'needs_provider',
            'provider_configuring',
            'provider_verifying',
            'provider_error',
            'needs_test_chat',
            'test_chat_running',
            'test_chat_failed',
            'needs_channel',
            'channel_connecting',
            'channel_error',
            'ready',
            'degraded',
            'stopped',
            'error',
            'archived'
        )
    ),
    current_observed_task TEXT,
    last_seen_at TIMESTAMPTZ,
    last_error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_octogen_agents_workspace_created_at
    ON public.octogen_agents(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_octogen_agents_workspace_status
    ON public.octogen_agents(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_octogen_agents_workspace_vm
    ON public.octogen_agents(workspace_id, vm_id);
CREATE INDEX IF NOT EXISTS idx_octogen_agents_owner
    ON public.octogen_agents(owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.octogen_agent_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    agent_id UUID NOT NULL REFERENCES public.octogen_agents(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL CHECK (
        provider_id IN (
            'openai',
            'openai_codex',
            'openrouter',
            'anthropic',
            'gemini',
            'custom_openai',
            'nous'
        )
    ),
    model_id TEXT,
    base_url TEXT,
    credential_fingerprint TEXT,
    credential_masked_label TEXT,
    status TEXT NOT NULL DEFAULT 'missing' CHECK (
        status IN ('missing', 'configuring', 'verifying', 'verified', 'invalid', 'expired', 'quota_limited', 'error')
    ),
    last_verified_at TIMESTAMPTZ,
    last_error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (agent_id, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_octogen_agent_providers_workspace_status
    ON public.octogen_agent_providers(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_octogen_agent_providers_agent
    ON public.octogen_agent_providers(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.octogen_agent_channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    agent_id UUID NOT NULL REFERENCES public.octogen_agents(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (
        channel IN ('whatsapp', 'telegram', 'discord', 'slack', 'signal', 'imessage', 'web', 'email')
    ),
    status TEXT NOT NULL DEFAULT 'missing' CHECK (
        status IN ('missing', 'connecting', 'needs_action', 'connected', 'disconnected', 'expired', 'disabled', 'error')
    ),
    external_id TEXT,
    display_name TEXT,
    identity JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_connected_at TIMESTAMPTZ,
    last_error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (agent_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_octogen_agent_channels_workspace_status
    ON public.octogen_agent_channels(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_octogen_agent_channels_agent
    ON public.octogen_agent_channels(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_octogen_agent_channels_channel
    ON public.octogen_agent_channels(channel, status);

CREATE TABLE IF NOT EXISTS public.octogen_agent_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    agent_id UUID NOT NULL REFERENCES public.octogen_agents(id) ON DELETE CASCADE,
    runtime_task_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued' CHECK (
        status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')
    ),
    current_step TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    last_error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_octogen_agent_tasks_workspace_created_at
    ON public.octogen_agent_tasks(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_octogen_agent_tasks_agent_created_at
    ON public.octogen_agent_tasks(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_octogen_agent_tasks_status
    ON public.octogen_agent_tasks(status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.octogen_agent_skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    agent_id UUID NOT NULL REFERENCES public.octogen_agents(id) ON DELETE CASCADE,
    skill_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'disabled' CHECK (
        status IN ('disabled', 'enabled', 'configuring', 'error')
    ),
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (agent_id, skill_key)
);

CREATE INDEX IF NOT EXISTS idx_octogen_agent_skills_workspace_status
    ON public.octogen_agent_skills(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_octogen_agent_skills_agent
    ON public.octogen_agent_skills(agent_id, skill_key);

CREATE TABLE IF NOT EXISTS public.octogen_agent_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    agent_id UUID REFERENCES public.octogen_agents(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
    message TEXT NOT NULL DEFAULT '',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_octogen_agent_events_workspace_created_at
    ON public.octogen_agent_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_octogen_agent_events_agent_created_at
    ON public.octogen_agent_events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_octogen_agent_events_actor_created_at
    ON public.octogen_agent_events(actor_user_id, created_at DESC);

ALTER TABLE public.octogen_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.octogen_agent_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.octogen_agent_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.octogen_agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.octogen_agent_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.octogen_agent_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "octogen_agents_select_workspace" ON public.octogen_agents;
CREATE POLICY "octogen_agents_select_workspace"
    ON public.octogen_agents FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.organization_members om WHERE om.organization_id = workspace_id AND om.user_id = auth.uid()));

DROP POLICY IF EXISTS "octogen_agents_insert_workspace" ON public.octogen_agents;
CREATE POLICY "octogen_agents_insert_workspace"
    ON public.octogen_agents FOR INSERT
    WITH CHECK (EXISTS (SELECT 1 FROM public.organization_members om WHERE om.organization_id = workspace_id AND om.user_id = auth.uid()));

DROP POLICY IF EXISTS "octogen_agents_update_workspace" ON public.octogen_agents;
CREATE POLICY "octogen_agents_update_workspace"
    ON public.octogen_agents FOR UPDATE
    USING (EXISTS (SELECT 1 FROM public.organization_members om WHERE om.organization_id = workspace_id AND om.user_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM public.organization_members om WHERE om.organization_id = workspace_id AND om.user_id = auth.uid()));

DROP POLICY IF EXISTS "octogen_agent_providers_select_workspace" ON public.octogen_agent_providers;
CREATE POLICY "octogen_agent_providers_select_workspace"
    ON public.octogen_agent_providers FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.organization_members om WHERE om.organization_id = workspace_id AND om.user_id = auth.uid()));

DROP POLICY IF EXISTS "octogen_agent_channels_select_workspace" ON public.octogen_agent_channels;
CREATE POLICY "octogen_agent_channels_select_workspace"
    ON public.octogen_agent_channels FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.organization_members om WHERE om.organization_id = workspace_id AND om.user_id = auth.uid()));

DROP POLICY IF EXISTS "octogen_agent_tasks_select_workspace" ON public.octogen_agent_tasks;
CREATE POLICY "octogen_agent_tasks_select_workspace"
    ON public.octogen_agent_tasks FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.organization_members om WHERE om.organization_id = workspace_id AND om.user_id = auth.uid()));

DROP POLICY IF EXISTS "octogen_agent_skills_select_workspace" ON public.octogen_agent_skills;
CREATE POLICY "octogen_agent_skills_select_workspace"
    ON public.octogen_agent_skills FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.organization_members om WHERE om.organization_id = workspace_id AND om.user_id = auth.uid()));

DROP POLICY IF EXISTS "octogen_agent_events_select_workspace" ON public.octogen_agent_events;
CREATE POLICY "octogen_agent_events_select_workspace"
    ON public.octogen_agent_events FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.organization_members om WHERE om.organization_id = workspace_id AND om.user_id = auth.uid()));

CREATE OR REPLACE FUNCTION public.update_octogen_agent_resource_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS octogen_agents_updated_at ON public.octogen_agents;
CREATE TRIGGER octogen_agents_updated_at
    BEFORE UPDATE ON public.octogen_agents
    FOR EACH ROW
    EXECUTE FUNCTION public.update_octogen_agent_resource_updated_at();

DROP TRIGGER IF EXISTS octogen_agent_providers_updated_at ON public.octogen_agent_providers;
CREATE TRIGGER octogen_agent_providers_updated_at
    BEFORE UPDATE ON public.octogen_agent_providers
    FOR EACH ROW
    EXECUTE FUNCTION public.update_octogen_agent_resource_updated_at();

DROP TRIGGER IF EXISTS octogen_agent_channels_updated_at ON public.octogen_agent_channels;
CREATE TRIGGER octogen_agent_channels_updated_at
    BEFORE UPDATE ON public.octogen_agent_channels
    FOR EACH ROW
    EXECUTE FUNCTION public.update_octogen_agent_resource_updated_at();

DROP TRIGGER IF EXISTS octogen_agent_tasks_updated_at ON public.octogen_agent_tasks;
CREATE TRIGGER octogen_agent_tasks_updated_at
    BEFORE UPDATE ON public.octogen_agent_tasks
    FOR EACH ROW
    EXECUTE FUNCTION public.update_octogen_agent_resource_updated_at();

DROP TRIGGER IF EXISTS octogen_agent_skills_updated_at ON public.octogen_agent_skills;
CREATE TRIGGER octogen_agent_skills_updated_at
    BEFORE UPDATE ON public.octogen_agent_skills
    FOR EACH ROW
    EXECUTE FUNCTION public.update_octogen_agent_resource_updated_at();

COMMENT ON TABLE public.octogen_agents IS 'Workspace-owned Hermes agent records hosted on Octogen managed VMs.';
COMMENT ON TABLE public.octogen_agent_providers IS 'Per-agent AI provider configuration state. Secrets live on the VM runtime, not in this table.';
COMMENT ON TABLE public.octogen_agent_channels IS 'Per-agent channel connection state such as WhatsApp numbers or Telegram bot identities.';
COMMENT ON TABLE public.octogen_agent_tasks IS 'Observed Hermes task state for dashboard and activity previews.';
COMMENT ON TABLE public.octogen_agent_skills IS 'Agent-enabled skills drawn from workspace marketplace installs.';
COMMENT ON TABLE public.octogen_agent_events IS 'Workspace-scoped audit and activity stream for agent lifecycle and runtime events.';
