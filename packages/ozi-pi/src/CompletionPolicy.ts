import * as Schema from "effect/Schema";

export const verdictText = (text: string) =>
  [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```/g)].at(-1)?.[1] ?? text;

export const Verdict = Schema.Union([
  Schema.Struct({ verdict: Schema.Literal("done"), useful: Schema.Boolean }),
  Schema.Struct({
    verdict: Schema.Literal("continue"),
    missing: Schema.NonEmptyString,
    evidence: Schema.Array(Schema.String),
    useful: Schema.Boolean,
  }),
  Schema.Struct({
    verdict: Schema.Literal("needs_user"),
    reason: Schema.NonEmptyString,
    useful: Schema.Boolean,
  }),
]);
export type Verdict = typeof Verdict.Type;

export function settle(
  verdict: Verdict | null,
  previous: number,
  progress: boolean,
  superseded = false,
) {
  const unsuccessfulRounds = superseded
    ? previous
    : verdict?.verdict === "done" || progress
      ? 0
      : previous + 1;
  const state = superseded
    ? "superseded"
    : verdict?.verdict === "done"
      ? "checked"
      : verdict?.verdict === "needs_user"
        ? "needs_user"
        : unsuccessfulRounds >= 3
          ? "blocked"
          : verdict?.verdict === "continue"
            ? "continued"
            : "checking";
  return { state, unsuccessfulRounds } as const;
}
