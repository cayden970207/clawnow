import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { resolveStateDir } from "../config/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import {
  deriveSessionTitle,
  loadSessionEntry,
  readSessionTitleFieldsFromTranscript,
  resolveSessionTranscriptCandidates,
} from "./session-utils.js";

const HOT_RETENTION_DAYS = 180;
const MAX_QUERY_LIMIT = 200;
const DEFAULT_QUERY_LIMIT = 50;
const MAX_TIMELINE_ENTRIES = 600;
const ARCHIVE_INTERVAL_MS = 15 * 60_000;
const BACKFILL_RUN_PREFIX = "backfill";

type LogFn = (message: string) => void;

export type TaskTraceLogger = {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug?: LogFn;
};

export type TaskSource =
  | "chat"
  | "cron"
  | "whatsapp"
  | "telegram"
  | "discord"
  | "signal"
  | "imessage"
  | "unknown";

export type TaskStatus = "running" | "success" | "error" | "aborted" | "timeout";

export type SimplifiedTaskStatus = "queued" | "running" | "done" | "failed";

export function toSimplifiedStatus(status: TaskStatus): SimplifiedTaskStatus {
  switch (status) {
    case "running":
      return "running";
    case "success":
      return "done";
    case "error":
    case "aborted":
    case "timeout":
      return "failed";
    default:
      return "running";
  }
}

export type TaskStep = { tool: string; result: string; phase: string };

export function extractSteps(nodes: TaskNode[]): TaskStep[] {
  return nodes
    .filter((n) => n.type === "tool" || n.type === "assistant")
    .map((n) => ({
      tool: n.label,
      result: n.summary ?? "",
      phase: n.status === "error" ? "error" : "result",
    }));
}

export function extractErrorReason(nodes: TaskNode[]): string | undefined {
  const errorNode = nodes.find(
    (n) => n.status === "error" || n.status === "timeout" || n.status === "aborted",
  );
  return errorNode?.summary;
}

export type TaskNodeType = "trigger" | "plan" | "tool" | "assistant" | "finalize";

export type TaskEdgeType = "sequence" | "branch" | "retry";

export type TaskNode = {
  id: string;
  type: TaskNodeType;
  label: string;
  status: TaskStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  summary?: string;
};

export type TaskEdge = {
  from: string;
  to: string;
  type: TaskEdgeType;
};

export type TaskTimelineEntry = {
  at: number;
  nodeId: string;
  phase: string;
  level: "info" | "warn" | "error";
  text: string;
};

export type TaskRunSummary = {
  runId: string;
  source: TaskSource;
  status: TaskStatus;
  title: string;
  preview: string;
  sessionKey?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  updatedAt: number;
  toolCalls: number;
  assistantMessages: number;
  detailPartial?: boolean;
};

export type TaskRunDetail = TaskRunSummary & {
  nodes: TaskNode[];
  edges: TaskEdge[];
  timeline: TaskTimelineEntry[];
};

export type TasksListParams = {
  limit?: number;
  cursor?: number;
  source?: TaskSource | "all";
  status?: TaskStatus | "all";
  query?: string;
  fromTs?: number;
  toTs?: number;
};

export type TasksListResult = {
  ts: number;
  total: number;
  hasMore: boolean;
  nextCursor: number | null;
  items: TaskRunSummary[];
};

export type TasksGetParams = {
  runId: string;
};

export type TasksGetResult = {
  run: TaskRunDetail;
};

export type TaskStreamEvent = {
  type: "task.update" | "task.status";
  runId: string;
  status: SimplifiedTaskStatus;
  entry?: { tool: string; phase: string; text?: string };
  streamText?: string;
};

export type TaskTraceMetrics = {
  task_trace_events_ingested: number;
  task_trace_runs_completed: number;
  task_trace_persist_failures: number;
  task_trace_archive_jobs: number;
};

type TaskTraceStoreOptions = {
  stateDir?: string;
  retentionDays?: number;
  log: TaskTraceLogger;
};

type SourceResolution = {
  source: TaskSource;
  titleHint?: string;
};

type SessionSourceMetadata = Pick<SessionEntry, "origin" | "channel" | "lastChannel">;

type ActiveRun = {
  summary: TaskRunSummary;
  detail: TaskRunDetail;
  nodeById: Map<string, TaskNode>;
  edgeKeys: Set<string>;
  toolNodeByCallId: Map<string, string>;
  lastNodeId: string;
  finalized: boolean;
  hadError: boolean;
};

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function monthKeyFromTimestamp(ts: number): string {
  const date = new Date(ts);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function canonicalizeStoreSessionKey(agentId: string, storeKey: string): string {
  const trimmed = storeKey.trim();
  if (!trimmed) {
    return `agent:${agentId}:main`;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === "global" || lowered === "unknown" || lowered.startsWith("agent:")) {
    return lowered;
  }
  return `agent:${agentId}:${lowered}`;
}

function makeBackfillRunId(sessionKey: string, sessionId: string): string {
  const digest = crypto.createHash("sha1").update(`${sessionKey}:${sessionId}`).digest("hex");
  return `${BACKFILL_RUN_PREFIX}:${digest.slice(0, 24)}`;
}

function toValidTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const next = Math.max(0, Math.floor(value));
  return next > 0 ? next : null;
}

