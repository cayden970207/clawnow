# Octogen Phase 4: Hermes Runner Contract

Phase 4 turns queued Hermes runtime actions into a VM-side runner protocol.

## Flow

1. Console queues a `provision_runtime` action in `octogen_agent_runtime_actions`.
2. A VM-side Hermes runner polls `POST /api/octogen/runner/hermes/actions/claim`.
3. Console authenticates the runner with VM id plus HMAC signature.
4. Console marks one queued action as `running` and returns the action payload plus agent profile.
5. Runner provisions or observes Hermes locally.
6. Runner reports progress or completion to `POST /api/octogen/runner/hermes/actions/report`.
7. Console writes `octogen_agent_runtime_snapshots` and updates `octogen_agents` status.

## VM Environment

Bootstrap writes `/etc/octogen-runner.env`:

```sh
OCTOGEN_CONSOLE_API_BASE_URL=https://console.example.com
OCTOGEN_RUNNER_SHARED_SECRET=...
OCTOGEN_RUNNER_VM_ID=...
OCTOGEN_RUNNER_INSTANCE_ID=...
OCTOGEN_HERMES_RUNNER_ID=...
```

`OCTOGEN_CONSOLE_API_BASE_URL` is populated when the console bootstrap asset base URL is known.
For manually attached VMs, set it to the deployed Octogen Console origin.

## Request Signing

Every runner request must include:

```http
x-octogen-vm-id: <vm id>
x-octogen-runner-timestamp: <unix seconds>
x-octogen-runner-signature: sha256=<hex hmac>
```

The signature payload is:

```text
METHOD\nPATHNAME\nVM_ID\nTIMESTAMP\nSHA256_HEX_BODY
```

The HMAC key is `OCTOGEN_RUNNER_SHARED_SECRET`. Signatures are valid for five minutes.

## Claim Action

```http
POST /api/octogen/runner/hermes/actions/claim
```

Body:

```json
{
  "runnerId": "vm-runner-01",
  "capabilities": ["tasks", "logs", "activities", "skills", "channels"]
}
```

When an action exists, the response includes `action` and `agent`. When no work exists, `action` is `null` and `retryAfterSeconds` tells the runner when to poll again.

## Report Action

```http
POST /api/octogen/runner/hermes/actions/report
```

Body:

```json
{
  "actionId": "...",
  "runnerId": "vm-runner-01",
  "status": "succeeded",
  "runtimeStatus": "runtime_ready",
  "runtimeAgentId": "hermes-agent-local-id",
  "hermesVersion": "...",
  "runnerVersion": "...",
  "resultPayload": {
    "profilePath": "/var/lib/hermes/profiles/..."
  },
  "observedPayload": {
    "notes": "Hermes runtime profile created"
  }
}
```

Allowed `status` values are `running`, `succeeded`, and `failed`.
Allowed `runtimeStatus` values are `unknown`, `pending`, `provisioning`, `runtime_ready`, `needs_provider`, `needs_channel`, `ready`, `degraded`, `error`, and `offline`.

## Agent Status Mapping

- `running` reports keep the agent in `provisioning`.
- `succeeded` with `runtime_ready` moves the agent to `runtime_ready` and onboarding to `provider`.
- `succeeded` with `needs_provider` moves the agent to `needs_provider`.
- `succeeded` with `needs_channel` moves the agent to `needs_channel`.
- `succeeded` with `ready` moves the agent to `ready`.
- `failed` or `runtimeStatus=error` moves the agent to `error` and stores `last_error`.
