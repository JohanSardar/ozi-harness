import * as NodeHttp from "node:http";

export async function startCompletionMcp(worker: () => unknown) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const tickets: Record<string, unknown>[] = [];
  const server = NodeHttp.createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id == null) {
      response.writeHead(202);
      response.end();
      return;
    }
    let result: unknown = {};
    if (message.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "ozi", version: "1" },
      };
    if (message.method === "tools/list")
      result = {
        tools: [
          "ozi_thread_read",
          "ozi_thread_send",
          "delegate_task",
          "ticket_create",
          "ticket_update",
          "ticket_list",
          "ticket_close",
        ].map((name) => ({
          name,
          description: name,
          inputSchema: { type: "object", additionalProperties: true },
        })),
      };
    if (message.method === "tools/call") {
      const { name, arguments: input } = message.params;
      calls.push({ name, input });
      let value: unknown;
      if (name === "ozi_thread_read") value = worker();
      else if (name === "ticket_list") value = { tickets };
      else if (name === "ticket_create") {
        value = { ...input, id: `ticket-${tickets.length + 1}`, status: "open" };
        tickets.push(value as Record<string, unknown>);
      } else if (name === "ticket_update") {
        value = { ...input.changes, id: input.id, status: "open" };
        tickets.push(value as Record<string, unknown>);
      } else value = { sent: true };
      result = { content: [{ type: "text", text: JSON.stringify(value) }] };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No MCP endpoint");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    tickets,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
