#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_ENV_FILES = ["/etc/octogen-runner.env"];
const DEFAULT_CAPABILITIES = ["tasks", "logs", "activities", "skills", "channels"];
const CLAIM_PATH = "/api/octogen/runner/hermes/actions/claim";
const REPORT_PATH = "/api/octogen/runner/hermes/actions/report";

function log(level, message, details = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    component: "octogen-hermes-runner",
    message,
    ...details,
  };
  const line = JSON.stringify(payload);
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseList(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) {
    return fallback;
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : fallback;
}

function loadDotEnv(dotenvPath) {
  if (!fs.existsSync(dotenvPath)) {
    return;
  }
  const content = fs.readFileSync(dotenvPath, "utf8");
  for (const lineRaw of content.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key]) {
      continue;
    }
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadEnvFiles() {
  const extra = String(process.env.OCTOGEN_RUNNER_ENV_FILE || "").trim();
  const files = extra ? [extra, ...DEFAULT_ENV_FILES] : DEFAULT_ENV_FILES;
  for (const file of files) {
    loadDotEnv(file);
  }
}

function readConfig() {
  loadEnvFiles();
  const mode = String(process.env.OCTOGEN_HERMES_RUNNER_MODE || "auto")
    .trim()
    .toLowerCase();
  return {
    enabled: parseBoolean(process.env.OCTOGEN_HERMES_RUNNER_ENABLED, true),
    consoleApiBaseUrl: String(process.env.OCTOGEN_CONSOLE_API_BASE_URL || "").trim(),
    sharedSecret: String(process.env.OCTOGEN_RUNNER_SHARED_SECRET || "").trim(),
    vmId: String(
      process.env.OCTOGEN_RUNNER_VM_ID ||
        process.env.OCTOGEN_VM_ID ||
        process.env.OCTOGEN_RUNNER_INSTANCE_ID ||
        process.env.OCTOGEN_INSTANCE_ID ||
        "",
    ).trim(),
    runnerId: String(process.env.OCTOGEN_HERMES_RUNNER_ID || os.hostname()).trim(),
    mode: ["auto", "command", "probe", "simulate", "disabled"].includes(mode) ? mode : "auto",
    capabilities: parseList(process.env.OCTOGEN_HERMES_RUNNER_CAPABILITIES, DEFAULT_CAPABILITIES),
    pollSeconds: parsePositiveInt(process.env.OCTOGEN_HERMES_RUNNER_POLL_SECONDS, 10),
    errorBackoffSeconds: parsePositiveInt(
      process.env.OCTOGEN_HERMES_RUNNER_ERROR_BACKOFF_SECONDS,
      30,
    ),
    requestTimeoutMs: parsePositiveInt(process.env.OCTOGEN_HERMES_RUNNER_REQUEST_TIMEOUT_MS, 15000),
    actionTimeoutMs: parsePositiveInt(
      process.env.OCTOGEN_HERMES_RUNNER_ACTION_TIMEOUT_MS,
      10 * 60 * 1000,
    ),
    provisionCommand: String(process.env.OCTOGEN_HERMES_PROVISION_COMMAND || "").trim(),
    readyFile: String(
      process.env.OCTOGEN_HERMES_READY_FILE || "/var/lib/hermes/.octogen-ready",
    ).trim(),
    successRuntimeStatus: String(
      process.env.OCTOGEN_HERMES_SUCCESS_RUNTIME_STATUS || "runtime_ready",
    ).trim(),
  };
}

function validateConfig(config) {
  if (!config.enabled || config.mode === "disabled") {
    return "disabled";
  }
  if (!config.consoleApiBaseUrl) {
    return "missing OCTOGEN_CONSOLE_API_BASE_URL";
  }
  if (!config.sharedSecret) {
    return "missing OCTOGEN_RUNNER_SHARED_SECRET";
  }
  if (!config.vmId) {
    return "missing OCTOGEN_RUNNER_VM_ID";
  }
  return null;
}

function bodyHash(bodyText) {
  return createHash("sha256").update(bodyText).digest("hex");
}

function signRequest(config, method, pathname, bodyText, timestamp) {
  const payload = [
    method.toUpperCase(),
    pathname,
    config.vmId,
    String(timestamp),
    bodyHash(bodyText),
  ].join("\n");
  return createHmac("sha256", config.sharedSecret).update(payload).digest("hex");
}

