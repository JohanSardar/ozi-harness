import * as NodeHttp from "node:http";

export type AnthropicRequest = {
  model: string;
  system: { text: string }[];
  tools: { name: string }[];
  messages: { role: string; content: unknown }[];
  output_config?: { effort?: string };
  speed?: string;
};

export type AnthropicReply =
  | { text: string }
  | { tool: string; arguments: Record<string, unknown> };

export async function startAnthropic(
  reply?: (input: AnthropicRequest) => AnthropicReply | Promise<AnthropicReply>,
) {
  const requests: AnthropicRequest[] = [];
  const headers: NodeHttp.IncomingHttpHeaders[] = [];
  const server = NodeHttp.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url?.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    if (!request.url?.startsWith("/v1/messages")) {
      response.writeHead(404);
      response.end();
      return;
    }
    const input = JSON.parse(body) as AnthropicRequest;
    requests.push(input);
    headers.push(request.headers);
    const tool = input.tools?.find((entry) => entry.name.endsWith("__read_skill"));
    const answer =
      (await reply?.(input)) ??
      (tool && !JSON.stringify(input.messages).includes('"tool_result"')
        ? { tool: tool.name, arguments: { name: "demo" } }
        : { text: "bridge-ok" });
    const useTool = "tool" in answer;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type: string, data: object) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit("message_start", {
      message: {
        id: `msg_${requests.length}`,
        type: "message",
        role: "assistant",
        model: input.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    });
    emit("content_block_start", {
      index: 0,
      content_block: useTool
        ? { type: "tool_use", id: `tool_${requests.length}`, name: answer.tool, input: {} }
        : { type: "text", text: "" },
    });
    emit("content_block_delta", {
      index: 0,
      delta: useTool
        ? { type: "input_json_delta", partial_json: JSON.stringify(answer.arguments) }
        : { type: "text_delta", text: answer.text },
    });
    emit("content_block_stop", { index: 0 });
    emit("message_delta", {
      delta: { stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 10 },
    });
    emit("message_stop", {});
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No Anthropic endpoint");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    headers,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
