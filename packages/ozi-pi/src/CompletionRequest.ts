import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import { textOf } from "./repair.ts";

const Request = Schema.Struct({ id: Schema.NonEmptyString, text: Schema.String });
const isRequest = Schema.is(Request);

export function completionRequest(branch: readonly SessionEntry[]) {
  const anchor = branch.findLast(
    (entry) => entry.type === "custom" && entry.customType === "ozi-request",
  );
  if (anchor?.type === "custom" && isRequest(anchor.data)) return anchor.data;
  const user = branch.findLast(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  return user ? { id: user.id, text: textOf(user) } : undefined;
}
