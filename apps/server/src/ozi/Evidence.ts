import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { mcpTools } from "./McpTools.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export { read, verify } from "@ozi/pi/Evidence";
import { EvidenceError } from "@ozi/pi/Evidence";

const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const action = Effect.fn("Evidence.action")(function* (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  id: string,
) {
  const item = items.find((item) => item.id === id);
  if (
    item?.type !== "dynamic_tool" ||
    item.status !== "completed" ||
    item.output == null ||
    typeof item.output !== "object" ||
    Array.isArray(item.output)
  )
    return yield* new EvidenceError({ detail: "No completed action receipt." });
  const name = item.toolName?.replace(/^(?:t3-code\.|mcp__t3-code__)/, "");
  const annotations = name ? mcpTools.get(name)?.annotations : undefined;
  const output = item.output as Record<string, unknown>;
  if (
    !annotations?.destructiveHint ||
    annotations.readOnlyHint ||
    output.error ||
    output.isError === true ||
    output.success === false
  )
    return yield* new EvidenceError({
      detail: "Evidence requires a successful action, not additional tool calls.",
    });
  const text = yield* encodeReceipt({ name, input: item.input, output: item.output });
  const digest = yield* (yield* Crypto.Crypto).digest("SHA-256", new TextEncoder().encode(text));
  return { evidence: `action:${item.id}:${Buffer.from(digest).toString("hex")}`, text };
});

export const verifyAction = (items: ReadonlyArray<OrchestrationV2TurnItem>, evidence: string) =>
  action(items, evidence.slice(7, evidence.lastIndexOf(":"))).pipe(
    Effect.map((result) => result.evidence === evidence),
    Effect.orElseSucceed(() => false),
  );
