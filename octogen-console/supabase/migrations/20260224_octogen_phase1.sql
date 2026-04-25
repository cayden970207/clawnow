-- Octogen Console Phase 1: workspace-owned Hetzner VM console tables
-- Workspace ownership follows Supabase organization membership. Users are actors inside a workspace.

CREATE TABLE IF NOT EXISTS public.octogen_vms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    provider TEXT NOT NULL DEFAULT 'hetzner' CHECK (provider = 'hetzner'),
    region TEXT NOT NULL DEFAULT 'sin',
    server_type TEXT NOT NULL DEFAULT 'cpx31',
    image TEXT NOT NULL DEFAULT 'ubuntu-22.04',
    server_name TEXT NOT NULL,
    hetzner_server_id BIGINT UNIQUE,
    status TEXT NOT NULL DEFAULT 'provisioning' CHECK (
        status IN ('provisioning', 'running', 'recovering', 'stopped', 'error', 'deleting', 'terminated')
    ),
    ipv4 TEXT,
    ipv6 TEXT,
    gateway_url TEXT,
    control_ui_url TEXT,
    novnc_url TEXT,
    provisioning_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    provisioned_at TIMESTAMPTZ,
    last_heartbeat_at TIMESTAMPTZ,
    novnc_enabled_until TIMESTAMPTZ,
    last_error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_octogen_vms_workspace_created_at
    ON public.octogen_vms(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_octogen_vms_workspace_status
    ON public.octogen_vms(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_octogen_vms_status ON public.octogen_vms(status);
CREATE INDEX IF NOT EXISTS idx_octogen_vms_updated_at ON public.octogen_vms(updated_at DESC);

CREATE TABLE IF NOT EXISTS public.octogen_vm_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vm_id UUID NOT NULL REFERENCES public.octogen_vms(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL,
    actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
    message TEXT NOT NULL DEFAULT '',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_octogen_vm_events_vm_created_at
    ON public.octogen_vm_events(vm_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_octogen_vm_events_workspace_created_at
    ON public.octogen_vm_events(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_octogen_vm_events_actor_created_at
    ON public.octogen_vm_events(actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.octogen_vm_access_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vm_id UUID NOT NULL REFERENCES public.octogen_vms(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL,
    actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    session_type TEXT NOT NULL CHECK (session_type IN ('control_ui', 'desktop', 'novnc')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    client_ip TEXT,
    user_agent TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_octogen_vm_access_sessions_vm_created_at
    ON public.octogen_vm_access_sessions(vm_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_octogen_vm_access_sessions_workspace_created_at
    ON public.octogen_vm_access_sessions(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_octogen_vm_access_sessions_actor_created_at
    ON public.octogen_vm_access_sessions(actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_octogen_vm_access_sessions_expires_at
    ON public.octogen_vm_access_sessions(expires_at);

ALTER TABLE public.octogen_vms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.octogen_vm_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.octogen_vm_access_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "octogen_vms_select_workspace" ON public.octogen_vms;
CREATE POLICY "octogen_vms_select_workspace"
    ON public.octogen_vms FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM public.organization_members om
            WHERE om.organization_id = workspace_id
              AND om.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "octogen_vms_insert_workspace" ON public.octogen_vms;
CREATE POLICY "octogen_vms_insert_workspace"
    ON public.octogen_vms FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM public.organization_members om
            WHERE om.organization_id = workspace_id
              AND om.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "octogen_vms_update_workspace" ON public.octogen_vms;
CREATE POLICY "octogen_vms_update_workspace"
    ON public.octogen_vms FOR UPDATE
    USING (
        EXISTS (
            SELECT 1
            FROM public.organization_members om
            WHERE om.organization_id = workspace_id
              AND om.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM public.organization_members om
            WHERE om.organization_id = workspace_id
              AND om.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "octogen_vm_events_select_workspace" ON public.octogen_vm_events;
CREATE POLICY "octogen_vm_events_select_workspace"
    ON public.octogen_vm_events FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM public.organization_members om
            WHERE om.organization_id = workspace_id
              AND om.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "octogen_vm_access_sessions_select_workspace" ON public.octogen_vm_access_sessions;
CREATE POLICY "octogen_vm_access_sessions_select_workspace"
    ON public.octogen_vm_access_sessions FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM public.organization_members om
            WHERE om.organization_id = workspace_id
              AND om.user_id = auth.uid()
        )
    );

CREATE OR REPLACE FUNCTION public.update_octogen_vms_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS octogen_vms_updated_at ON public.octogen_vms;
CREATE TRIGGER octogen_vms_updated_at
    BEFORE UPDATE ON public.octogen_vms
    FOR EACH ROW
    EXECUTE FUNCTION public.update_octogen_vms_updated_at();

COMMENT ON TABLE public.octogen_vms IS 'Workspace-owned Octogen Console VM state. A workspace can own multiple managed VMs.';
COMMENT ON TABLE public.octogen_vm_events IS 'Workspace-scoped audit/event stream for lifecycle operations on octogen_vms.';
COMMENT ON TABLE public.octogen_vm_access_sessions IS 'Workspace-scoped short-lived trusted-proxy access sessions for Control UI and desktop access.';