function detectTaskSourceFromMetadata(
  sessionKey: string | undefined,
  entry?: SessionSourceMetadata,
): SourceResolution {
  if (isCronRunSessionKey(sessionKey)) {
    return { source: "cron", titleHint: "Cron task" };
  }
  const normalizedSessionKey = toNonEmptyString(sessionKey);
  if (!normalizedSessionKey) {
    return { source: "unknown", titleHint: "Unknown task" };
  }

  const candidateRaw =
    toNonEmptyString(entry?.origin?.provider) ??
    toNonEmptyString(entry?.origin?.surface) ??
    toNonEmptyString(entry?.channel) ??
    toNonEmptyString(entry?.lastChannel);
  const candidate = candidateRaw?.toLowerCase();
  const titleHint =
    toNonEmptyString(entry?.origin?.label) ??
    toNonEmptyString(entry?.origin?.threadId ? String(entry.origin.threadId) : undefined);

  switch (candidate) {
    case "cron":
      return { source: "cron", titleHint: titleHint ?? "Cron task" };
    case "whatsapp":
    case "telegram":
    case "discord":
    case "signal":
    case "imessage":
      return { source: candidate, titleHint: titleHint ?? `${candidate} task` };
    case "webchat":
    case "chat":
    case "web":
    case "gateway":
      return { source: "chat", titleHint: titleHint ?? "Chat task" };
    default:
      break;
  }

  if (normalizedSessionKey.includes(":whatsapp:")) {
    return { source: "whatsapp", titleHint: titleHint ?? "WhatsApp task" };
  }
  if (normalizedSessionKey.includes(":telegram:")) {
    return { source: "telegram", titleHint: titleHint ?? "Telegram task" };
  }
  if (normalizedSessionKey.includes(":discord:")) {
    return { source: "discord", titleHint: titleHint ?? "Discord task" };
  }
  if (normalizedSessionKey.includes(":signal:")) {
    return { source: "signal", titleHint: titleHint ?? "Signal task" };
  }
  if (normalizedSessionKey.includes(":imessage:")) {
    return { source: "imessage", titleHint: titleHint ?? "iMessage task" };
  }
  return { source: "chat", titleHint: titleHint ?? "Chat task" };
}

function maskSensitiveString(raw: string): string {
  let next = raw;
  next = next.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[masked-email]");
  next = next.replace(/\b\d{5,}(?:-\d+)?@g\.us\b/gi, "[masked-jid]");
  next = next.replace(/\b\d{5,}@s\.whatsapp\.net\b/gi, "[masked-jid]");
  next = next.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[masked-token]");
  next = next.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    "[masked-jwt]",
  );
  next = next.replace(/([?&][^=\s]{1,64}=)[^&\s]+/g, "$1[masked]");
  next = next.replace(/\+?\d[\d\s().-]{7,}\d/g, "[masked-phone]");
  next = next.replace(/[A-Za-z0-9_-]{32,}/g, "[masked-secret]");
  return next;
}

function summarizeUnknown(value: unknown, maxChars = 260): string {
  if (typeof value === "string") {
    return truncateText(maskSensitiveString(value), maxChars);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }
  try {
    const serialized = JSON.stringify(
      value,
      (key, entry) => {
        if (
          typeof key === "string" &&
          /token|secret|api[_-]?key|password|authorization/i.test(key)
        ) {
          return "[masked]";
        }
        if (typeof entry === "string") {
          return truncateText(maskSensitiveString(entry), 200);
        }
        return entry;
      },
      0,
    );
    if (!serialized) {
      return "";
    }
    return truncateText(maskSensitiveString(serialized), maxChars);
  } catch {
    return "[unserializable]";
  }
}

function detectTaskSource(sessionKey: string | undefined): SourceResolution {
  try {
    const normalizedSessionKey = toNonEmptyString(sessionKey);
    const { entry } = normalizedSessionKey
      ? loadSessionEntry(normalizedSessionKey)
      : { entry: undefined };
    return detectTaskSourceFromMetadata(normalizedSessionKey ?? undefined, entry);
  } catch {
    return detectTaskSourceFromMetadata(toNonEmptyString(sessionKey) ?? undefined);
  }
}

function resolveTerminalStatus(event: AgentEventPayload): TaskStatus | null {
  if (event.stream !== "lifecycle") {
    return null;
  }
  const phase = toNonEmptyString(event.data?.phase)?.toLowerCase();
  if (phase === "error") {
    return "error";
  }
  if (phase === "end") {
    if (event.data?.aborted === true) {
      return "timeout";
    }
    return "success";
  }
  return null;
}

function safeJsonParseLine<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

