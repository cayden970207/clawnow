import { render } from "lit";
import { describe, expect, it } from "vitest";
import "../styles.css";
import type { TaskRunDetail, TaskRunSummary } from "./types.ts";
import { renderTasks, type TasksViewProps } from "./views/tasks.ts";

function createSummary(overrides: Partial<TaskRunSummary> = {}): TaskRunSummary {
  return {
    runId: "run-1",
    source: "chat",
    status: "done",
    title: "Prepare product update",
    preview: "Draft and send update",
    startedAt: Date.now() - 4_000,
    endedAt: Date.now() - 1_000,
    durationMs: 2_900,
    updatedAt: Date.now() - 1_000,
    ...overrides,
  };
}

function createDetail(overrides: Partial<TaskRunDetail> = {}): TaskRunDetail {
  const summary = createSummary({ runId: "run-detail" });
  return {
    ...summary,
    summary: "Completed product update draft and sent it.",
    steps: [
      { tool: "search", result: "Found 3 results", phase: "tool_call" },
      { tool: "send_message", result: "Message sent", phase: "tool_call" },
    ],
    ...overrides,
  };
}

function baseProps(overrides: Partial<TasksViewProps> = {}): TasksViewProps {
  return {
    loading: false,
    error: null,
    running: [],
    queued: [],
    done: [],
    scheduled: [],
    expandedRunId: null,
    expandedDetail: null,
    detailLoading: false,
    streamEntries: new Map(),
    filterChannels: new Set(["all"]),
    filterStatus: new Set(["all"]),
    filterTimeRange: "all",
    filterQuery: "",
    doneHasMore: false,
    onToggleExpand: () => undefined,
    onFilter: () => undefined,
    onSearch: () => undefined,
    onLoadMoreDone: () => undefined,
    onRefresh: () => undefined,
    ...overrides,
  };
}

describe("tasks dashboard", () => {
  it("renders done section and expands detail on click", async () => {
    const detail = createDetail({ runId: "run-abc" });
    const container = document.createElement("div");
    let expandedId: string | null = null;

    const props = baseProps({
      done: [createSummary({ runId: "run-abc" })],
      expandedRunId: "run-abc",
      expandedDetail: detail,
      onToggleExpand: (runId: string) => {
        expandedId = runId;
      },
    });

    render(renderTasks(props), container);
    // Should render the done section
    expect(container.textContent).toContain("DONE");
    // Should show detail summary when expanded
    expect(container.textContent).toContain("Completed product update draft");
    // Should render step tool names
    expect(container.textContent).toContain("search");
    expect(container.textContent).toContain("send_message");

    // Click the done row to toggle expand
    const row = container.querySelector(".task-done-row");
    expect(row).not.toBeNull();
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(expandedId).toBe("run-abc");
  });

  it("renders running section with stream entries", async () => {
    const container = document.createElement("div");
    const runningTask = createSummary({ runId: "run-live", status: "running", endedAt: undefined });
    const streamEntries = new Map([
      [
        "run-live",
        [{ tool: "web_search", phase: "tool_call", text: "Searching...", timestamp: Date.now() }],
      ],
    ]);

    const props = baseProps({
      running: [runningTask],
      expandedRunId: "run-live",
      streamEntries,
    });

    render(renderTasks(props), container);
    expect(container.textContent).toContain("RUNNING");
    expect(container.textContent).toContain("web_search");
    expect(container.textContent).toContain("Searching...");
  });

  it("renders empty state when no tasks exist", async () => {
    const container = document.createElement("div");
    const props = baseProps();

    render(renderTasks(props), container);
    expect(container.textContent).toContain("No tasks yet");
  });

  it("collapses expanded task when clicking another done task", async () => {
    const container = document.createElement("div");
    const runA = createSummary({ runId: "run-a", status: "done" });
    const runB = createSummary({ runId: "run-b", status: "failed" });
    let expandedId: string | null = "run-a";

    const renderWithState = () =>
      render(
        renderTasks(
          baseProps({
            done: [runA, runB],
            expandedRunId: expandedId,
            onToggleExpand: (runId: string) => {
              expandedId = expandedId === runId ? null : runId;
            },
          }),
        ),
        container,
      );

    renderWithState();
    const rows = container.querySelectorAll(".task-done-row");
    expect(rows.length).toBe(2);

    // Click second row
    rows[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(expandedId).toBe("run-b");
  });
});
