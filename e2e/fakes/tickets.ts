import * as NodeHttp from "node:http";

export async function startTickets() {
  const tickets: Record<string, unknown>[] = [];
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const content = {
    group: { type: "string", enum: ["Decide", "Do", "Review", "Read"] },
    title: { type: "string" },
    need: { type: "string" },
    summary: { type: "string" },
    markdown: { type: "string" },
    choices: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: { label: { type: "string" }, detail: { type: "string" } },
        required: ["label", "detail"],
      },
    },
    attachments: { type: "array", items: { type: "object" } },
    htmlPages: { type: "array", items: { type: "object" } },
  };
  const id = { type: "string" };
  const schemas: Record<string, unknown> = {
    ticket_create: { type: "object", properties: content, required: Object.keys(content) },
    ticket_update: {
      type: "object",
      properties: { id, changes: { type: "object", properties: content } },
      required: ["id", "changes"],
    },
    ticket_close: { type: "object", properties: { id }, required: ["id"] },
    ticket_list: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "archived", "all"] },
        search: { type: "string" },
        chatId: { type: "string" },
      },
    },
  };
  const tools = ["ticket_create", "ticket_update", "ticket_close", "ticket_list"].map((name) => ({
    name,
    description: name.replaceAll("_", " "),
    inputSchema: schemas[name],
  }));
  const server = NodeHttp.createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (input.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown = {};
    if (input.method === "initialize")
      result = {
        protocolVersion: input.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "tickets", version: "1" },
      };
    if (input.method === "tools/list") result = { tools };
    if (input.method === "tools/call") {
      const call = input.params as (typeof calls)[number];
      calls.push(call);
      let value: unknown = tickets;
      if (call.name === "ticket_create") {
        value = { ...call.arguments, id: "h3-ticket", status: "open" };
        tickets.push(value as Record<string, unknown>);
      }
      if (call.name === "ticket_close") {
        const ticket = tickets.find((ticket) => ticket.id === call.arguments.id);
        if (ticket) ticket.status = "archived";
        value = ticket;
      }
      if (call.name === "ticket_update") {
        const ticket = tickets.find((ticket) => ticket.id === call.arguments.id);
        if (ticket) Object.assign(ticket, call.arguments.changes);
        value = ticket;
      }
      if (call.name === "ticket_list")
        value = { tickets: tickets.filter((ticket) => ticket.status === "open") };
      result = { content: [{ type: "text", text: JSON.stringify(value) }] };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No ticket endpoint");
  return {
    url: `http://127.0.0.1:${address.port}`,
    tickets,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
