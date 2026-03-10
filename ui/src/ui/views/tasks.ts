import { html, nothing, type TemplateResult } from "lit";
import type { TasksFilterTimeRange } from "../controllers/tasks.ts";
import type {
  SimplifiedTaskStatus,
  TaskRunSummary,
  TaskRunDetail,
  ScheduledTask,
  TaskStreamEntry,
  TaskSource,
} from "../types.ts";

export type TasksViewProps = {
  loading: boolean;
  error: string | null;
  running: TaskRunSummary[];
  queued: TaskRunSummary[];
  done: TaskRunSummary[];
  scheduled: ScheduledTask[];
  expandedRunId: string | null;
  expandedDetail: TaskRunDetail | null;
  detailLoading: boolean;
  streamEntries: Map<string, TaskStreamEntry[]>;
  filterChannels: Set<TaskSource | "all">;
  filterStatus: Set<SimplifiedTaskStatus | "all">;
  filterTimeRange: TasksFilterTimeRange;
  filterQuery: string;
  doneHasMore: boolean;
  // Callbacks
  onToggleExpand: (runId: string) => void;
  onFilter: (filters: Record<string, unknown>) => void;
  onSearch: (query: string) => void;
  onLoadMoreDone: () => void;
  onRefresh: () => void;
};

// --- Helpers ---

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) {
    return "just now";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} min ago`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  return `${Math.round(ms / 60_000)} min`;
}

const SOURCE_LABELS: Record<string, string> = {
  chat: "Chat",
  cron: "Cron",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  discord: "Discord",
  signal: "Signal",
  imessage: "iMessage",
  unknown: "Unknown",
};

function renderSourceBadge(source: TaskSource): TemplateResult {
  return html`<span class="task-source-badge">${SOURCE_LABELS[source] ?? source}</span>`;
}

function cleanTitle(title: string | undefined, fallback = "Task"): string {
  const raw = (title ?? "").replace(/\s+/g, " ").trim();
  if (!raw) {
    return fallback;
  }
  if (raw.length > 120) {
    return `${raw.slice(0, 119).trimEnd()}...`;
  }
  return raw;
}

export function groupTasksByStatus(items: TaskRunSummary[]): {
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

// --- Section renderers ---

function renderHeader(props: TasksViewProps): TemplateResult {
  const activeFilters: TemplateResult[] = [];
  if (!props.filterChannels.has("all")) {
    for (const ch of props.filterChannels) {
      if (ch !== "all") {
        activeFilters.push(html`<span class="tasks-filter-pill">${SOURCE_LABELS[ch] ?? ch}</span>`);
      }
    }
  }
  if (!props.filterStatus.has("all")) {
    for (const st of props.filterStatus) {
      if (st !== "all") {
        activeFilters.push(html`<span class="tasks-filter-pill">${st}</span>`);
      }
    }
  }
  if (props.filterTimeRange !== "all") {
    activeFilters.push(html`<span class="tasks-filter-pill">${props.filterTimeRange}</span>`);
  }

  return html`
    <header class="tasks-header">
      <div class="tasks-header__title-row">
        <h2 class="tasks-header__title">Tasks</h2>
        <button
          class="btn"
          ?disabled=${props.loading}
          @click=${props.onRefresh}
        >
          ${props.loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      <div class="tasks-header__controls">
        <input
          type="text"
          class="tasks-search-input"
          placeholder="Search tasks..."
          .value=${props.filterQuery}
          @input=${(e: Event) => props.onSearch((e.target as HTMLInputElement).value)}
        />
      </div>
      ${
        activeFilters.length > 0
          ? html`<div class="tasks-active-filters">${activeFilters}</div>`
          : nothing
      }
    </header>
  `;
}

function renderError(error: string): TemplateResult {
  return html`<div class="callout danger">${error}</div>`;
}

function renderLoading(): TemplateResult {
  return html`
    <div class="tasks-loading">Loading tasks...</div>
  `;
}

function renderStreamArea(entries: TaskStreamEntry[]): TemplateResult {
  return html`
    <div class="task-stream-area">
      ${entries.map(
        (entry) => html`
          <div class="task-stream-entry">
            <span class="task-stream-entry__tool">${entry.tool || entry.phase}</span>
            <span class="task-stream-entry__text">${entry.streamText ?? entry.text ?? ""}</span>
          </div>
        `,
      )}
    </div>
  `;
}

function renderRunningSection(props: TasksViewProps): TemplateResult | typeof nothing {
  if (props.running.length === 0) {
    return nothing;
  }

  return html`
    <section class="tasks-section">
      <div class="tasks-section__header tasks-section__header--running">
        <span class="tasks-section__indicator tasks-section__indicator--green"></span>
        RUNNING (${props.running.length})
      </div>
      ${props.running.map((task) => {
        const expanded = props.expandedRunId === task.runId;
        const entries = props.streamEntries.get(task.runId) ?? [];
        const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;

        return html`
          <button
            class="task-card task-card--running ${expanded ? "task-card--expanded" : ""}"
            @click=${() => props.onToggleExpand(task.runId)}
          >
            <div class="task-card__header">
              <span class="task-card__title">${cleanTitle(task.title)}</span>
              ${renderSourceBadge(task.source)}
              <span class="task-card__time">started ${formatRelativeTime(task.startedAt)}</span>
            </div>
            ${
              expanded
                ? entries.length > 0
                  ? renderStreamArea(entries)
                  : html`
                      <div class="task-card__empty-stream">Waiting for activity...</div>
                    `
                : lastEntry
                  ? html`<div class="task-card__preview">${lastEntry.streamText ?? lastEntry.text ?? lastEntry.tool}</div>`
                  : nothing
            }
          </button>
        `;
      })}
    </section>
  `;
}

function renderQueuedSection(props: TasksViewProps): TemplateResult | typeof nothing {
  if (props.queued.length === 0) {
    return nothing;
  }

  return html`
    <section class="tasks-section">
      <div class="tasks-section__header tasks-section__header--queued">
        QUEUED (${props.queued.length})
      </div>
      ${props.queued.map(
        (task) => html`
          <div class="task-card task-card--queued">
            <div class="task-card__header">
              <span class="task-card__title">${cleanTitle(task.title)}</span>
              ${renderSourceBadge(task.source)}
              <span class="task-card__time">waiting...</span>
            </div>
          </div>
        `,
      )}
    </section>
  `;
}

function renderScheduledSection(props: TasksViewProps): TemplateResult | typeof nothing {
  if (props.scheduled.length === 0) {
    return nothing;
  }

  return html`
    <section class="tasks-section">
      <div class="tasks-section__header tasks-section__header--scheduled">
        SCHEDULED
      </div>
      ${props.scheduled.map((cron) => {
        const nextIn = cron.nextRunAt - Date.now();
        const countdown =
          nextIn <= 0
            ? "now"
            : nextIn < 3_600_000
              ? `in ${Math.ceil(nextIn / 60_000)} min`
              : `in ${Math.ceil(nextIn / 3_600_000)}h`;
        const statusIcon =
          cron.lastStatus === "done" ? "done" : cron.lastStatus === "failed" ? "failed" : "";
        const streak = `${cron.streak.success}/${cron.streak.total}`;

        return html`
          <div class="task-cron">
            <div class="task-cron__header">
              <span class="task-cron__label">${cron.label}</span>
              <span class="task-cron__schedule">${cron.schedule}</span>
            </div>
            <div class="task-cron__meta">
              <span class="task-cron__countdown">Next: ${countdown}</span>
              ${
                statusIcon
                  ? html`<span class="task-cron__last-status task-cron__last-status--${statusIcon}">Last: ${statusIcon}</span>`
                  : nothing
              }
              <span class="task-cron__streak">Streak: ${streak}</span>
            </div>
          </div>
        `;
      })}
    </section>
  `;
}

function renderDoneSection(props: TasksViewProps): TemplateResult | typeof nothing {
  if (props.done.length === 0) {
    return nothing;
  }

  return html`
    <section class="tasks-section">
      <div class="tasks-section__header tasks-section__header--done">
        DONE (${props.done.length})
      </div>
      ${props.done.map((task) => {
        const expanded = props.expandedRunId === task.runId;
        const icon = task.status === "failed" ? "x" : "ok";
        const duration = task.durationMs != null ? formatDuration(task.durationMs) : "";

        return html`
          <button
            class="task-done-row task-done-row--${icon} ${expanded ? "task-done-row--expanded" : ""}"
            @click=${() => props.onToggleExpand(task.runId)}
          >
            <span class="task-done-row__icon task-done-row__icon--${icon}">
              ${task.status === "failed" ? "x" : "ok"}
            </span>
            <span class="task-done-row__title">${cleanTitle(task.title)}</span>
            ${duration ? html`<span class="task-done-row__duration">${duration}</span>` : nothing}
            ${renderSourceBadge(task.source)}
          </button>
          ${expanded ? renderDoneDetail(props) : nothing}
        `;
      })}
      ${
        props.doneHasMore
          ? html`<button class="btn tasks-load-more" @click=${props.onLoadMoreDone}>
            Show earlier
          </button>`
          : nothing
      }
    </section>
  `;
}

function renderDoneDetail(props: TasksViewProps): TemplateResult {
  if (props.detailLoading) {
    return html`
      <div class="task-detail-loading">Loading details...</div>
    `;
  }
  if (!props.expandedDetail) {
    return html`
      <div class="task-detail-empty">No details available.</div>
    `;
  }

  const detail = props.expandedDetail;
  return html`
    <div class="task-detail">
      ${detail.summary ? html`<div class="task-detail__summary">${detail.summary}</div>` : nothing}
      ${
        detail.errorReason
          ? html`<div class="task-detail__error">${detail.errorReason}</div>`
          : nothing
      }
      ${
        detail.steps.length > 0
          ? html`
            <div class="task-detail__steps">
              ${detail.steps.map(
                (step) => html`
                  <div class="task-detail__step">
                    <span class="task-detail__step-tool">${step.tool}</span>
                    <span class="task-detail__step-result">${step.result}</span>
                  </div>
                `,
              )}
            </div>
          `
          : nothing
      }
    </div>
  `;
}

function renderEmptyState(props: TasksViewProps): TemplateResult | typeof nothing {
  const total =
    props.running.length + props.queued.length + props.done.length + props.scheduled.length;
  if (total > 0) {
    return nothing;
  }

  return html`
    <div class="tasks-empty">
      <div class="tasks-empty__title">No tasks yet</div>
      <div class="tasks-empty__hint">
        Tasks appear here when triggered from Chat, Cron, or messaging channels.
      </div>
    </div>
  `;
}

// --- Main export ---

export function renderTasks(props: TasksViewProps): TemplateResult {
  return html`
    <div class="tasks-dashboard">
      ${renderHeader(props)}
      ${props.error ? renderError(props.error) : ""}
      ${
        props.loading
          ? renderLoading()
          : html`
            ${renderRunningSection(props)}
            ${renderQueuedSection(props)}
            ${renderScheduledSection(props)}
            ${renderDoneSection(props)}
            ${renderEmptyState(props)}
          `
      }
    </div>
  `;
}
