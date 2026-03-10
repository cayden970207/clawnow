import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TaskTraceStore,
  extractErrorReason,
  extractSteps,
  toSimplifiedStatus,
  type TaskNode,
  type TaskTraceLogger,
} from "./task-traces.js";

function createLogger(): TaskTraceLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

describe("toSimplifiedStatus", () => {
  it("maps all 5 original statuses correctly", () => {
    expect(toSimplifiedStatus("running")).toBe("running");
    expect(toSimplifiedStatus("success")).toBe("done");
    expect(toSimplifiedStatus("error")).toBe("failed");
    expect(toSimplifiedStatus("aborted")).toBe("failed");
    expect(toSimplifiedStatus("timeout")).toBe("failed");
  });
});

describe("extractSteps", () => {
  it("extracts tool and assistant steps from nodes", () => {
    const nodes: TaskNode[] = [
      { id: "n1", type: "trigger", label: "User message", status: "success", startedAt: 1000 },
      {
        id: "n2",
        type: "tool",
        label: "web_search",
        status: "success",
        startedAt: 1001,
        summary: "Found 12 results",
      },
      {
        id: "n3",
        type: "tool",
        label: "browse",
        status: "success",
        startedAt: 1002,
        summary: "Extracted fare data",
      },
      {
        id: "n4",
        type: "assistant",
        label: "reply",
        status: "success",
        startedAt: 1003,
        summary: "Sent flight options",
      },
      { id: "n5", type: "finalize", label: "done", status: "success", startedAt: 1004 },
    ];
    const steps = extractSteps(nodes);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ tool: "web_search", result: "Found 12 results", phase: "result" });
    expect(steps[2]).toEqual({ tool: "reply", result: "Sent flight options", phase: "result" });
  });

  it("marks error steps with error phase", () => {
    const nodes: TaskNode[] = [
      {
        id: "n1",
        type: "tool",
        label: "db_query",
        status: "error",
        startedAt: 1000,
        summary: "Connection timeout",
      },
    ];
    const steps = extractSteps(nodes);
    expect(steps[0].phase).toBe("error");
  });
});

describe("extractErrorReason", () => {
  it("returns summary from first error node", () => {
    const nodes: TaskNode[] = [
      { id: "n1", type: "tool", label: "web_search", status: "success", startedAt: 1000 },
      {
        id: "n2",
        type: "tool",
        label: "db_query",
        status: "error",
        startedAt: 1001,
        summary: "Connection timeout",
      },
    ];
    expect(extractErrorReason(nodes)).toBe("Connection timeout");
  });

  it("returns undefined when no error nodes", () => {
    const nodes: TaskNode[] = [
      { id: "n1", type: "tool", label: "web_search", status: "success", startedAt: 1000 },
    ];
    expect(extractErrorReason(nodes)).toBeUndefined();
  });
});

