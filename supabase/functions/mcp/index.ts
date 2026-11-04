// MCP server Edge Function: https://<project-ref>.supabase.co/functions/v1/mcp[/<MCP_PATH_SECRET>]
//
// When the MCP_PATH_SECRET secret is set, the endpoint only answers on /mcp/<secret>, which keeps
// it private during the Developer Mode phase. Unset it to make the endpoint public.
import { createMcpHandler } from "../_shared/mcp.ts";
import { buildTools, SERVER_INSTRUCTIONS } from "../_shared/tools.ts";
import { safeEqual, supabaseBackend } from "../_shared/supabase.ts";

const handler = createMcpHandler({
  name: "wit-ai-search",
  title: "WiT Article Search",
  version: "0.1.0",
  instructions: SERVER_INSTRUCTIONS,
  tools: buildTools(supabaseBackend()),
  onError: (err, ctx) => console.error(`[mcp] ${ctx}:`, err),
});

const pathSecret = Deno.env.get("MCP_PATH_SECRET") ?? "";

Deno.serve((req) => {
  // pathname is "/mcp", "/mcp/<secret>" (or with a /functions/v1 prefix, depending on the router).
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  const rest = segments.slice(segments.indexOf("mcp") + 1);
  const presented = rest[0] ?? "";
  if (pathSecret ? !safeEqual(presented, pathSecret) : rest.length > 0) {
    return new Response("Not Found", { status: 404 });
  }
  return handler(req);
});
