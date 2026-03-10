import { describe, expect, it } from "vitest";
import type { TaskRunSummary } from "../types.ts";
import { formatRelativeTime, formatDuration, groupTasksByStatus } from "./tasks.ts";

function createSummary(overrides: Partial<TaskRunSummary>): TaskRunSummary {
  return {
    runId: "run-1",
    source: "chat",
    status: "done",
    title: "Write launch update",
    preview: "Post update to the team channel",
    startedAt: Date.now() - 2_000,
    endedAt: Date.now() - 1_000,
    durationMs: 1_000,
    updatedAt: Date.now() - 1_000,
    ...overrides,
  };
}

describe("tasks view utilities", () => {
  describe("formatRelativeTime", () => {
    it("returns 'just now' for timestamps under 60 seconds ago", () => {
      expect(formatRelativeTime(Date.now() - 30_000)).toBe("just now");
      expect(formatRelativeTime(Date.now())).toBe("just now");
    });

    it("returns minutes for timestamps under 1 hour ago", () => {
      expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe("5 min ago");
      expect(formatRelativeTime(Date.now() - 45 * 60_000)).toBe("45 min ago");
    });

    it("returns hours for timestamps under 1 day ago", () => {
      expect(formatRelativeTime(Date.now() - 3 * 3_600_000)).toBe("3h ago");
    });

    it("returns days for older timestamps", () => {
      expect(formatRelativeTime(Date.now() - 2 * 86_400_000)).toBe("2d ago");
    });
  });

  describe("formatDuration", () => {
    it("returns seconds for durations under 1 minute", () => {
      expect(formatDuration(5_000)).toBe("5s");
      expect(formatDuration(45_000)).toBe("45s");
      expect(formatDuration(500)).toBe("1s");
    });

    it("returns minutes for durations 1 minute or over", () => {
      expect(formatDuration(60_000)).toBe("1 min");
      expect(formatDuration(150_000)).toBe("3 min");
    });
  });

  describe("groupTasksByStatus", () => {
    it("groups tasks into running, queued, and done", () => {
      const tasks = [
        createSummary({ runId: "r1", status: "running" }),
        createSummary({ runId: "r2", status: "queued" }),
        createSummary({ runId: "r3", status: "done" }),
        createSummary({ runId: "r4", status: "failed" }),
        createSummary({ runId: "r5", status: "running" }),
      ];
      const grouped = groupTasksByStatus(tasks);
      expect(grouped.running.map((t) => t.runId)).toEqual(["r1", "r5"]);
      expect(grouped.queued.map((t) => t.runId)).toEqual(["r2"]);
      expect(grouped.done.map((t) => t.runId)).toEqual(["r3", "r4"]);
    });

    it("returns empty arrays when no tasks", () => {
      const grouped = groupTasksByStatus([]);
      expect(grouped.running).toEqual([]);
      expect(grouped.queued).toEqual([]);
      expect(grouped.done).toEqual([]);
    });
  });
});
