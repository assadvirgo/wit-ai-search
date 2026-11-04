// Run: node --experimental-strip-types --test tests/mcp.test.ts   (Node >= 22.6)
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpHandler } from "../supabase/functions/_shared/mcp.ts";
import { type Backend, buildTools, type MatchParams } from "../supabase/functions/_shared/tools.ts";

const calls: MatchParams[] = [];
const backend: Backend = {
  embed: async (t) => Array(384).fill(t.length / 1000),
  matchChunks: async (p) => {
    calls.push(p);
    return [{
      chunk_id: 1, article_id: 375, score: 0.03,
      content: "Adapt to Google\n\nTourism entities that understand Google's latest algorithm...",
      title: "Adapt to Google", source_url: "https://www.webintravel.com/adapt/",
      published_at: "2014-03-06T19:22:44+00:00", author_name: "WiT",
      categories: ["Marketing"], tags: ["Google"],
    }];
  },
  getArticle: async (id, slug) =>
    id === 375 || slug === "adapt"
      ? {
        id: 375, title: "Adapt to Google", slug: "adapt", source_url: "https://www.webintravel.com/adapt/",
        published_at_gmt: "2014-03-06T19:22:44+00:00", modified_at_gmt: null, author_name: "WiT",
        excerpt: "x", content_text: "Full body", categories: ["Marketing"], tags: [],
      }
      : null,
  latestArticles: async () => [],
  categoryCounts: async () => [{ category: "Marketing", article_count: 31 }],
};

const handle = createMcpHandler({
  name: "t", version: "0", tools: buildTools(backend), onError: () => {},
});

async function rpc(method: string, params?: unknown, id: number | null = 1) {
  const res = await handle(new Request("http://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
  }));
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}

test("initialize negotiates protocol version", async () => {
  const { body } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } });
  assert.equal(body.result.protocolVersion, "2025-06-18");
  assert.ok(body.result.capabilities.tools);
  const unknown = await rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.body.result.protocolVersion, "2025-11-25");
});

test("notifications get 202, GET gets 405, bad JSON gets parse error", async () => {
  assert.equal((await rpc("notifications/initialized", undefined, null)).status, 202);
  assert.equal((await handle(new Request("http://x/mcp"))).status, 405);
  const bad = await handle(new Request("http://x/mcp", { method: "POST", body: "{" }));
  assert.equal((await bad.json()).error.code, -32700);
});

test("tools/list exposes read-only annotated tools without handlers", async () => {
  const { body } = await rpc("tools/list");
  const names = body.result.tools.map((t: { name: string }) => t.name);
  assert.deepEqual(names, ["search", "fetch", "latest_articles", "list_categories"]);
  for (const t of body.result.tools) {
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.annotations.openWorldHint, false);
    assert.equal(t.handler, undefined);
  }
});

test("search returns results JSON and maps date filters", async () => {
  const { body } = await rpc("tools/call", {
    name: "search", arguments: { query: "google seo", limit: 50, date_from: "2014", date_to: "2014-03" },
  });
  const data = JSON.parse(body.result.content[0].text);
  assert.equal(data.results[0].id, "375");
  assert.equal(data.results[0].url, "https://www.webintravel.com/adapt/");
  assert.ok(data.results[0].snippet.startsWith("Tourism"), "title prefix stripped");
  assert.deepEqual(body.result.structuredContent, data);
  const p = calls.at(-1)!;
  assert.equal(p.match_count, 20, "limit clamped");
  assert.equal(p.date_from, "2014-01-01T00:00:00.000Z");
  assert.equal(p.date_to, "2014-04-01T00:00:00.000Z", "month end is exclusive next month");
});

test("bad input becomes a tool error, not a protocol error", async () => {
  const { body } = await rpc("tools/call", { name: "search", arguments: { query: "x", date_from: "March" } });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /date_from/);
  const missing = await rpc("tools/call", { name: "nope", arguments: {} });
  assert.equal(missing.body.error.code, -32602);
});

test("fetch accepts id, slug or URL", async () => {
  for (const id of ["375", "adapt", "https://www.webintravel.com/adapt/"]) {
    const { body } = await rpc("tools/call", { name: "fetch", arguments: { id } });
    assert.equal(JSON.parse(body.result.content[0].text).text, "Full body", id);
  }
  const { body } = await rpc("tools/call", { name: "fetch", arguments: { id: "999" } });
  assert.equal(body.result.isError, true);
});

test("internal errors are hidden from the client", async () => {
  const h = createMcpHandler({
    name: "t", version: "0", onError: () => {},
    tools: buildTools({ ...backend, categoryCounts: async () => { throw new Error("db password wrong"); } }),
  });
  const res = await h(new Request("http://x", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_categories" } }),
  }));
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.doesNotMatch(body.result.content[0].text, /password/);
});
