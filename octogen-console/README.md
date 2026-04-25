# OCTOGEN CONSOLE (Migrated From miniflow)

This directory contains the OCTOGEN CONSOLE Phase 1 work migrated from:

- `/Users/cayden0207/Desktop/Cursor/miniflow`

The code here is kept as a standalone scaffold so it does not interfere with OpenClaw core runtime code.

## Quick Start

1. Install deps

```bash
cd octogen-console
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

The app runs at `http://localhost:3333` and serves `/octogen`.

## Railway Deploy

Use the checked-in staging flow instead of raw `railway up .`.

```bash
cd octogen-console
npm run lock:check
npm run deploy:railway
```

This flow does three things on purpose:

- validates that `package-lock.json` is a standalone npm lockfile, not a pnpm-workspace link snapshot
- stages a temporary deploy directory with only the active bootstrap assets referenced by `public/bootstrap/control-ui-manifest.json`
- uploads that staged directory with `railway up --path-as-root`

Optional follow-up smoke check:

```bash
cd octogen-console
npm run smoke:console -- --base-url https://octogen.example.com
```

This deploy path intentionally stages a slim bundle and relies on Railway's npm/Next build flow, which we have verified against this package.

## Included

- Onboarding-first page (`Deploy your first 🦞`):
  - `src/app/octogen/page.tsx`
- API routes for VM lifecycle + session launch:
  - `src/app/api/octogen/vms/*`
- Backend services (Hetzner + signed sessions + per-VM gateway URL):
  - `src/lib/services/octogen.service.ts`
  - `src/lib/services/octogen-hetzner.service.ts`
  - `src/lib/services/octogen-http.ts`
- Supabase migration:
  - `supabase/migrations/20260224_octogen_phase1.sql`
- Phase 1 design notes:
  - `docs/octogen-phase1.md`

## Runtime Notes

This scaffold expects a Next.js/Supabase OCTOGEN CONSOLE app environment with:

- `@/lib/server-auth` available
- API routes under Next App Router (`src/app/api/...`)
- the same CreateNow auth header flow (`requireAuth`)

By default, VM cloud-init auto-runs this script for 24/7 startup:

- `https://raw.githubusercontent.com/cayden970207/octogen/main/octogen-console/scripts/octogen-vm-bootstrap.sh`

If you need a custom startup sequence, set `OCTOGEN_OPENCLAW_BOOTSTRAP_COMMAND`.

## Key Environment Variables

`OCTOGEN_*` is the canonical environment variable prefix.

```env
OCTOGEN_HETZNER_API_TOKEN=
OCTOGEN_HETZNER_LOCATION=sin
OCTOGEN_HETZNER_SERVER_TYPE=cpx31
OCTOGEN_HETZNER_IMAGE=ubuntu-22.04
OCTOGEN_VM_NAME_PREFIX=octogen

# Per-VM gateway (default)
# Uses Caddy on each VM and dynamic DNS via sslip.io for HTTPS secure context.
OCTOGEN_VM_GATEWAY_TEMPLATE=https://{{IPV4}}.sslip.io
OCTOGEN_CONTROL_UI_PATH=octogen
OCTOGEN_NOVNC_PATH=novnc

# Optional shared-proxy mode
OCTOGEN_GATEWAY_BASE_URL=
OCTOGEN_CONTROL_UI_BASE_URL=
OCTOGEN_NOVNC_BASE_URL=

OCTOGEN_CONTROL_UI_ALLOWED_ORIGIN=
OCTOGEN_PROXY_SHARED_SECRET=
OCTOGEN_CONTROL_SESSION_TTL_SECONDS=300
OCTOGEN_NOVNC_TTL_MINUTES=30
OCTOGEN_PROVISIONING_TIMEOUT_SECONDS=900
OCTOGEN_HETZNER_CLOUD_INIT=
OCTOGEN_OPENCLAW_BOOTSTRAP_COMMAND=
# Example using template placeholders:
# OCTOGEN_OPENCLAW_BOOTSTRAP_COMMAND=curl -fsSL https://raw.githubusercontent.com/cayden970207/octogen/main/octogen-console/scripts/octogen-vm-bootstrap.sh | bash -s -- --proxy-secret '{{PROXY_SHARED_SECRET}}' --control-prefix '/{{CONTROL_UI_PATH}}' --novnc-prefix '/{{NOVNC_PATH}}'
```