function parseJsonl<T>(raw: string): T[] {
  if (!raw.trim()) {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parsed = safeJsonParseLine<T>(trimmed);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

function dedupeSummariesByRun(entries: TaskRunSummary[]): TaskRunSummary[] {
  const latestByRun = new Map<string, TaskRunSummary>();
  for (const entry of entries) {
    const runId = toNonEmptyString(entry.runId);
    if (!runId) {
      continue;
    }
    const previous = latestByRun.get(runId);
    if (!previous || (entry.updatedAt ?? entry.startedAt ?? 0) >= (previous.updatedAt ?? 0)) {
      latestByRun.set(runId, {
        ...entry,
        runId,
        title: truncateText(maskSensitiveString(entry.title || "Task run"), 120),
        preview: truncateText(maskSensitiveString(entry.preview || ""), 220),
      });
    }
  }
  return Array.from(latestByRun.values());
}

function cloneSummary(summary: TaskRunSummary): TaskRunSummary {
  return {
    ...summary,
    preview: truncateText(maskSensitiveString(summary.preview || ""), 220),
    title: truncateText(maskSensitiveString(summary.title || "Task run"), 120),
  };
}

function cloneDetail(detail: TaskRunDetail): TaskRunDetail {
  return {
    ...cloneSummary(detail),
    nodes: detail.nodes.map((node) => ({ ...node })),
    edges: detail.edges.map((edge) => ({ ...edge })),
    timeline: detail.timeline.map((entry) => ({ ...entry })),
  };
}

function makeEmptyMetrics(): TaskTraceMetrics {
  return {
    task_trace_events_ingested: 0,
    task_trace_runs_completed: 0,
    task_trace_persist_failures: 0,
    task_trace_archive_jobs: 0,
  };
}

function buildPartialBackfillDetail(summary: TaskRunSummary): TaskRunDetail {
  const startedAt = toValidTimestamp(summary.startedAt) ?? summary.updatedAt ?? Date.now();
  const endedAt = toValidTimestamp(summary.endedAt) ?? summary.updatedAt ?? startedAt;
  const triggerNode: TaskNode = {
    id: "trigger",
    type: "trigger",
    label: "Trigger",
    status: "success",
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    summary: `Source: ${summary.source}`,
  };
  const finalizeNode: TaskNode = {
    id: "finalize",
    type: "finalize",
    label: "Finalize",
    status: summary.status,
    startedAt: endedAt,
    endedAt,
    durationMs: 0,
    summary: summary.preview || "Backfilled summary",
  };
  return {
    ...cloneSummary(summary),
    nodes: [triggerNode, finalizeNode],
    edges: [{ from: "trigger", to: "finalize", type: "sequence" }],
    timeline: [
      {
        at: startedAt,
        nodeId: "trigger",
        phase: "backfill",
        level: "info",
        text: "Recovered from historical transcript metadata",
      },
      {
        at: endedAt,
        nodeId: "finalize",
        phase: summary.status,
        level: summary.status === "error" ? "error" : "info",
        text: summary.preview || "Recovered run summary",
      },
    ],
  };
}

export class TaskTraceStore {
  private readonly stateDir: string;
  private readonly retentionMs: number;
  private readonly rootDir: string;
  private readonly runsDir: string;
  private readonly archiveDir: string;
  private readonly indexPath: string;
  private initialized = false;
  private archiveTimer: ReturnType<typeof setInterval> | null = null;
  private archiveRunning = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private activeRuns = new Map<string, ActiveRun>();
  private recentDetailByRun = new Map<string, TaskRunDetail>();
  private persistedRunIds = new Set<string>();
  private metrics: TaskTraceMetrics = makeEmptyMetrics();
  private backfillPromise: Promise<void> | null = null;
  private backfillCompleted = false;

  onTaskEvent?: (event: TaskStreamEvent) => void;

  constructor(private readonly options: TaskTraceStoreOptions) {
    this.stateDir = options.stateDir ?? resolveStateDir();
    this.retentionMs =
      Math.max(1, Math.floor(options.retentionDays ?? HOT_RETENTION_DAYS)) * 24 * 60 * 60 * 1000;
    this.rootDir = path.join(this.stateDir, "state", "task-traces");
    this.runsDir = path.join(this.rootDir, "runs");
    this.archiveDir = path.join(this.rootDir, "archive");
    this.indexPath = path.join(this.rootDir, "index.jsonl");
  }

  async start() {
    await this.ensureInitialized();
    if (!this.archiveTimer) {
      this.archiveTimer = setInterval(() => {
        void this.runArchivePass();
      }, ARCHIVE_INTERVAL_MS);
    }
  }

  async stop() {
    if (this.archiveTimer) {
      clearInterval(this.archiveTimer);
      this.archiveTimer = null;
    }
    for (const run of this.activeRuns.values()) {
      if (!run.finalized) {
        this.finalizeRun(run, {
          status: "aborted",
          endedAt: Date.now(),
          preview: "Gateway stopped before run completion.",
        });
      }
    }
    await this.writeQueue.catch(() => {});
  }

  getMetrics(): TaskTraceMetrics {
    return { ...this.metrics };
  }

  ingest(event: AgentEventPayload) {
    this.metrics.task_trace_events_ingested += 1;
    const runId = toNonEmptyString(event.runId);
    if (!runId) {
      return;
    }
    const active = this.ensureActiveRun(runId, event);

    if (event.stream === "lifecycle") {
      this.ingestLifecycle(active, event);
      return;
    }
    if (event.stream === "tool") {
      this.ingestTool(active, event);
      return;
    }
    if (event.stream === "assistant") {
      this.ingestAssistant(active, event);
      return;
    }

    this.pushTimeline(active, {
      at: event.ts,
      nodeId: active.lastNodeId,
      phase: event.stream,
      level: "info",
      text: `${event.stream} event`,
    });
  }

  async list(params: TasksListParams): Promise<TasksListResult> {
    await this.ensureInitialized();
    await this.ensureBackfillSummaries();
    await this.runArchivePass();

    const summaries = await this.loadAllSummaries();

    const sourceFilter = toNonEmptyString(params.source)?.toLowerCase() ?? "all";
    const statusFilter = toNonEmptyString(params.status)?.toLowerCase() ?? "all";
    const query = toNonEmptyString(params.query)?.toLowerCase() ?? "";
    const fromTs = typeof params.fromTs === "number" ? params.fromTs : null;
    const toTs = typeof params.toTs === "number" ? params.toTs : null;

    const filtered = summaries.filter((summary) => {
      if (sourceFilter !== "all" && summary.source !== sourceFilter) {
        return false;
      }
      if (statusFilter !== "all" && summary.status !== statusFilter) {
        return false;
      }
      const pivotTs = summary.startedAt || summary.updatedAt;
      if (fromTs != null && pivotTs < fromTs) {
        return false;
      }
      if (toTs != null && pivotTs > toTs) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = `${summary.title} ${summary.preview} ${summary.runId} ${summary.source}`
        .toLowerCase()
        .trim();
      return haystack.includes(query);
    });

    filtered.sort((a, b) => {
      const left = a.startedAt || a.updatedAt || 0;
      const right = b.startedAt || b.updatedAt || 0;
      if (right !== left) {
        return right - left;
      }
      return b.updatedAt - a.updatedAt;
    });

    const cursor = clampInteger(params.cursor, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInteger(params.limit, DEFAULT_QUERY_LIMIT, 1, MAX_QUERY_LIMIT);
    const items = filtered.slice(cursor, cursor + limit);
    const nextCursor = cursor + items.length < filtered.length ? cursor + items.length : null;

    return {
      ts: Date.now(),
      total: filtered.length,
      hasMore: nextCursor !== null,
      nextCursor,
      items: items.map((entry) => cloneSummary(entry)),
    };
  }

  async get(params: TasksGetParams): Promise<TasksGetResult | null> {
    await this.ensureInitialized();
    await this.ensureBackfillSummaries();
    const runId = toNonEmptyString(params.runId);
    if (!runId) {
      return null;
    }

    const active = this.activeRuns.get(runId);
    if (active) {
      return { run: cloneDetail(active.detail) };
    }

    const recent = this.recentDetailByRun.get(runId);
    if (recent) {
      return { run: cloneDetail(recent) };
    }

    const filePath = path.join(this.runsDir, `${runId}.json`);
    const raw = await fsPromises.readFile(filePath, "utf-8").catch(() => null);
    if (!raw) {
      const fallbackSummary = await this.findSummaryByRunId(runId);
      if (fallbackSummary?.detailPartial) {
        const recovered = buildPartialBackfillDetail(fallbackSummary);
        this.cacheRecentDetail(recovered);
        return { run: recovered };
      }
      return null;
    }
    const parsed = safeJsonParseLine<TaskRunDetail>(raw);
    if (!parsed) {
      return null;
    }
    const cloned = cloneDetail(parsed);
    this.cacheRecentDetail(cloned);
    return { run: cloned };
  }

  private async ensureBackfillSummaries() {
    if (this.backfillCompleted) {
      return;
    }
    if (!this.backfillPromise) {
      this.backfillPromise = this.runTranscriptBackfill()
        .catch((err) => {
          this.options.log.warn(`task traces: transcript backfill failed: ${String(err)}`);
        })
        .finally(() => {
          this.backfillCompleted = true;
          this.backfillPromise = null;
        });
    }
    await this.backfillPromise;
  }

  private async runTranscriptBackfill() {
    const existing = await this.readIndexSummaries();
    const knownRunIds = new Set(existing.map((entry) => entry.runId));
    const knownSessionKeys = new Set(
      existing
        .map((entry) => toNonEmptyString(entry.sessionKey))
        .filter((value): value is string => Boolean(value)),
    );
    for (const active of this.activeRuns.values()) {
      knownRunIds.add(active.summary.runId);
      const activeSessionKey = toNonEmptyString(active.summary.sessionKey);
      if (activeSessionKey) {
        knownSessionKeys.add(activeSessionKey);
      }
    }
    const additions: TaskRunSummary[] = [];
    const cutoff = Date.now() - this.retentionMs;
    const stores = await this.loadSessionStores();

    for (const store of stores) {
      for (const [storeKey, entry] of Object.entries(store.entries)) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const sessionId = toNonEmptyString(entry.sessionId);
        if (!sessionId) {
          continue;
        }
        const sessionKey = canonicalizeStoreSessionKey(store.agentId, storeKey);
        if (knownSessionKeys.has(sessionKey)) {
          continue;
        }
        const runId = makeBackfillRunId(sessionKey, sessionId);
        if (knownRunIds.has(runId)) {
          continue;
        }

        const timelineTs = await this.resolveBackfillTimestamp({
          sessionId,
          storePath: store.storePath,
          sessionFile: entry.sessionFile,
          agentId: store.agentId,
          updatedAt: entry.updatedAt,
        });
        if (!timelineTs || timelineTs < cutoff) {
          continue;
        }

        const titleFields = readSessionTitleFieldsFromTranscript(
          sessionId,
          store.storePath,
          entry.sessionFile,
          store.agentId,
        );
        const sourceResolved = detectTaskSourceFromMetadata(sessionKey, entry);
        const title =
          deriveSessionTitle(entry, titleFields.firstUserMessage) ??
          sourceResolved.titleHint ??
          "Recovered task";
        const preview = titleFields.lastMessagePreview ?? titleFields.firstUserMessage ?? "";

        additions.push(
          cloneSummary({
            runId,
            source: sourceResolved.source,
            status: "success",
            title,
            preview,
            sessionKey,
            startedAt: timelineTs,
            endedAt: timelineTs,
            durationMs: 0,
            updatedAt: timelineTs,
            toolCalls: 0,
            assistantMessages: 0,
            detailPartial: true,
          }),
        );
        knownRunIds.add(runId);
        knownSessionKeys.add(sessionKey);
      }
    }

    if (additions.length === 0) {
      return;
    }

    const merged = dedupeSummariesByRun([...existing, ...additions]);
    await this.writeIndexSummaries(merged);
    for (const added of additions) {
      this.persistedRunIds.add(added.runId);
    }
    this.options.log.info(`task traces: backfilled ${additions.length} historical runs`);
  }

  private async loadSessionStores(): Promise<
    Array<{ agentId: string; storePath: string; entries: Record<string, SessionEntry> }>
  > {
    const agentsDir = path.join(this.stateDir, "agents");
    const agentEntries = await fsPromises
      .readdir(agentsDir, { withFileTypes: true })
      .catch(() => []);
    const candidates = agentEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name.trim())
      .filter(Boolean);
    if (candidates.length === 0) {
      candidates.push(DEFAULT_AGENT_ID);
    }

    const stores: Array<{
      agentId: string;
      storePath: string;
      entries: Record<string, SessionEntry>;
    }> = [];
    for (const agentId of candidates) {
      const storePath = path.join(agentsDir, agentId, "sessions", "sessions.json");
      const raw = await fsPromises.readFile(storePath, "utf-8").catch(() => null);
      if (!raw?.trim()) {
        continue;
      }
      const parsed = safeJsonParseLine<Record<string, SessionEntry>>(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      stores.push({ agentId, storePath, entries: parsed });
    }
    if (stores.length > 0) {
      return stores;
    }

    const legacyStorePath = path.join(this.stateDir, "sessions", "sessions.json");
    const legacyRaw = await fsPromises.readFile(legacyStorePath, "utf-8").catch(() => null);
    if (!legacyRaw?.trim()) {
      return stores;
    }
    const legacyParsed = safeJsonParseLine<Record<string, SessionEntry>>(legacyRaw);
    if (!legacyParsed || typeof legacyParsed !== "object" || Array.isArray(legacyParsed)) {
      return stores;
    }
    stores.push({
      agentId: DEFAULT_AGENT_ID,
      storePath: legacyStorePath,
      entries: legacyParsed,
    });
    return stores;
  }

  private async resolveBackfillTimestamp(params: {
    sessionId: string;
    storePath: string;
    sessionFile?: string;
    agentId: string;
    updatedAt?: number;
  }): Promise<number | null> {
    let latestTs = toValidTimestamp(params.updatedAt) ?? 0;
    for (const candidate of resolveSessionTranscriptCandidates(
      params.sessionId,
      params.storePath,
      params.sessionFile,
      params.agentId,
    )) {
      const stat = await fsPromises.stat(candidate).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      latestTs = Math.max(latestTs, Math.floor(stat.mtimeMs));
      break;
    }
    return latestTs > 0 ? latestTs : null;
  }

  private async findSummaryByRunId(runId: string): Promise<TaskRunSummary | null> {
    const active = this.activeRuns.get(runId);
    if (active) {
      return cloneSummary(active.summary);
    }
    const persisted = await this.readIndexSummaries();
    const match = persisted.find((entry) => entry.runId === runId);
    return match ? cloneSummary(match) : null;
  }

  private async ensureInitialized() {
    if (this.initialized) {
      return;
    }
    await fsPromises.mkdir(this.runsDir, { recursive: true, mode: 0o700 });
    await fsPromises.mkdir(this.archiveDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.indexPath)) {
      await fsPromises.writeFile(this.indexPath, "", { encoding: "utf-8", mode: 0o600 });
    }
    const existing = await this.readIndexSummaries();
    for (const entry of existing) {
      this.persistedRunIds.add(entry.runId);
    }
    this.initialized = true;
  }

  private ensureActiveRun(runId: string, event: AgentEventPayload): ActiveRun {
    const existing = this.activeRuns.get(runId);
    if (existing) {
      const eventSessionKey = toNonEmptyString(event.sessionKey) ?? undefined;
      if (!existing.summary.sessionKey && eventSessionKey) {
        existing.summary.sessionKey = eventSessionKey;
        existing.detail.sessionKey = eventSessionKey;
      }
      return existing;
    }

    const sourceResolved = detectTaskSource(toNonEmptyString(event.sessionKey) ?? undefined);
    const startedAtCandidate =
      typeof event.data?.startedAt === "number" && Number.isFinite(event.data.startedAt)
        ? Math.max(0, Math.floor(event.data.startedAt))
        : event.ts;
    const sessionKey = toNonEmptyString(event.sessionKey) ?? undefined;
    const title = truncateText(maskSensitiveString(sourceResolved.titleHint ?? "Task run"), 120);

    const summary: TaskRunSummary = {
      runId,
      source: sourceResolved.source,
      status: "running",
      title,
      preview: "",
      sessionKey,
      startedAt: startedAtCandidate,
      updatedAt: event.ts,
      toolCalls: 0,
      assistantMessages: 0,
    };

    const triggerNode: TaskNode = {
      id: "trigger",
      type: "trigger",
      label: "Trigger",
      status: "running",
      startedAt: startedAtCandidate,
      summary: `Source: ${summary.source}`,
    };
    const planNode: TaskNode = {
      id: "plan",
      type: "plan",
      label: "Plan",
      status: "running",
      startedAt: startedAtCandidate,
      summary: "Planning execution flow",
    };

    const detail: TaskRunDetail = {
      ...summary,
      nodes: [triggerNode, planNode],
      edges: [{ from: triggerNode.id, to: planNode.id, type: "sequence" }],
      timeline: [
        {
          at: event.ts,
          nodeId: "trigger",
          phase: "start",
          level: "info",
          text: `Task started from ${summary.source}`,
        },
      ],
    };

    const activeRun: ActiveRun = {
      summary,
      detail,
      nodeById: new Map([
        [triggerNode.id, triggerNode],
        [planNode.id, planNode],
      ]),
      edgeKeys: new Set([`${triggerNode.id}|${planNode.id}|sequence`]),
      toolNodeByCallId: new Map(),
      lastNodeId: "plan",
      finalized: false,
      hadError: false,
    };

    this.activeRuns.set(runId, activeRun);
    return activeRun;
  }

  private markPlanAsResolved(run: ActiveRun, at: number) {
    const planNode = run.nodeById.get("plan");
    if (!planNode || planNode.status !== "running") {
      return;
    }
    this.finishNode(planNode, "success", at);
  }

  private upsertNode(params: {
    run: ActiveRun;
    id: string;
    type: TaskNodeType;
    label: string;
    status: TaskStatus;
    startedAt: number;
    summary?: string;
    connectFrom?: string;
    edgeType?: TaskEdgeType;
  }): TaskNode {
    const existing = params.run.nodeById.get(params.id);
    if (existing) {
      existing.label = params.label;
      existing.status = params.status;
      existing.summary = params.summary;
      existing.startedAt = Math.min(existing.startedAt, params.startedAt);
      params.run.summary.updatedAt = Math.max(params.run.summary.updatedAt, params.startedAt);
      params.run.detail.updatedAt = params.run.summary.updatedAt;
      return existing;
    }

    const node: TaskNode = {
      id: params.id,
      type: params.type,
      label: params.label,
      status: params.status,
      startedAt: params.startedAt,
      summary: params.summary,
    };
    params.run.nodeById.set(node.id, node);
    params.run.detail.nodes.push(node);

    const from = params.connectFrom ?? params.run.lastNodeId;
    const edgeType = params.edgeType ?? "sequence";
    if (from && from !== node.id) {
      this.addEdge(params.run, {
        from,
        to: node.id,
        type: edgeType,
      });
    }

    params.run.lastNodeId = node.id;
    params.run.summary.updatedAt = Math.max(params.run.summary.updatedAt, params.startedAt);
    params.run.detail.updatedAt = params.run.summary.updatedAt;
    return node;
  }

  private addEdge(run: ActiveRun, edge: TaskEdge) {
    const key = `${edge.from}|${edge.to}|${edge.type}`;
    if (run.edgeKeys.has(key)) {
      return;
    }
    run.edgeKeys.add(key);
    run.detail.edges.push(edge);
  }

  private finishNode(node: TaskNode, status: TaskStatus, endedAt: number, summary?: string) {
    node.status = status;
    node.endedAt = endedAt;
    node.durationMs = Math.max(0, endedAt - node.startedAt);
    if (summary != null) {
      node.summary = summary;
    }
  }

  private pushTimeline(run: ActiveRun, entry: TaskTimelineEntry) {
    const masked = {
      ...entry,
      text: truncateText(maskSensitiveString(entry.text), 320),
    };
    run.detail.timeline.push(masked);
    if (run.detail.timeline.length > MAX_TIMELINE_ENTRIES) {
      run.detail.timeline.splice(0, run.detail.timeline.length - MAX_TIMELINE_ENTRIES);
    }
    run.summary.updatedAt = Math.max(run.summary.updatedAt, entry.at);
    run.detail.updatedAt = run.summary.updatedAt;
  }

  private updatePreview(run: ActiveRun, preview: string) {
    const next = truncateText(maskSensitiveString(preview), 220);
    if (!next) {
      return;
    }
    run.summary.preview = next;
    run.detail.preview = next;
  }

  private ingestLifecycle(run: ActiveRun, event: AgentEventPayload) {
    const phase = toNonEmptyString(event.data?.phase)?.toLowerCase();
    const startedAt =
      typeof event.data?.startedAt === "number" && Number.isFinite(event.data.startedAt)
        ? Math.max(0, Math.floor(event.data.startedAt))
        : event.ts;

    if (phase === "start") {
      run.summary.startedAt = Math.min(run.summary.startedAt, startedAt);
      run.detail.startedAt = run.summary.startedAt;
      const triggerNode = run.nodeById.get("trigger");
      if (triggerNode) {
        triggerNode.startedAt = Math.min(triggerNode.startedAt, startedAt);
        this.finishNode(
          triggerNode,
          "success",
          event.ts,
          `Started at ${new Date(startedAt).toISOString()}`,
        );
      }
      this.pushTimeline(run, {
        at: event.ts,
        nodeId: "trigger",
        phase: "start",
        level: "info",
        text: "Lifecycle start",
      });
      return;
    }

    if (phase === "fallback" || phase === "fallback_cleared") {
      this.markPlanAsResolved(run, event.ts);
      const activeModel = summarizeUnknown(event.data?.activeModel ?? event.data?.toModel, 100);
      const selectedModel = summarizeUnknown(
        event.data?.selectedModel ?? event.data?.fromModel,
        100,
      );
      const fallbackNode = this.upsertNode({
        run,
        id: "plan:fallback",
        type: "plan",
        label: phase === "fallback" ? "Model fallback" : "Fallback cleared",
        status: "running",
        startedAt: event.ts,
        summary:
          phase === "fallback"
            ? `Selected ${selectedModel || "n/a"} -> active ${activeModel || "n/a"}`
            : "Model returned to selected target",
      });
      this.finishNode(fallbackNode, "success", event.ts, fallbackNode.summary);
      this.pushTimeline(run, {
        at: event.ts,
        nodeId: fallbackNode.id,
        phase,
        level: "warn",
        text: fallbackNode.summary ?? "fallback event",
      });
      return;
    }

    const terminalStatus = resolveTerminalStatus(event);
    if (!terminalStatus) {
      if (phase) {
        this.pushTimeline(run, {
          at: event.ts,
          nodeId: run.lastNodeId,
          phase,
          level: "info",
          text: `Lifecycle: ${phase}`,
        });
      }
      return;
    }

    const endedAt =
      typeof event.data?.endedAt === "number" && Number.isFinite(event.data.endedAt)
        ? Math.max(0, Math.floor(event.data.endedAt))
        : event.ts;
    const errorText = summarizeUnknown(event.data?.error, 220);
    const preview =
      terminalStatus === "error"
        ? errorText || "Task failed"
        : terminalStatus === "timeout"
          ? "Task timed out"
          : run.summary.preview || "Task completed";

    this.finalizeRun(run, {
      status: terminalStatus,
      endedAt,
      preview,
      errorText: terminalStatus === "error" ? errorText : undefined,
    });
  }

  private ingestAssistant(run: ActiveRun, event: AgentEventPayload) {
    this.markPlanAsResolved(run, event.ts);
    run.summary.assistantMessages += 1;
    run.detail.assistantMessages = run.summary.assistantMessages;

    const text = summarizeUnknown(event.data?.text, 300);
    const node = this.upsertNode({
      run,
      id: "assistant",
      type: "assistant",
      label: "Assistant",
      status: "running",
      startedAt: event.ts,
      summary: text || "Assistant output",
    });
    if (text) {
      this.updatePreview(run, text);
    }

    this.pushTimeline(run, {
      at: event.ts,
      nodeId: node.id,
      phase: "assistant",
      level: "info",
      text: text || "Assistant output",
    });

    this.onTaskEvent?.({
      type: "task.update",
      runId: run.summary.runId,
      status: toSimplifiedStatus(run.summary.status),
      streamText: text || undefined,
    });
  }

  private ingestTool(run: ActiveRun, event: AgentEventPayload) {
    this.markPlanAsResolved(run, event.ts);
    const phase = toNonEmptyString(event.data?.phase)?.toLowerCase() ?? "tool";
    const toolCallId = toNonEmptyString(event.data?.toolCallId) ?? `tool:${event.seq}`;
    const toolName = toNonEmptyString(event.data?.name) ?? "tool";
    const nodeId = run.toolNodeByCallId.get(toolCallId) ?? `tool:${toolCallId}`;

    const isError =
      event.data?.isError === true ||
      phase === "error" ||
      phase === "failed" ||
      phase === "abort" ||
      phase === "aborted";

    const argsSummary = summarizeUnknown(event.data?.args, 220);
    const resultSummary = summarizeUnknown(
      event.data?.result ?? event.data?.partialResult ?? event.data?.error,
      240,
    );

    const summaryText = [argsSummary, resultSummary].filter(Boolean).join(" -> ");

    const node = this.upsertNode({
      run,
      id: nodeId,
      type: "tool",
      label: toolName,
      status: isError ? "error" : "running",
      startedAt: event.ts,
      summary: summaryText || `${toolName} ${phase}`,
      edgeType: phase === "result" && isError ? "retry" : "sequence",
    });
    run.toolNodeByCallId.set(toolCallId, nodeId);

    if (phase === "start") {
      run.summary.toolCalls += 1;
      run.detail.toolCalls = run.summary.toolCalls;
    }

    if (phase === "result" || phase === "error" || phase === "failed" || phase === "aborted") {
      this.finishNode(node, isError ? "error" : "success", event.ts, node.summary);
      if (isError) {
        run.hadError = true;
        this.updatePreview(run, resultSummary || `${toolName} failed`);
      } else if (resultSummary) {
        this.updatePreview(run, resultSummary);
      }
    }

    this.pushTimeline(run, {
      at: event.ts,
      nodeId: node.id,
      phase,
      level: isError ? "error" : "info",
      text: `${toolName} ${phase}${resultSummary ? `: ${resultSummary}` : ""}`,
    });

    this.onTaskEvent?.({
      type: "task.update",
      runId: run.summary.runId,
      status: toSimplifiedStatus(run.summary.status),
      entry: { tool: toolName, phase, text: summaryText || undefined },
    });
  }

  private finalizeRun(
    run: ActiveRun,
    params: {
      status: TaskStatus;
      endedAt: number;
      preview: string;
      errorText?: string;
    },
  ) {
    if (run.finalized) {
      return;
    }

    run.finalized = true;
    run.summary.status = params.status;
    run.detail.status = params.status;
    run.summary.endedAt = params.endedAt;
    run.detail.endedAt = params.endedAt;
    run.summary.durationMs = Math.max(0, params.endedAt - run.summary.startedAt);
    run.detail.durationMs = run.summary.durationMs;
    run.summary.updatedAt = Math.max(run.summary.updatedAt, params.endedAt);
    run.detail.updatedAt = run.summary.updatedAt;

    const finalizeNode = this.upsertNode({
      run,
      id: "finalize",
      type: "finalize",
      label: "Finalize",
      status: params.status,
      startedAt: params.endedAt,
      summary: params.preview,
    });
    this.finishNode(finalizeNode, params.status, params.endedAt, params.preview);

    const assistantNode = run.nodeById.get("assistant");
    if (assistantNode && !assistantNode.endedAt) {
      const assistantStatus: TaskStatus = run.hadError ? "error" : "success";
      this.finishNode(assistantNode, assistantStatus, params.endedAt, assistantNode.summary);
    }

    const planNode = run.nodeById.get("plan");
    if (planNode && !planNode.endedAt) {
      this.finishNode(
        planNode,
        run.hadError ? "error" : "success",
        params.endedAt,
        planNode.summary,
      );
    }

    for (const node of run.detail.nodes) {
      if (!node.endedAt && node.id !== "finalize") {
        this.finishNode(
          node,
          node.status === "running" ? run.summary.status : node.status,
          params.endedAt,
          node.summary,
        );
      }
    }

    this.updatePreview(run, params.preview);

    this.pushTimeline(run, {
      at: params.endedAt,
      nodeId: "finalize",
      phase: params.status,
      level: params.status === "error" ? "error" : params.status === "timeout" ? "warn" : "info",
      text: params.errorText
        ? `Finished with error: ${params.errorText}`
        : `Finished with status ${params.status}`,
    });

    const detail = cloneDetail(run.detail);
    const summary = cloneSummary(run.summary);
    this.activeRuns.delete(run.summary.runId);
    this.cacheRecentDetail(detail);
    this.persistRun(summary, detail);
    this.metrics.task_trace_runs_completed += 1;

    this.onTaskEvent?.({
      type: "task.status",
      runId: run.summary.runId,
      status: toSimplifiedStatus(params.status),
    });
  }

  private cacheRecentDetail(detail: TaskRunDetail) {
    this.recentDetailByRun.set(detail.runId, cloneDetail(detail));
    const maxEntries = 400;
    if (this.recentDetailByRun.size <= maxEntries) {
      return;
    }
    const keys = Array.from(this.recentDetailByRun.keys());
    for (const key of keys.slice(0, this.recentDetailByRun.size - maxEntries)) {
      this.recentDetailByRun.delete(key);
    }
  }

  private persistRun(summary: TaskRunSummary, detail: TaskRunDetail) {
    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.ensureInitialized();
        const runId = summary.runId;
        const runFile = path.join(this.runsDir, `${runId}.json`);
        const runTmp = `${runFile}.${process.pid}.tmp`;
        await fsPromises.writeFile(runTmp, JSON.stringify(detail), {
          encoding: "utf-8",
          mode: 0o600,
        });
        await fsPromises.rename(runTmp, runFile);

        if (!this.persistedRunIds.has(runId)) {
          const line = `${JSON.stringify(summary)}\n`;
          await fsPromises.appendFile(this.indexPath, line, { encoding: "utf-8", mode: 0o600 });
          this.persistedRunIds.add(runId);
        } else {
          await this.rewriteSummary(summary);
        }
      })
      .catch((err) => {
        this.metrics.task_trace_persist_failures += 1;
        this.options.log.warn(`task traces: persist failed: ${String(err)}`);
      })
      .then(() => this.runArchivePass());
  }

  private async rewriteSummary(nextSummary: TaskRunSummary) {
    const existing = await this.readIndexSummaries();
    const merged = dedupeSummariesByRun([...existing, nextSummary]);
    await this.writeIndexSummaries(merged);
  }

  private async loadAllSummaries(): Promise<TaskRunSummary[]> {
    const persisted = await this.readIndexSummaries();
    const active = Array.from(this.activeRuns.values()).map((entry) => cloneSummary(entry.summary));
    const merged = dedupeSummariesByRun([...persisted, ...active]);
    return merged;
  }

  private async readIndexSummaries(): Promise<TaskRunSummary[]> {
    const raw = await fsPromises.readFile(this.indexPath, "utf-8").catch(() => "");
    const parsed = parseJsonl<TaskRunSummary>(raw);
    return dedupeSummariesByRun(parsed);
  }

  private async writeIndexSummaries(entries: TaskRunSummary[]) {
    const normalized = dedupeSummariesByRun(entries);
    const sorted = normalized.toSorted((a, b) => {
      const left = a.startedAt || a.updatedAt || 0;
      const right = b.startedAt || b.updatedAt || 0;
      return left - right;
    });
    const body = sorted.map((entry) => JSON.stringify(entry)).join("\n");
    const payload = body ? `${body}\n` : "";
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmp, payload, { encoding: "utf-8", mode: 0o600 });
    await fsPromises.rename(tmp, this.indexPath);
  }

  private async runArchivePass() {
    if (this.archiveRunning || !this.initialized) {
      return;
    }
    this.archiveRunning = true;
    try {
      const now = Date.now();
      const cutoff = now - this.retentionMs;
      const summaries = await this.readIndexSummaries();
      if (summaries.length === 0) {
        return;
      }
      const hot: TaskRunSummary[] = [];
      const cold: TaskRunSummary[] = [];
      for (const summary of summaries) {
        const pivotTs = summary.endedAt ?? summary.startedAt ?? summary.updatedAt;
        if (pivotTs >= cutoff) {
          hot.push(summary);
        } else {
          cold.push(summary);
        }
      }

      if (cold.length === 0) {
        return;
      }

      const byMonth = new Map<string, TaskRunSummary[]>();
      for (const entry of cold) {
        const pivotTs = entry.endedAt ?? entry.startedAt ?? entry.updatedAt;
        const month = monthKeyFromTimestamp(pivotTs);
        const list = byMonth.get(month);
        if (list) {
          list.push(entry);
        } else {
          byMonth.set(month, [entry]);
        }
      }

      for (const [month, items] of byMonth) {
        await this.appendArchiveMonth(month, items);
      }

      await this.writeIndexSummaries(hot);
      await this.pruneDetailFiles(cutoff);
      this.metrics.task_trace_archive_jobs += 1;
    } catch (err) {
      this.options.log.warn(`task traces: archive pass failed: ${String(err)}`);
    } finally {
      this.archiveRunning = false;
    }
  }

  private async appendArchiveMonth(month: string, summaries: TaskRunSummary[]) {
    const archivePath = path.join(this.archiveDir, `${month}.jsonl.gz`);
    const existing = await this.readArchiveFile(archivePath);
    const merged = dedupeSummariesByRun([...existing, ...summaries]);
    const body = merged.map((entry) => JSON.stringify(entry)).join("\n");
    const encoded = gzipSync(body ? `${body}\n` : "");
    const tmp = `${archivePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmp, encoded, { mode: 0o600 });
    await fsPromises.rename(tmp, archivePath);
  }

  private async readArchiveFile(archivePath: string): Promise<TaskRunSummary[]> {
    const buf = await fsPromises.readFile(archivePath).catch(() => null);
    if (!buf || buf.length === 0) {
      return [];
    }
    try {
      const text = gunzipSync(buf).toString("utf-8");
      return dedupeSummariesByRun(parseJsonl<TaskRunSummary>(text));
    } catch {
      return [];
    }
  }

  private async pruneDetailFiles(cutoffTs: number) {
    const names = await fsPromises.readdir(this.runsDir).catch(() => []);
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(this.runsDir, name);
      try {
        const stat = await fsPromises.stat(filePath);
        if (!stat.isFile()) {
          continue;
        }
        if (stat.mtimeMs < cutoffTs) {
          await fsPromises.unlink(filePath).catch(() => {});
        }
      } catch {
        // Ignore best-effort cleanup errors.
      }
    }
  }
}
