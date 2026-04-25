-- Octogen Console Phase 4: VM-side Hermes runner polling indexes
-- Runner APIs claim queued runtime actions by VM, then report snapshots back to Octogen.

CREATE INDEX IF NOT EXISTS idx_octogen_agent_runtime_actions_vm_status_created_at
    ON public.octogen_agent_runtime_actions(vm_id, status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_octogen_agent_runtime_snapshots_vm_created_at
    ON public.octogen_agent_runtime_snapshots(vm_id, created_at DESC);

COMMENT ON INDEX public.idx_octogen_agent_runtime_actions_vm_status_created_at IS 'Supports VM-side Hermes runner polling for queued runtime actions.';
COMMENT ON INDEX public.idx_octogen_agent_runtime_snapshots_vm_created_at IS 'Supports VM-side Hermes runner status lookups by managed VM.';
