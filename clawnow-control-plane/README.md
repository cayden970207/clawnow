# ClawNow Control Plane (Migrated From miniflow)

This directory contains the ClawNow Phase 1 control-plane work migrated from:

- `/Users/cayden0207/Desktop/Cursor/miniflow`

The code here is kept as a standalone scaffold so it does not interfere with OpenClaw core runtime code.

## Quick Start

1. Install deps

```bash
cd clawnow-control-plane
pnpm install
```

2. Create env

```bash
cp .env.example .env.local
```

3. Start local dev server

```bash
pnpm dev
```

The app runs at `http://localhost:3333` and serves `/clawnow`.

## Included

- Onboarding-first page (`Deploy your first 🦞`):
  - `src/app/clawnow/page.tsx`
- API routes for instance lifecycle + session launch:
  - `src/app/api/clawnow/instances/*`
- Backend services (Hetzner + signed sessions + per-instance gateway URL):
  - `src/lib/services/clawnow.service.ts`
  - `src/lib/services/clawnow-hetzner.service.ts`
  - `src/lib/services/clawnow-http.ts`
- Supabase migration:
  - `supabase/migrations/20260224_clawnow_phase1.sql`
- Phase 1 design notes:
  - `docs/clawnow-phase1.md`

## Runtime Notes

This scaffold expects a Next.js/Supabase control-plane app environment with:

- `@/lib/server-auth` available
- API routes under Next App Router (`src/app/api/...`)
- the same CreateNow auth header flow (`requireAuth`)

By default, VM cloud-init auto-runs this script for 24/7 startup:

- `https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/clawnow-vm-bootstrap.sh`

If you need a custom startup sequence, set `CLAWNOW_OPENCLAW_BOOTSTRAP_COMMAND`.

## Key Environment Variables

```env
CLAWNOW_HETZNER_API_TOKEN=
CLAWNOW_HETZNER_LOCATION=sin
CLAWNOW_HETZNER_SERVER_TYPE=cpx31
CLAWNOW_HETZNER_IMAGE=ubuntu-22.04
CLAWNOW_VM_NAME_PREFIX=clawnow

# Per-instance gateway (default)
# Uses Caddy on each VM and dynamic DNS via sslip.io for HTTPS secure context.
CLAWNOW_INSTANCE_GATEWAY_TEMPLATE=https://{{IPV4}}.sslip.io
CLAWNOW_CONTROL_UI_PATH=clawnow
CLAWNOW_NOVNC_PATH=novnc

# Optional shared-proxy mode
CLAWNOW_GATEWAY_BASE_URL=
CLAWNOW_CONTROL_UI_BASE_URL=
CLAWNOW_NOVNC_BASE_URL=

CLAWNOW_CONTROL_UI_ALLOWED_ORIGIN=
CLAWNOW_PROXY_SHARED_SECRET=
CLAWNOW_CONTROL_SESSION_TTL_SECONDS=300
CLAWNOW_NOVNC_TTL_MINUTES=30
CLAWNOW_PROVISIONING_TIMEOUT_SECONDS=900
CLAWNOW_HETZNER_CLOUD_INIT=
CLAWNOW_OPENCLAW_BOOTSTRAP_COMMAND=
# Example using template placeholders:
# CLAWNOW_OPENCLAW_BOOTSTRAP_COMMAND=curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/clawnow-vm-bootstrap.sh | bash -s -- --proxy-secret '{{PROXY_SHARED_SECRET}}' --control-prefix '/{{CONTROL_UI_PATH}}' --novnc-prefix '/{{NOVNC_PATH}}'
```