async function requestJson(config, method, requestPath, body) {
  const url = new URL(requestPath, config.consoleApiBaseUrl);
  const bodyText = JSON.stringify(body || {});
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signRequest(config, method, url.pathname, bodyText, timestamp);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const requestOptions = {
    method,
    headers: {
      "content-type": "application/json",
      "x-octogen-vm-id": config.vmId,
      "x-octogen-runner-timestamp": String(timestamp),
      "x-octogen-runner-signature": `sha256=${signature}`,
    },
    signal: controller.signal,
  };
  if (method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") {
    requestOptions.body = bodyText;
  }
  try {
    const response = await fetch(url, requestOptions);
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.success === false) {
      const message = typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
      const code = typeof json.errorCode === "string" ? json.errorCode : "REQUEST_FAILED";
      throw new Error(`${code}: ${message}`);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function commandExists(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${shellQuote(command)}`], {
    encoding: "utf8",
    timeout: 5000,
  });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] || null : null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function parseJsonFromOutput(output) {
  const lines = String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.toReversed()) {
    if (!line.startsWith("{") || !line.endsWith("}")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      // Keep scanning earlier lines.
    }
  }
  return null;
}

function writeActionFile(action, agent) {
  const dir = "/var/lib/octogen/hermes-runner";
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${action.id}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ action, agent }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function runProvisionCommand(config, action, agent) {
  const actionFile = writeActionFile(action, agent);
  const env = {
    ...process.env,
    OCTOGEN_ACTION_ID: action.id,
    OCTOGEN_ACTION_TYPE: action.action_type,
    OCTOGEN_ACTION_FILE: actionFile,
    OCTOGEN_AGENT_ID: agent.id,
    OCTOGEN_AGENT_NAME: agent.name,
    OCTOGEN_HERMES_PROFILE_ID: agent.hermes_profile_id || "",
    OCTOGEN_RUNTIME_AGENT_ID: agent.runtime_agent_id || "",
  };
  const result = spawnSync("bash", ["-lc", config.provisionCommand], {
    env,
    encoding: "utf8",
    timeout: config.actionTimeoutMs,
    maxBuffer: 1024 * 1024,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const parsed = parseJsonFromOutput(stdout) || parseJsonFromOutput(stderr) || {};
  if (result.error) {
    return {
      ok: false,
      error: result.error.message,
      stdout,
      stderr,
      parsed,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: `Hermes provision command exited with ${result.status}`,
      stdout,
      stderr,
      parsed,
    };
  }
  return {
    ok: true,
    stdout,
    stderr,
    parsed,
  };
}

function probeHermes(config) {
  if (config.readyFile && fs.existsSync(config.readyFile)) {
    return {
      ok: true,
      runtimeStatus: config.successRuntimeStatus,
      observedPayload: {
        probe: "ready_file",
        readyFile: config.readyFile,
      },
    };
  }

  const hermesBin = commandExists("hermes") || commandExists("hermes-agent");
  if (!hermesBin) {
    return {
      ok: false,
      error:
        "No Hermes provision command configured and no hermes/hermes-agent binary or ready marker was found.",
      observedPayload: {
        probe: "missing_executor",
        readyFile: config.readyFile,
      },
    };
  }

  const version = spawnSync(hermesBin, ["--version"], {
    encoding: "utf8",
    timeout: 8000,
    maxBuffer: 128 * 1024,
  });
  const versionText = `${version.stdout || ""}${version.stderr || ""}`.trim().slice(0, 200);
  return {
    ok: true,
    runtimeStatus: config.successRuntimeStatus,
    hermesVersion: versionText || null,
    observedPayload: {
      probe: "binary",
      binary: hermesBin,
      version: versionText || null,
      note: "Hermes binary observed. Configure OCTOGEN_HERMES_PROVISION_COMMAND for custom provisioning.",
    },
  };
}

function normalizeRuntimeStatus(value, fallback) {
  const allowed = new Set([
    "unknown",
    "pending",
    "provisioning",
    "runtime_ready",
    "needs_provider",
    "needs_channel",
    "ready",
    "degraded",
    "error",
    "offline",
  ]);
  return allowed.has(value) ? value : fallback;
}

async function report(config, actionId, payload) {
  return await requestJson(config, "POST", REPORT_PATH, {
    actionId,
    runnerId: config.runnerId,
    ...payload,
  });
}

async function executeAction(config, claim) {
  const { action, agent } = claim;
  if (!action || !agent) {
    return;
  }

  await report(config, action.id, {
    status: "running",
    runtimeStatus: "provisioning",
    observedPayload: {
      runner_mode: config.mode,
      started_at: new Date().toISOString(),
    },
  });

  if (action.action_type !== "provision_runtime") {
    await report(config, action.id, {
      status: "failed",
      runtimeStatus: "error",
      lastError: `Unsupported action type: ${action.action_type}`,
      observedPayload: {
        runner_mode: config.mode,
      },
    });
    return;
  }

  if (config.mode === "simulate") {
    await report(config, action.id, {
      status: "succeeded",
      runtimeStatus: normalizeRuntimeStatus(config.successRuntimeStatus, "runtime_ready"),
      runtimeAgentId: agent.runtime_agent_id || agent.hermes_profile_id || agent.id,
      runnerVersion: "octogen-hermes-runner-simulated",
      resultPayload: {
        simulated: true,
      },
      observedPayload: {
        runner_mode: "simulate",
        note: "Simulation mode is enabled; no local Hermes command was executed.",
      },
    });
    return;
  }

  if (config.provisionCommand) {
    const result = runProvisionCommand(config, action, agent);
    const parsed = result.parsed || {};
    if (!result.ok) {
      await report(config, action.id, {
        status: "failed",
        runtimeStatus: "error",
        lastError: result.error,
        resultPayload: {
          stdout: result.stdout.slice(-8000),
          stderr: result.stderr.slice(-8000),
          parsed,
        },
        observedPayload: {
          runner_mode: config.mode,
          command_configured: true,
        },
      });
      return;
    }

    await report(config, action.id, {
      status: "succeeded",
      runtimeStatus: normalizeRuntimeStatus(parsed.runtimeStatus, config.successRuntimeStatus),
      runtimeAgentId:
        typeof parsed.runtimeAgentId === "string" && parsed.runtimeAgentId.trim()
          ? parsed.runtimeAgentId.trim()
          : agent.runtime_agent_id || agent.hermes_profile_id || agent.id,
      hermesVersion:
        typeof parsed.hermesVersion === "string" && parsed.hermesVersion.trim()
          ? parsed.hermesVersion.trim()
          : undefined,
      runnerVersion: "octogen-hermes-runner-command",
      resultPayload: {
        stdout: result.stdout.slice(-8000),
        stderr: result.stderr.slice(-8000),
        parsed,
      },
      observedPayload: {
        runner_mode: config.mode,
        command_configured: true,
      },
    });
    return;
  }

  if (config.mode === "command") {
    await report(config, action.id, {
      status: "failed",
      runtimeStatus: "error",
      lastError: "OCTOGEN_HERMES_PROVISION_COMMAND is required when runner mode is command.",
      observedPayload: {
        runner_mode: config.mode,
      },
    });
    return;
  }

  const probe = probeHermes(config);
  if (!probe.ok) {
    await report(config, action.id, {
      status: "failed",
      runtimeStatus: "error",
      lastError: probe.error,
      observedPayload: {
        runner_mode: config.mode,
        ...probe.observedPayload,
      },
    });
    return;
  }

  await report(config, action.id, {
    status: "succeeded",
    runtimeStatus: normalizeRuntimeStatus(probe.runtimeStatus, config.successRuntimeStatus),
    runtimeAgentId: agent.runtime_agent_id || agent.hermes_profile_id || agent.id,
    hermesVersion: probe.hermesVersion || undefined,
    runnerVersion: "octogen-hermes-runner-probe",
    resultPayload: {
      probed: true,
    },
    observedPayload: {
      runner_mode: config.mode,
      ...probe.observedPayload,
    },
  });
}

async function runLoop() {
  while (true) {
    const config = readConfig();
    const configProblem = validateConfig(config);
    if (configProblem) {
      log(configProblem === "disabled" ? "info" : "warn", "runner not ready", {
        reason: configProblem,
      });
      await sleep(config.errorBackoffSeconds * 1000);
      continue;
    }

    try {
      const claim = await requestJson(config, "POST", CLAIM_PATH, {
        runnerId: config.runnerId,
        capabilities: config.capabilities,
      });

      if (!claim.action) {
        await sleep((claim.retryAfterSeconds || config.pollSeconds) * 1000);
        continue;
      }

      log("info", "claimed Hermes runtime action", {
        actionId: claim.action.id,
        actionType: claim.action.action_type,
        agentId: claim.agent?.id || null,
      });
      await executeAction(config, claim);
    } catch (error) {
      log("error", "runner loop failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(config.errorBackoffSeconds * 1000);
    }
  }
}

runLoop().catch((error) => {
  log("error", "fatal runner error", {
    error: error instanceof Error ? error.stack || error.message : String(error),
  });
  process.exit(1);
});
