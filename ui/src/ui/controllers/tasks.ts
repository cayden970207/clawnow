import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  SimplifiedTaskStatus,
  TaskRunSummary,
  TaskRunDetail,
  TasksListResult,
  ScheduledTask,
  TaskStreamEvent,
  TaskStreamEntry,
  TaskSource,
} from "../types.ts";

const DEFAULT_LIST_LIMIT = 80;

export type TasksFilterTimeRange = "today" | "week" | "month" | "all";

export type TasksState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  // Loading
  tasksLoading: boolean;
  tasksError: string | null;
  // Data — grouped by status
  tasksRunning: TaskRunSummary[];
  tasksQueued: TaskRunSummary[];
  tasksDone: TaskRunSummary[];
  tasksScheduled: ScheduledTask[];
  // Expanded task detail
  tasksExpandedRunId: string | null;
  tasksExpandedDetail: TaskRunDetail | null;
  tasksDetailLoading: boolean;
  // Streaming for running tasks
  tasksStreamEntries: Map<string, TaskStreamEntry[]>;
  // Filters
  tasksFilterChannels: Set<TaskSource | "all">;
  tasksFilterStatus: Set<SimplifiedTaskStatus | "all">;
  tasksFilterTimeRange: TasksFilterTimeRange;
  tasksFilterQuery: string;
  // Pagination
  tasksDoneHasMore: boolean;
  tasksDoneCursor: number | null;
  // Sync
  tasksLastSyncedAt: number | null;
};

function groupByStatus(items: TaskRunSummary[]): {
  running: TaskRunSummary[];
  queued: TaskRunSummary[];
  done: TaskRunSummary[];
} {
  const running: TaskRunSummary[] = [];
  const queued: TaskRunSummary[] = [];
  const done: TaskRunSummary[] = [];
  for (const item of items) {
    switch (item.status) {
      case "running":
        running.push(item);
        break;
      case "queued":
        queued.push(item);
        break;
      case "done":
      case "failed":
        done.push(item);
        break;
    }
  }
  return { running, queued, done };
}

function getTimeRangeTs(range: TasksFilterTimeRange): number | undefined {
  if (range === "all") {
    return undefined;
  }
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (range === "today") {
    return now.getTime();
  }
  if (range === "week") {
    now.setDate(now.getDate() - 7);
    return now.getTime();
  }
  if (range === "month") {
    now.setMonth(now.getMonth() - 1);
    return now.getTime();
  }
  return undefined;
}

export async function loadTasks(state: TasksState): Promise<void> {
  if (!state.client || !state.connected || state.tasksLoading) {
    return;
  }
  state.tasksLoading = true;
  state.tasksError = null;
  try {
    const sourceFilter = state.tasksFilterChannels.has("all")
      ? "all"
      : ([...state.tasksFilterChannels][0] ?? "all");
    const statusFilter = state.tasksFilterStatus.has("all")
      ? "all"
      : ([...state.tasksFilterStatus][0] ?? "all");
    const fromTs = getTimeRangeTs(state.tasksFilterTimeRange);

    const result = await state.client.request<TasksListResult>("tasks.list", {
      limit: DEFAULT_LIST_LIMIT,
      cursor: 0,
      source: sourceFilter,
      status: statusFilter,
      query: state.tasksFilterQuery.trim() || undefined,
      fromTs,
    });
    const grouped = groupByStatus(result.items);
    state.tasksRunning = grouped.running;
    state.tasksQueued = grouped.queued;
    state.tasksDone = grouped.done;
    state.tasksDoneHasMore = result.hasMore;
    state.tasksDoneCursor = result.nextCursor;
    state.tasksLastSyncedAt = Date.now();
  } catch (err) {
    state.tasksError = String(err);
  } finally {
    state.tasksLoading = false;
  }
}

export async function loadScheduled(state: TasksState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const result = await state.client.request<{ items: ScheduledTask[] }>("tasks.scheduled", {});
    state.tasksScheduled = result.items;
  } catch {
    // Silently fail — scheduled is optional enhancement
    state.tasksScheduled = [];
  }
}

