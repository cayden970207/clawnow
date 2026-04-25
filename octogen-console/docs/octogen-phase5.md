# Octogen Phase 5: VM-side Hermes Runner

Phase 5 installs a real VM-side process: `octogen-hermes-runner.mjs`.

The runner polls Octogen Console for queued Hermes runtime actions, executes a local provision/probe step, and reports status back through the Phase 4 runner APIs.

## Installed Files

Bootstrap installs:

```text
/opt/octogen/octogen-hermes-runner.mjs
/etc/octogen-runner.env
/etc/systemd/system/octogen-hermes-runner.service
/var/log/octogen-hermes-runner.log
```

The service starts automatically:

```sh
systemctl status octogen-hermes-runner.service
journalctl -u octogen-hermes-runner.service -n 120 --no-pager
```

## Environment

`/etc/octogen-runner.env` contains the core auth/runtime settings:

```sh
OCTOGEN_CONSOLE_API_BASE_URL=https://console.example.com
OCTOGEN_RUNNER_SHARED_SECRET=...
OCTOGEN_RUNNER_VM_ID=...
OCTOGEN_HERMES_RUNNER_ID=...
OCTOGEN_HERMES_RUNNER_MODE=auto
OCTOGEN_HERMES_RUNNER_POLL_SECONDS=10
OCTOGEN_HERMES_SUCCESS_RUNTIME_STATUS=runtime_ready
```

## Runner Modes

`OCTOGEN_HERMES_RUNNER_MODE=auto` is the default.

- `auto`: run `OCTOGEN_HERMES_PROVISION_COMMAND` when set; otherwise probe for a ready marker or `hermes` / `hermes-agent` binary.
- `command`: require `OCTOGEN_HERMES_PROVISION_COMMAND`; fail the action if it is missing.
- `probe`: do not run a provision command; only check the ready marker or Hermes binary.
- `simulate`: report success without executing Hermes; use only for end-to-end staging tests.
- `disabled`: keep the service alive but do not claim actions.

## Custom Provision Command

Set `OCTOGEN_HERMES_PROVISION_COMMAND` to integrate your actual Hermes runtime install/provision flow.

The runner executes it through `bash -lc` and exposes:

```sh
OCTOGEN_ACTION_ID
OCTOGEN_ACTION_TYPE
OCTOGEN_ACTION_FILE
OCTOGEN_AGENT_ID
OCTOGEN_AGENT_NAME
OCTOGEN_HERMES_PROFILE_ID
OCTOGEN_RUNTIME_AGENT_ID
```

`OCTOGEN_ACTION_FILE` is a JSON file containing the claimed action and agent payload.

The command can print a JSON object on its last line to override report details:

```json
{
  "runtimeStatus": "runtime_ready",
  "runtimeAgentId": "local-hermes-agent-id",
  "hermesVersion": "1.2.3"
}
```

If the command exits with `0`, the runner reports `succeeded`. Non-zero exits report `failed` with stdout/stderr snippets.

## Probe Mode

Without a custom command, `auto`/`probe` checks:

1. `OCTOGEN_HERMES_READY_FILE`, default `/var/lib/hermes/.octogen-ready`
2. `command -v hermes`
3. `command -v hermes-agent`

If either marker or binary exists, the runner reports `runtime_ready` by default. If none exists, it reports `failed` so the Console can show a real runtime issue instead of pretending the VM is ready.
