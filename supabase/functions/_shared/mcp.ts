// Minimal, stateless MCP server over Streamable HTTP (JSON responses, no SSE).
//
// It has no dependencies and uses only Web-standard Request/Response, so it runs unchanged
// on Supabase Edge (Deno) and in Node tests. It implements the subset a tools-only server
// needs: initialize, ping, tools/list, tools/call, and notifications.

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export type JsonSchema = Record<string, unknown>;

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface Tool {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ServerOptions {
  name: string;
  version: string;
  title?: string;
  instructions?: string;
  tools: Tool[];
  onError?: (err: unknown, context: string) => void;
}

/** Thrown by tool handlers for bad input. It is reported back to the model as a tool error. */
export class ToolInputError extends Error {}

type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function createMcpHandler(opts: ServerOptions): (req: Request) => Promise<Response> {
  const toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
  const toolList = opts.tools.map(({ handler: _h, ...meta }) => meta);

  async function handleMessage(msg: JsonRpcMessage): Promise<unknown | null> {
    const isNotification = msg.id === undefined;
    if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return isNotification ? null : rpcError(msg?.id ?? null, -32600, "Invalid Request");
    }
    if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...
    const id = msg.id as JsonRpcId;
    const params = msg.params ?? {};

    switch (msg.method) {
      case "initialize": {
        const requested = String(params.protocolVersion ?? "");
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: opts.name, title: opts.title, version: opts.version },
            ...(opts.instructions ? { instructions: opts.instructions } : {}),
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: toolList } };
      case "tools/call": {
        const name = String(params.name ?? "");
        const tool = toolsByName.get(name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (typeof args !== "object" || Array.isArray(args)) {
          return rpcError(id, -32602, "arguments must be an object");
        }
        try {
          return { jsonrpc: "2.0", id, result: await tool.handler(args) };
        } catch (err) {
          const message = err instanceof ToolInputError
            ? err.message
            : "The search service hit an internal error. Please try again.";
          if (!(err instanceof ToolInputError)) opts.onError?.(err, `tools/call ${name}`);
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: message }], isError: true },
          };
        }
      }
      // Empty answers for optional capabilities some clients probe.
      case "resources/list":
        return { jsonrpc: "2.0", id, result: { resources: [] } };
      case "prompts/list":
        return { jsonrpc: "2.0", id, result: { prompts: [] } };
      default:
        return rpcError(id, -32601, `Method not found: ${msg.method}`);
    }
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== "POST") {
      // Stateless server: no server-initiated SSE stream and no sessions to delete.
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST, OPTIONS", ...CORS_HEADERS },
      });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    if (Array.isArray(body)) {
      const replies = (await Promise.all(body.map((m) => handleMessage(m)))).filter((r) => r !== null);
      return replies.length ? json(replies) : new Response(null, { status: 202, headers: CORS_HEADERS });
    }
    const reply = await handleMessage(body as JsonRpcMessage);
    return reply === null ? new Response(null, { status: 202, headers: CORS_HEADERS }) : json(reply);
  };
}
