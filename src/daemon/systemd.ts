import fs from "node:fs/promises";
import path from "node:path";
import {
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  resolveGatewayServiceDescription,
  resolveGatewaySystemdServiceName,
} from "./constants.js";
import { execFileUtf8 } from "./exec-file.js";
import { formatLine, toPosixPath, writeFormattedLines } from "./output.js";
import { resolveHomeDir } from "./paths.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
} from "./service-types.js";
import {
  enableSystemdUserLinger,
  readSystemdUserLingerStatus,
  type SystemdUserLingerStatus,
} from "./systemd-linger.js";
import {
  buildSystemdUnit,
  parseSystemdEnvAssignment,
  parseSystemdExecStart,
} from "./systemd-unit.js";

type SystemdScope = "user" | "system";

type ResolvedSystemdService = {
  scope: SystemdScope;
  unitName: string;
  unitPath: string;
};

const SYSTEMD_SYSTEM_UNIT_DIRS = [
  "/etc/systemd/system",
  "/usr/lib/systemd/system",
  "/lib/systemd/system",
  "/run/systemd/system",
] as const;

function resolveSystemdUnitPathForName(env: GatewayServiceEnv, name: string): string {
  const home = toPosixPath(resolveHomeDir(env));
  return path.posix.join(home, ".config", "systemd", "user", `${name}.service`);
}

function resolveSystemdServiceName(env: GatewayServiceEnv): string {
  const override = env.OPENCLAW_SYSTEMD_UNIT?.trim();
  if (override) {
    return override.endsWith(".service") ? override.slice(0, -".service".length) : override;
  }
  return resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
}

function resolveSystemdUnitPath(env: GatewayServiceEnv): string {
  return resolveSystemdUnitPathForName(env, resolveSystemdServiceName(env));
}

export function resolveSystemdUserUnitPath(env: GatewayServiceEnv): string {
  return resolveSystemdUnitPath(env);
}

export { enableSystemdUserLinger, readSystemdUserLingerStatus };
export type { SystemdUserLingerStatus };

// Unit file parsing/rendering: see systemd-unit.ts

export async function readSystemdServiceExecStart(
  env: GatewayServiceEnv,
): Promise<GatewayServiceCommandConfig | null> {
  const target = await resolveSystemdServiceTarget(env);
  if (!target) {
    return null;
  }
  const { unitPath } = target;
  try {
    const content = await fs.readFile(unitPath, "utf8");
    let execStart = "";
    let workingDirectory = "";
    const environment: Record<string, string> = {};
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      if (line.startsWith("ExecStart=")) {
        execStart = line.slice("ExecStart=".length).trim();
      } else if (line.startsWith("WorkingDirectory=")) {
        workingDirectory = line.slice("WorkingDirectory=".length).trim();
      } else if (line.startsWith("Environment=")) {
        const raw = line.slice("Environment=".length).trim();
        const parsed = parseSystemdEnvAssignment(raw);
        if (parsed) {
          environment[parsed.key] = parsed.value;
        }
      }
    }
    if (!execStart) {
      return null;
    }
    const programArguments = parseSystemdExecStart(execStart);
    return {
      programArguments,
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
      sourcePath: unitPath,
    };
  } catch {
    return null;
  }
}

export type SystemdServiceInfo = {
  activeState?: string;
  subState?: string;
  mainPid?: number;
  execMainStatus?: number;
  execMainCode?: string;
};

export function parseSystemdShow(output: string): SystemdServiceInfo {
  const entries = parseKeyValueOutput(output, "=");
  const info: SystemdServiceInfo = {};
  const activeState = entries.activestate;
  if (activeState) {
    info.activeState = activeState;
  }
  const subState = entries.substate;
  if (subState) {
    info.subState = subState;
  }
  const mainPidValue = entries.mainpid;
  if (mainPidValue) {
    const pid = Number.parseInt(mainPidValue, 10);
    if (Number.isFinite(pid) && pid > 0) {
      info.mainPid = pid;
    }
  }
  const execMainStatusValue = entries.execmainstatus;
  if (execMainStatusValue) {
    const status = Number.parseInt(execMainStatusValue, 10);
    if (Number.isFinite(status)) {
      info.execMainStatus = status;
    }
  }
  const execMainCode = entries.execmaincode;
  if (execMainCode) {
    info.execMainCode = execMainCode;
  }
  return info;
}

async function execSystemctl(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await execFileUtf8("systemctl", args);
}

function toSystemctlUnavailableDetail(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("not found") ||
    normalized.includes("failed to connect") ||
    normalized.includes("not been booted") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("not supported")
  );
}

function resolveSystemctlArgs(scope: SystemdScope, args: string[]): string[] {
  if (scope === "user") {
    return ["--user", ...args];
  }
  return args;
}

async function isSystemctlScopeAvailable(scope: SystemdScope): Promise<boolean> {
  const res = await execSystemctl(resolveSystemctlArgs(scope, ["status"]));
  if (res.code === 0) {
    return true;
  }
  const detail = `${res.stderr} ${res.stdout}`.toLowerCase();
  return !toSystemctlUnavailableDetail(detail);
}

