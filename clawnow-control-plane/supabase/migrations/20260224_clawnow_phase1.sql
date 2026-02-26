-- ClawNow Phase 1: dedicated Hetzner VM control plane tables
-- Enforces 1 user = 1 VM and supports trusted-proxy access sessions

CREATE TABLE IF NOT EXISTS public.claw_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
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
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_claw_instances_status ON public.claw_instances(status);
CREATE INDEX IF NOT EXISTS idx_claw_instances_updated_at ON public.claw_instances(updated_at DESC);

CREATE TABLE IF NOT EXISTS public.claw_instance_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id UUID NOT NULL REFERENCES public.claw_instances(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
    message TEXT NOT NULL DEFAULT '',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claw_instance_events_instance_created_at
    ON public.claw_instance_events(instance_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_claw_instance_events_user_created_at
    ON public.claw_instance_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.claw_access_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id UUID NOT NULL REFERENCES public.claw_instances(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    session_type TEXT NOT NULL CHECK (session_type IN ('control_ui', 'novnc')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    client_ip TEXT,
    user_agent TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claw_access_sessions_instance_created_at
    ON public.claw_access_sessions(instance_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_claw_access_sessions_user_created_at
    ON public.claw_access_sessions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_claw_access_sessions_expires_at
    ON public.claw_access_sessions(expires_at);

ALTER TABLE public.claw_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claw_instance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claw_access_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "claw_instances_select_own" ON public.claw_instances;
CREATE POLICY "claw_instances_select_own"
    ON public.claw_instances FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "claw_instances_insert_own" ON public.claw_instances;
CREATE POLICY "claw_instances_insert_own"
    ON public.claw_instances FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "claw_instances_update_own" ON public.claw_instances;
CREATE POLICY "claw_instances_update_own"
    ON public.claw_instances FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "claw_instance_events_select_own" ON public.claw_instance_events;
CREATE POLICY "claw_instance_events_select_own"
    ON public.claw_instance_events FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "claw_access_sessions_select_own" ON public.claw_access_sessions;
CREATE POLICY "claw_access_sessions_select_own"
    ON public.claw_access_sessions FOR SELECT
    USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.update_claw_instances_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS claw_instances_updated_at ON public.claw_instances;
CREATE TRIGGER claw_instances_updated_at
    BEFORE UPDATE ON public.claw_instances
    FOR EACH ROW
    EXECUTE FUNCTION public.update_claw_instances_updated_at();

COMMENT ON TABLE public.claw_instances IS 'ClawNow user VM state. Phase 1 enforces exactly one VM per user.';
COMMENT ON TABLE public.claw_instance_events IS 'Audit/event stream for lifecycle operations on claw_instances.';
COMMENT ON TABLE public.claw_access_sessions IS 'Short-lived trusted-proxy access sessions for Control UI and noVNC.';
