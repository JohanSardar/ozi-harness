type Item = {
  itemId: string;
  text: string | null;
  textTruncated: boolean;
  nextTextOffset?: number | null;
};
type History = {
  thread: {
    threadId: string;
    activeRunId: string | null;
    pendingRequestCount: number;
    latestRunId: string | null;
  };
  recentRuns: { runId: string; status: string }[];
  items: Item[];
  hasMore: boolean;
  nextPosition: number | null;
};

const maxReads = 100;
const maxCharacters = 500_000;

export async function workerHistory(
  threadId: string,
  call: (input: Record<string, unknown>) => Promise<unknown>,
) {
  let reads = 0;
  let characters = 0;
  const read = async (input: Record<string, unknown>) => {
    const value = (await call({
      threadId,
      view: "activity",
      limit: 100,
      maxCharsPerItem: Math.min(50_000, maxCharacters - characters),
      ...input,
    })) as History;
    reads++;
    if (!value?.thread || !Array.isArray(value.items) || !Array.isArray(value.recentRuns))
      throw new Error("invalid-worker-history");
    const { thread, recentRuns } = value;
    if (
      thread.threadId !== threadId ||
      thread.activeRunId ||
      thread.pendingRequestCount ||
      !recentRuns.some((run) => run.runId === thread.latestRunId && run.status === "completed")
    )
      throw new Error("worker-not-completed");
    return value;
  };
  let page = await read({});
  const source = { ...page, items: [] as Item[] };
  const limited = () => ({
    ...source,
    hasMore: true,
    evidenceLimit: `Worker history limited after ${reads} reads and ${characters} text characters (caps: ${maxReads} reads, ${maxCharacters} characters). Some history is omitted. Judge only the supplied evidence and identify any limits on verification.`,
  });
  let position = -1;
  for (;;) {
    for (const original of page.items) {
      if (characters >= maxCharacters) return limited();
      const item = { ...original };
      source.items.push(item);
      let part = original;
      let offset = 0;
      for (;;) {
        if (part.text !== null && typeof part.text !== "string")
          throw new Error("invalid-worker-history");
        const chunk = part.text?.slice(0, maxCharacters - characters) ?? null;
        item.text = offset === 0 ? chunk : (item.text ?? "") + (chunk ?? "");
        characters += chunk?.length ?? 0;
        item.textTruncated = part.textTruncated || chunk !== part.text;
        item.nextTextOffset = part.nextTextOffset ?? null;
        if (!item.textTruncated) break;
        if (reads >= maxReads || characters >= maxCharacters) return limited();
        const next = part.nextTextOffset;
        if (typeof next !== "number" || !Number.isInteger(next) || next <= offset)
          throw new Error("invalid-worker-history");
        const continuation = await read({ itemId: item.itemId, textOffset: next });
        const continued = continuation.items.find((entry) => entry.itemId === item.itemId);
        if (!continued) throw new Error("invalid-worker-history");
        part = continued;
        offset = next;
      }
    }
    source.hasMore = page.hasMore;
    source.nextPosition = page.nextPosition;
    if (!page.hasMore) return source;
    if (reads >= maxReads || characters >= maxCharacters) return limited();
    const next = page.nextPosition;
    if (typeof next !== "number" || !Number.isInteger(next) || next <= position)
      throw new Error("invalid-worker-history");
    position = next;
    page = await read({ afterPosition: next });
  }
}