async function isFileAccessible(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveSystemdSystemUnitPaths(serviceName: string): string[] {
  return SYSTEMD_SYSTEM_UNIT_DIRS.map((unitDir) =>
    path.posix.join(unitDir, `${serviceName}.service`),
  );
}

async function resolveSystemdServiceTarget(
  env: GatewayServiceEnv,
): Promise<ResolvedSystemdService | null> {
  const serviceName = resolveSystemdServiceName(env);
  const unitName = `${serviceName}.service`;
  const userPath = resolveSystemdUnitPathForName(env, serviceName);
  if (await isFileAccessible(userPath)) {
    return { scope: "user", unitName, unitPath: userPath };
  }

  for (const systemPath of resolveSystemdSystemUnitPaths(serviceName)) {
    if (await isFileAccessible(systemPath)) {
      return { scope: "system", unitName, unitPath: systemPath };
    }
  }

  if (await isSystemctlScopeAvailable("user")) {
    return { scope: "user", unitName, unitPath: userPath };
  }

  if (await isSystemctlScopeAvailable("system")) {
    return { scope: "system", unitName, unitPath: resolveSystemdSystemUnitPaths(serviceName)[0] };
  }

  return null;
}

async function assertSystemdAvailable(scope: SystemdScope) {
  const res = await execSystemctl(resolveSystemctlArgs(scope, ["status"]));
  if (res.code === 0) {
    return;
  }
  const detail = (res.stderr || res.stdout).trim();
  if (scope === "user" && toSystemctlUnavailableDetail(detail.toLowerCase())) {
    throw new Error("systemctl not available; systemd user services are required on Linux.");
  }
  if (scope === "system" && toSystemctlUnavailableDetail(detail.toLowerCase())) {
    throw new Error(`systemctl unavailable: ${detail || "unknown error"}`.trim());
  }
  if (scope === "user") {
    throw new Error(`systemctl --user unavailable: ${detail || "unknown error"}`.trim());
  }
  throw new Error(`systemctl unavailable: ${detail || "unknown error"}`.trim());
}

export async function isSystemdUserServiceAvailable(): Promise<boolean> {
  const res = await execSystemctl(["--user", "status"]);
  if (res.code === 0) {
    return true;
  }
  const detail = `${res.stderr} ${res.stdout}`.toLowerCase();
  if (!detail) {
    return false;
  }
  if (detail.includes("not found")) {
    return false;
  }
  if (detail.includes("failed to connect")) {
    return false;
  }
  if (detail.includes("not been booted")) {
    return false;
  }
  if (detail.includes("no such file or directory")) {
    return false;
  }
  if (detail.includes("not supported")) {
    return false;
  }
  return false;
}

export async function installSystemdService({
  env,
  stdout,
  programArguments,
  workingDirectory,
  environment,
  description,
}: GatewayServiceInstallArgs): Promise<{ unitPath: string }> {
  await assertSystemdAvailable("user");

  const unitPath = resolveSystemdUnitPath(env);
  await fs.mkdir(path.dirname(unitPath), { recursive: true });

  // Preserve user customizations: back up existing unit file before overwriting.
  let backedUp = false;
  try {
    await fs.access(unitPath);
    const backupPath = `${unitPath}.bak`;
    await fs.copyFile(unitPath, backupPath);
    backedUp = true;
  } catch {
    // File does not exist yet — nothing to back up.
  }

  const serviceDescription = resolveGatewayServiceDescription({ env, environment, description });
  const unit = buildSystemdUnit({
    description: serviceDescription,
    programArguments,
    workingDirectory,
    environment,
  });
  await fs.writeFile(unitPath, unit, "utf8");

  const serviceName = resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
  const unitName = `${serviceName}.service`;
  const reload = await execSystemctl(["--user", "daemon-reload"]);
  if (reload.code !== 0) {
    throw new Error(`systemctl daemon-reload failed: ${reload.stderr || reload.stdout}`.trim());
  }

  const enable = await execSystemctl(["--user", "enable", unitName]);
  if (enable.code !== 0) {
    throw new Error(`systemctl enable failed: ${enable.stderr || enable.stdout}`.trim());
  }

  const restart = await execSystemctl(["--user", "restart", unitName]);
  if (restart.code !== 0) {
    throw new Error(`systemctl restart failed: ${restart.stderr || restart.stdout}`.trim());
  }

  // Ensure we don't end up writing to a clack spinner line (wizards show progress without a newline).
  writeFormattedLines(
    stdout,
    [
      {
        label: "Installed systemd service",
        value: unitPath,
      },
      ...(backedUp
        ? [
            {
              label: "Previous unit backed up to",
              value: `${unitPath}.bak`,
            },
          ]
        : []),
    ],
    { leadingBlankLine: true },
  );
  return { unitPath };
}

export async function uninstallSystemdService({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  const target = await resolveSystemdServiceTarget(env);
  if (!target) {
    await assertSystemdAvailable("user");
    stdout.write(`Systemd service for OpenClaw not found.\n`);
    return;
  }
  await assertSystemdAvailable(target.scope);
  await execSystemctl(resolveSystemctlArgs(target.scope, ["disable", "--now", target.unitName]));

  const unitPath = target.unitPath;
  try {
    await fs.unlink(unitPath);
    stdout.write(`${formatLine("Removed systemd service", unitPath)}\n`);
  } catch {
    stdout.write(`Systemd service not found at ${unitPath}\n`);
  }
}

async function runSystemdServiceAction(params: {
  stdout: NodeJS.WritableStream;
  env?: GatewayServiceEnv;
  action: "stop" | "restart";
  label: string;
}) {
  const target = await resolveSystemdServiceTarget(params.env ?? {});
  if (!target) {
    throw new Error(`OpenClaw systemd unit for this profile was not found.`);
  }
  await assertSystemdAvailable(target.scope);
  const res = await execSystemctl(
    resolveSystemctlArgs(target.scope, [params.action, target.unitName]),
  );
  if (res.code !== 0) {
    throw new Error(`systemctl ${params.action} failed: ${res.stderr || res.stdout}`.trim());
  }
  params.stdout.write(`${formatLine(params.label, target.unitName)}\n`);
}

export async function stopSystemdService({
  stdout,
  env,
}: GatewayServiceControlArgs): Promise<void> {
  await runSystemdServiceAction({
    stdout,
    env,
    action: "stop",
    label: "Stopped systemd service",
  });
}

export async function restartSystemdService({
  stdout,
  env,
}: GatewayServiceControlArgs): Promise<void> {
  await runSystemdServiceAction({
    stdout,
    env,
    action: "restart",
    label: "Restarted systemd service",
  });
}

export async function isSystemdServiceEnabled(args: GatewayServiceEnvArgs): Promise<boolean> {
  const target = await resolveSystemdServiceTarget(args.env ?? {});
  if (!target) {
    return false;
  }
  const res = await execSystemctl(
    resolveSystemctlArgs(target.scope, ["is-enabled", target.unitName]),
  );
  return res.code === 0;
}

export async function readSystemdServiceRuntime(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): Promise<GatewayServiceRuntime> {
  try {
    const target = await resolveSystemdServiceTarget(env);
    if (!target) {
      return {
        status: "stopped",
        missingUnit: true,
      };
    }
    const res = await execSystemctl([
      ...resolveSystemctlArgs(target.scope, [
        "show",
        target.unitName,
        "--no-page",
        "--property",
        "ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode",
      ]),
    ]);
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      const missing = detail.toLowerCase().includes("not found");
      return {
        status: missing ? "stopped" : "unknown",
        detail: detail || undefined,
        missingUnit: missing,
      };
    }
    const parsed = parseSystemdShow(res.stdout || "");
    const activeState = parsed.activeState?.toLowerCase();
    const status = activeState === "active" ? "running" : activeState ? "stopped" : "unknown";
    return {
      status,
      state: parsed.activeState,
      subState: parsed.subState,
      pid: parsed.mainPid,
      lastExitStatus: parsed.execMainStatus,
      lastExitReason: parsed.execMainCode,
    };
  } catch (err) {
    return {
      status: "unknown",
      detail: String(err),
    };
  }
}
export type LegacySystemdUnit = {
  name: string;
  unitPath: string;
  enabled: boolean;
  exists: boolean;
};

async function isAnySystemctlAvailable(): Promise<boolean> {
  const userAvailable = await isSystemctlScopeAvailable("user");
  if (userAvailable) {
    return true;
  }
  return isSystemctlScopeAvailable("system");
}

export async function findLegacySystemdUnits(env: GatewayServiceEnv): Promise<LegacySystemdUnit[]> {
  const results: LegacySystemdUnit[] = [];
  const systemctlAvailable = await isAnySystemctlAvailable();
  for (const name of LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
    const unitPath = resolveSystemdUnitPathForName(env, name);
    let exists = false;
    try {
      await fs.access(unitPath);
      exists = true;
    } catch {
      // ignore
    }
    let enabled = false;
    if (systemctlAvailable) {
      const res = await execSystemctl(["--user", "is-enabled", `${name}.service`]);
      enabled = res.code === 0;
    }
    if (exists || enabled) {
      results.push({ name, unitPath, enabled, exists });
    }
  }
  return results;
}

export async function uninstallLegacySystemdUnits({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<LegacySystemdUnit[]> {
  const units = await findLegacySystemdUnits(env);
  if (units.length === 0) {
    return units;
  }

  const systemctlAvailable = await isAnySystemctlAvailable();
  for (const unit of units) {
    if (systemctlAvailable) {
      await execSystemctl(["--user", "disable", "--now", `${unit.name}.service`]);
    } else {
      stdout.write(`systemctl unavailable; removed legacy unit file only: ${unit.name}.service\n`);
    }

    try {
      await fs.unlink(unit.unitPath);
      stdout.write(`${formatLine("Removed legacy systemd service", unit.unitPath)}\n`);
    } catch {
      stdout.write(`Legacy systemd unit not found at ${unit.unitPath}\n`);
    }
  }

  return units;
}