export async function loadTaskDetail(state: TasksState, runId: string): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  state.tasksDetailLoading = true;
  try {
    const result = await state.client.request<{ run: TaskRunDetail }>("tasks.get", { runId });
    state.tasksExpandedDetail = result.run;
  } catch {
    state.tasksExpandedDetail = null;
  } finally {
    state.tasksDetailLoading = false;
  }
}

export function toggleTaskExpanded(state: TasksState, runId: string): void {
  if (state.tasksExpandedRunId === runId) {
    // Collapse
    state.tasksExpandedRunId = null;
    state.tasksExpandedDetail = null;
  } else {
    // Expand
    state.tasksExpandedRunId = runId;
    state.tasksExpandedDetail = null;
    // Load detail for done/failed tasks (running tasks use streaming)
    const isRunning = state.tasksRunning.some((t) => t.runId === runId);
    if (!isRunning) {
      void loadTaskDetail(state, runId);
    }
  }
}

export function handleTaskStreamEvent(state: TasksState, event: TaskStreamEvent): void {
  const entries = state.tasksStreamEntries.get(event.runId) ?? [];
  const entry: TaskStreamEntry = {
    tool: event.entry?.tool ?? "",
    phase: event.entry?.phase ?? "",
    text: event.entry?.text,
    streamText: event.streamText,
    timestamp: Date.now(),
  };
  entries.push(entry);
  // Keep last 100 entries per task
  if (entries.length > 100) {
    entries.splice(0, entries.length - 100);
  }
  state.tasksStreamEntries.set(event.runId, entries);

  // If task completed, move from running to done and clean up stream
  if (event.type === "task.status" && (event.status === "done" || event.status === "failed")) {
    state.tasksStreamEntries.delete(event.runId);
  }
}

export function applyTaskFilters(
  state: TasksState,
  filters: {
    channels?: Set<TaskSource | "all">;
    status?: Set<SimplifiedTaskStatus | "all">;
    timeRange?: TasksFilterTimeRange;
    query?: string;
  },
): void {
  if (filters.channels) {
    state.tasksFilterChannels = filters.channels;
  }
  if (filters.status) {
    state.tasksFilterStatus = filters.status;
  }
  if (filters.timeRange) {
    state.tasksFilterTimeRange = filters.timeRange;
  }
  if (typeof filters.query === "string") {
    state.tasksFilterQuery = filters.query;
  }
}

export async function loadMoreDone(state: TasksState): Promise<void> {
  if (!state.client || !state.connected || !state.tasksDoneCursor) {
    return;
  }
  try {
    const sourceFilter = state.tasksFilterChannels.has("all")
      ? "all"
      : ([...state.tasksFilterChannels][0] ?? "all");
    const statusFilter = state.tasksFilterStatus.has("all")
      ? "all"
      : ([...state.tasksFilterStatus][0] ?? "all");
    const fromTs = getTimeRangeTs(state.tasksFilterTimeRange);

    const result = await state.client.request<TasksListResult>("tasks.list", {
      limit: DEFAULT_LIST_LIMIT,
      cursor: state.tasksDoneCursor,
      source: sourceFilter,
      status: statusFilter,
      query: state.tasksFilterQuery.trim() || undefined,
      fromTs,
    });
    const grouped = groupByStatus(result.items);
    // Append done items
    state.tasksDone = [...state.tasksDone, ...grouped.done];
    // Update running/queued too in case new ones appeared
    if (grouped.running.length) {
      state.tasksRunning = grouped.running;
    }
    if (grouped.queued.length) {
      state.tasksQueued = [...state.tasksQueued, ...grouped.queued];
    }
    state.tasksDoneHasMore = result.hasMore;
    state.tasksDoneCursor = result.nextCursor;
  } catch (err) {
    state.tasksError = String(err);
  }
}
