import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const TaskSourceSchema = Type.Union([
  Type.Literal("chat"),
  Type.Literal("cron"),
  Type.Literal("whatsapp"),
  Type.Literal("telegram"),
  Type.Literal("discord"),
  Type.Literal("signal"),
  Type.Literal("imessage"),
  Type.Literal("unknown"),
]);

const TaskSourceFilterSchema = Type.Union([TaskSourceSchema, Type.Literal("all")]);

const TaskStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("success"),
  Type.Literal("error"),
  Type.Literal("aborted"),
  Type.Literal("timeout"),
]);

const TaskStatusFilterSchema = Type.Union([TaskStatusSchema, Type.Literal("all")]);

const TaskNodeTypeSchema = Type.Union([
  Type.Literal("trigger"),
  Type.Literal("plan"),
  Type.Literal("tool"),
  Type.Literal("assistant"),
  Type.Literal("finalize"),
]);

const TaskEdgeTypeSchema = Type.Union([
  Type.Literal("sequence"),
  Type.Literal("branch"),
  Type.Literal("retry"),
]);

export const TaskRunSummarySchema = Type.Object(
  {
    runId: NonEmptyString,
    source: TaskSourceSchema,
    status: TaskStatusSchema,
    title: Type.String(),
    preview: Type.String(),
    sessionKey: Type.Optional(Type.String()),
    startedAt: Type.Integer({ minimum: 0 }),
    endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAt: Type.Integer({ minimum: 0 }),
    toolCalls: Type.Integer({ minimum: 0 }),
    assistantMessages: Type.Integer({ minimum: 0 }),
    detailPartial: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const TaskNodeSchema = Type.Object(
  {
    id: NonEmptyString,
    type: TaskNodeTypeSchema,
    label: Type.String(),
    status: TaskStatusSchema,
    startedAt: Type.Integer({ minimum: 0 }),
    endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    summary: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TaskEdgeSchema = Type.Object(
  {
    from: NonEmptyString,
    to: NonEmptyString,
    type: TaskEdgeTypeSchema,
  },
  { additionalProperties: false },
);

export const TaskTimelineEntrySchema = Type.Object(
  {
    at: Type.Integer({ minimum: 0 }),
    nodeId: NonEmptyString,
    phase: Type.String(),
    level: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")]),
    text: Type.String(),
  },
  { additionalProperties: false },
);

export const TaskRunDetailSchema = Type.Intersect([
  TaskRunSummarySchema,
  Type.Object(
    {
      nodes: Type.Array(TaskNodeSchema),
      edges: Type.Array(TaskEdgeSchema),
      timeline: Type.Array(TaskTimelineEntrySchema),
    },
    { additionalProperties: false },
  ),
]);

export const TasksListParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    source: Type.Optional(TaskSourceFilterSchema),
    status: Type.Optional(TaskStatusFilterSchema),
    query: Type.Optional(Type.String()),
    fromTs: Type.Optional(Type.Integer({ minimum: 0 })),
    toTs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const TasksListResultSchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
    total: Type.Integer({ minimum: 0 }),
    hasMore: Type.Boolean(),
    nextCursor: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    items: Type.Array(TaskRunSummarySchema),
  },
  { additionalProperties: false },
);

export const TasksGetParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const TasksGetResultSchema = Type.Object(
  {
    run: TaskRunDetailSchema,
  },
  { additionalProperties: false },
);

/* ── Simplified schemas (Task UI v2) ─────────────────────────── */

const SimplifiedTaskStatusSchema = Type.Unsafe<"queued" | "running" | "done" | "failed">({
  type: "string",
  enum: ["queued", "running", "done", "failed"],
});

export const TaskStepSchema = Type.Object(
  {
    tool: Type.String(),
    result: Type.String(),
    phase: Type.String(),
  },
  { additionalProperties: false },
);

export const SimplifiedTaskRunSummarySchema = Type.Object(
  {
    runId: NonEmptyString,
    source: TaskSourceSchema,
    status: SimplifiedTaskStatusSchema,
    title: Type.String(),
    preview: Type.String(),
    startedAt: Type.Integer({ minimum: 0 }),
    endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAt: Type.Integer({ minimum: 0 }),
    errorReason: Type.Optional(Type.String()),
    cronId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SimplifiedTaskRunDetailSchema = Type.Intersect([
  SimplifiedTaskRunSummarySchema,
  Type.Object(
    {
      summary: Type.String(),
      steps: Type.Array(TaskStepSchema),
    },
    { additionalProperties: false },
  ),
]);