describe("TaskTraceStore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-task-traces-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("builds a run graph and stores terminal summaries", async () => {
    const store = new TaskTraceStore({
      stateDir: tempDir,
      retentionDays: 180,
      log: createLogger(),
    });
    await store.start();

    const runId = "run-tasks-1";
    const baseTs = Date.now();

    store.ingest({
      runId,
      seq: 1,
      stream: "lifecycle",
      ts: baseTs,
      sessionKey: "agent:main:cron:nightly:run:123",
      data: { phase: "start", startedAt: baseTs },
    });

    store.ingest({
      runId,
      seq: 2,
      stream: "tool",
      ts: baseTs + 10,
      data: {
        phase: "start",
        toolCallId: "tool-1",
        name: "browser.open",
        args: { url: "https://example.com/?token=secret-value" },
      },
    });

    store.ingest({
      runId,
      seq: 3,
      stream: "tool",
      ts: baseTs + 20,
      data: {
        phase: "result",
        toolCallId: "tool-1",
        name: "browser.open",
        isError: false,
        result: { running: true, message: "opened" },
      },
    });

    store.ingest({
      runId,
      seq: 4,
      stream: "assistant",
      ts: baseTs + 30,
      data: {
        text: "Contact +1 (202) 555-0100 and send to 120363273899090274@g.us",
      },
    });

    store.ingest({
      runId,
      seq: 5,
      stream: "lifecycle",
      ts: baseTs + 40,
      data: { phase: "end", endedAt: baseTs + 40 },
    });

    await store.stop();

    const list = await store.list({ source: "cron", status: "success", limit: 10 });
    expect(list.total).toBe(1);
    expect(list.items[0]?.runId).toBe(runId);
    expect(list.items[0]?.source).toBe("cron");
    expect(list.items[0]?.status).toBe("success");

    const detailResult = await store.get({ runId });
    expect(detailResult).not.toBeNull();
    const detail = detailResult?.run;
    expect(detail).toBeTruthy();
    expect(detail?.nodes.some((node) => node.type === "trigger")).toBe(true);
    expect(detail?.nodes.some((node) => node.type === "plan")).toBe(true);
    expect(detail?.nodes.some((node) => node.type === "tool")).toBe(true);
    expect(detail?.nodes.some((node) => node.type === "finalize")).toBe(true);

    const timelineText = detail?.timeline.map((entry) => entry.text).join(" ") ?? "";
    expect(timelineText).not.toContain("+1 (202) 555-0100");
    expect(timelineText).not.toContain("120363273899090274@g.us");
    expect(timelineText).toContain("[masked-phone]");
    expect(timelineText).toContain("[masked-jid]");
  });

  it("marks lifecycle errors as failed runs", async () => {
    const store = new TaskTraceStore({
      stateDir: tempDir,
      retentionDays: 180,
      log: createLogger(),
    });
    await store.start();

    const runId = "run-tasks-error";
    const startedAt = Date.now();

    store.ingest({
      runId,
      seq: 1,
      stream: "lifecycle",
      ts: startedAt,
      sessionKey: "agent:main:main",
      data: { phase: "start", startedAt },
    });

    store.ingest({
      runId,
      seq: 2,
      stream: "lifecycle",
      ts: startedAt + 500,
      data: {
        phase: "error",
        endedAt: startedAt + 500,
        error: "fatal token eyJabc.def.ghi",
      },
    });

    await store.stop();

    const list = await store.list({ status: "error", limit: 10 });
    expect(list.total).toBe(1);
    expect(list.items[0]?.status).toBe("error");
    expect(list.items[0]?.preview).toContain("Task failed");

    const detail = await store.get({ runId });
    expect(detail?.run.timeline.some((entry) => entry.level === "error")).toBe(true);
  });

  it("backfills recent transcript summaries as partial task runs", async () => {
    const sessionsDir = path.join(tempDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionId = "sess-backfill-1";
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:whatsapp:group:ops";
    const now = Date.now();

    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId,
          updatedAt: now,
          displayName: "Ops Community",
          origin: {
            provider: "whatsapp",
            surface: "group",
          },
        },
      }),
      "utf-8",
    );

    await fs.writeFile(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          message: {
            role: "user",
            content: "Ping me at +1 (202) 555-0100",
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "Use token sk-this-should-not-leak-1234567890",
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const store = new TaskTraceStore({
      stateDir: tempDir,
      retentionDays: 180,
      log: createLogger(),
    });
    await store.start();

    const list = await store.list({ source: "whatsapp", limit: 50 });
    expect(list.total).toBe(1);
    const summary = list.items[0];
    expect(summary?.detailPartial).toBe(true);
    expect(summary?.runId.startsWith("backfill:")).toBe(true);
    expect(summary?.preview).not.toContain("+1 (202) 555-0100");
    expect(summary?.preview).not.toContain("sk-this-should-not-leak-1234567890");
    expect(summary?.preview).toContain("[masked");

    const detail = summary?.runId ? await store.get({ runId: summary.runId }) : null;
    expect(detail).not.toBeNull();
    expect(detail?.run.detailPartial).toBe(true);
    expect(detail?.run.nodes.map((node) => node.type)).toEqual(["trigger", "finalize"]);

    await store.stop();
  });
});
