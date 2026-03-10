import { computeNextRunAtMs } from "../../cron/schedule.js";
import type { CronJob, CronRunStatus } from "../../cron/types.js";
import {
  ErrorCodes,
  errorShape,
  validateTasksGetParams,
  validateTasksListParams,
  validateTasksScheduledParams,
} from "../protocol/index.js";
import { extractErrorReason, extractSteps, toSimplifiedStatus } from "../task-traces.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/** Build a human-readable description of a cron schedule. */
function describeSchedule(job: CronJob): string {
  const s = job.schedule;
  if (s.kind === "at") {
    return `once at ${s.at}`;
  }
  if (s.kind === "every") {
    const ms = s.everyMs;
    if (ms >= 86_400_000 && ms % 86_400_000 === 0) {
      return `every ${ms / 86_400_000}d`;
    }
    if (ms >= 3_600_000 && ms % 3_600_000 === 0) {
      return `every ${ms / 3_600_000}h`;
    }
    if (ms >= 60_000 && ms % 60_000 === 0) {
      return `every ${ms / 60_000}m`;
    }
    return `every ${ms}ms`;
  }
  return (s as { expr?: string }).expr ?? "cron";
}

/** Map CronRunStatus to the simplified task status palette. */
function cronStatusToSimplified(status: CronRunStatus | undefined): "done" | "failed" | undefined {
  if (!status) {
    return undefined;
  }
  if (status === "ok") {
    return "done";
  }
  if (status === "error") {
    return "failed";
  }
  return undefined; // "skipped" has no direct mapping
}

/** Extract a short label from a cron job. */
function jobLabel(job: CronJob): string {
  const text =
    job.description ??
    job.name ??
    (job.payload.kind === "agentTurn" ? job.payload.message : job.payload.text) ??
    "";
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

export const tasksHandlers: GatewayRequestHandlers = {
  "tasks.list": async ({ params, respond, context }) => {
    if (!context.tasksFeatureEnabled) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "tasks feature disabled by gateway.controlUi.features.tasks",
        ),
      );
      return;
    }
    if (!assertValidParams(params, validateTasksListParams, "tasks.list", respond)) {
      return;
    }

    try {
      const result = await context.taskTraces.list(params);
      const simplifiedItems = result.items.map((item) => ({
        runId: item.runId,
        source: item.source,
        status: toSimplifiedStatus(item.status),
        title: item.title,
        preview: item.preview,
        startedAt: item.startedAt,
        endedAt: item.endedAt,
        durationMs: item.durationMs,
        updatedAt: item.updatedAt,
        errorReason:
          item.status === "error" || item.status === "aborted" || item.status === "timeout"
            ? item.preview
            : undefined,
      }));
      respond(true, { ...result, items: simplifiedItems }, undefined);
    } catch (err) {
      context.logGateway.warn(`tasks.list failed: ${String(err)}`);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `tasks.list failed: ${String(err)}`),
      );
    }
  },
  "tasks.get": async ({ params, respond, context }) => {
    if (!context.tasksFeatureEnabled) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "tasks feature disabled by gateway.controlUi.features.tasks",
        ),
      );
      return;
    }
    if (!assertValidParams(params, validateTasksGetParams, "tasks.get", respond)) {
      return;
    }

    try {
      const result = await context.taskTraces.get(params);
      if (!result) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `task run not found: ${params.runId}`),
        );
        return;
      }
      const run = result.run;
      const simplifiedRun = {
        runId: run.runId,
        source: run.source,
        status: toSimplifiedStatus(run.status),
        title: run.title,
        preview: run.preview,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        durationMs: run.durationMs,
        updatedAt: run.updatedAt,
        summary: run.nodes.find((n) => n.type === "assistant")?.summary ?? run.preview,
        steps: extractSteps(run.nodes),
        errorReason: extractErrorReason(run.nodes),
      };
      respond(true, { run: simplifiedRun }, undefined);
    } catch (err) {
      context.logGateway.warn(`tasks.get failed: ${String(err)}`);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `tasks.get failed: ${String(err)}`),
      );
    }
  },
  "tasks.scheduled": async ({ params, respond, context }) => {
    if (!context.tasksFeatureEnabled) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "tasks feature disabled by gateway.controlUi.features.tasks",
        ),
      );
      return;
    }
    if (!assertValidParams(params, validateTasksScheduledParams, "tasks.scheduled", respond)) {
      return;
    }

    try {
      const jobs = await context.cron.list({ includeDisabled: false });
      const nowMs = Date.now();
      const items = jobs
        .map((job) => {
          const nextRunAt = computeNextRunAtMs(job.schedule, nowMs);
          const state = job.state;
          // Derive streak from consecutiveErrors: if 0 or absent, last run was a success.
          const consecutiveErrors = state.consecutiveErrors ?? 0;
          const lastRunStatus = state.lastRunStatus ?? state.lastStatus;
          return {
            cronId: job.id,
            label: jobLabel(job),
            schedule: describeSchedule(job),
            nextRunAt,
            lastStatus: cronStatusToSimplified(lastRunStatus),
            lastDurationMs: state.lastDurationMs,
            streak: {
              success: consecutiveErrors === 0 && lastRunStatus === "ok" ? 1 : 0,
              total: lastRunStatus ? 1 : 0,
            },
          };
        })
        .toSorted(
          (a, b) =>
            (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER),
        );

      respond(true, { items }, undefined);
    } catch (err) {
      context.logGateway.warn(`tasks.scheduled failed: ${String(err)}`);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `tasks.scheduled failed: ${String(err)}`),
      );
    }
  },
};
