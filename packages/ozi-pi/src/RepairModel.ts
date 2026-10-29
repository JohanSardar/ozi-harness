import * as Schema from "effect/Schema";

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));

export const LogMistake = Schema.Struct({
  sourceEventId: text,
  correctionMessageId: Schema.optional(text),
  beforeUserMessageId: Schema.optional(text),
  fingerprint: text,
  what: text,
  why: text,
});
export type LogMistake = typeof LogMistake.Type;

export const MistakeStatus = Schema.Literals(["logged", "testing", "failed", "shipped", "undone"]);
export const Mistake = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  thread: Schema.String,
  boundary: Schema.NullOr(Schema.String),
  fingerprint: Schema.String,
  what: Schema.String,
  why: Schema.String,
  harness: Schema.String,
  status: MistakeStatus,
  source_event_id: Schema.String,
  trigger_event_id: Schema.NullOr(Schema.String),
});
export type Mistake = typeof Mistake.Type;

export const Replay = Schema.Struct({
  id: Schema.String,
  mistake_id: Schema.String,
  at: Schema.String,
  state: Schema.Literals(["pending", "running", "passed", "failed"]),
  reason: Schema.NullOr(Schema.String),
  case_json: Schema.NullOr(Schema.String),
  evidence_json: Schema.NullOr(Schema.String),
});
export type Replay = typeof Replay.Type;

export const Fix = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  commit_sha: Schema.String,
  predecessor: Schema.String,
  state: Schema.Literals(["publishing", "shipped", "undoing", "undone", "failed"]),
  before_head: Schema.NullOr(Schema.String),
  target: Schema.String,
  snapshot: Schema.String,
  paths_json: Schema.String,
  conflict: Schema.Number,
  checkpoint: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type Fix = typeof Fix.Type;

export class RepairError extends Schema.TaggedError<RepairError>()("OziRepairError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Repair ${this.reason}.`;
  }
}
