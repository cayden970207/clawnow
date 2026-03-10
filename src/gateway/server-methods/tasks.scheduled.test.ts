import { describe, expect, it } from "vitest";
// Test the exported handler by importing the module and exercising
// the helper functions indirectly through the handler.
// We cannot easily import private helpers, so we test them through
// the handler's output by constructing a minimal mock context.
import type { CronJob } from "../../cron/types.js";
import { tasksHandlers } from "./tasks.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function makeCronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "cron-1",
    name: "Daily check",
    enabled: true,
    createdAtMs: 1000,
    updatedAtMs: 2000,
    schedule: { kind: "every", everyMs: 3_600_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello world" },
    state: {},
    ...overrides,
  };
}

function makeContext(jobs: CronJob[], tasksFeatureEnabled = true) {
  return {
    tasksFeatureEnabled,
    cron: {
      list: async () => jobs,
    },
    logGateway: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  } as unknown as GatewayRequestHandlerOptions["context"];
}

function callHandler(
  context: GatewayRequestHandlerOptions["context"],
  params: Record<string, unknown> = {},
): Promise<{ ok: boolean; payload?: unknown; error?: unknown }> {
  return new Promise((resolve) => {
    const handler = tasksHandlers["tasks.scheduled"];
    if (!handler) {
      throw new Error("tasks.scheduled handler not found");
    }
    void handler({
      req: { type: "req" as const, id: "1", method: "tasks.scheduled", params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => resolve({ ok, payload, error }),
      context,
    });
  });
}

describe("tasks.scheduled handler", () => {
  it("returns error when tasks feature is disabled", async () => {
    const ctx = makeContext([], false);
    const result = await callHandler(ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns empty items when no cron jobs exist", async () => {
    const ctx = makeContext([]);
    const result = await callHandler(ctx);
    expect(result.ok).toBe(true);
    expect((result.payload as { items: unknown[] }).items).toEqual([]);
  });

  it("returns scheduled items with correct shape", async () => {
    const job = makeCronJob({
      id: "abc",
      name: "Test job",
      description: "My description",
      schedule: { kind: "every", everyMs: 60_000 },
      state: { lastRunStatus: "ok", lastDurationMs: 123 },
    });
    const ctx = makeContext([job]);
    const result = await callHandler(ctx);
    expect(result.ok).toBe(true);
    const items = (result.payload as { items: unknown[] }).items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.cronId).toBe("abc");
    expect(item.label).toBe("My description");
    expect(item.schedule).toBe("every 1m");
    expect(typeof item.nextRunAt).toBe("number");
    expect(item.lastStatus).toBe("done");
    expect(item.lastDurationMs).toBe(123);
    expect(item.streak).toEqual({ success: 1, total: 1 });
  });

  it("sorts by nextRunAt ascending", async () => {
    const now = Date.now();
    const jobSoon = makeCronJob({
      id: "soon",
      name: "Soon",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 30_000 },
    });
    const jobLater = makeCronJob({
      id: "later",
      name: "Later",
      schedule: { kind: "every", everyMs: 3_600_000, anchorMs: now - 1_800_000 },
    });
    const ctx = makeContext([jobLater, jobSoon]);
    const result = await callHandler(ctx);
    const items = (result.payload as { items: Array<{ cronId: string }> }).items;
    expect(items[0].cronId).toBe("soon");
    expect(items[1].cronId).toBe("later");
  });

  it("maps error status to failed", async () => {
    const job = makeCronJob({
      state: { lastRunStatus: "error", consecutiveErrors: 3 },
    });
    const ctx = makeContext([job]);
    const result = await callHandler(ctx);
    const items = (result.payload as { items: Array<Record<string, unknown>> }).items;
    expect(items[0].lastStatus).toBe("failed");
    expect(items[0].streak).toEqual({ success: 0, total: 1 });
  });

  it("truncates long labels to 60 chars", async () => {
    const longName = "A".repeat(80);
    const job = makeCronJob({ description: longName });
    const ctx = makeContext([job]);
    const result = await callHandler(ctx);
    const items = (result.payload as { items: Array<{ label: string }> }).items;
    expect(items[0].label.length).toBeLessThanOrEqual(60);
    expect(items[0].label.endsWith("...")).toBe(true);
  });

  it("describes every schedule in hours", async () => {
    const job = makeCronJob({
      schedule: { kind: "every", everyMs: 7_200_000 },
    });
    const ctx = makeContext([job]);
    const result = await callHandler(ctx);
    const items = (result.payload as { items: Array<{ schedule: string }> }).items;
    expect(items[0].schedule).toBe("every 2h");
  });
});
