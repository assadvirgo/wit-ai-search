// Background embedder: claims up to `limit` chunks that have no embedding yet, embeds them with
// the built-in gte-small model (the same one the MCP server uses for queries) and stores the vectors.
//
// The pg_cron job "embed-pending-chunks" calls this every few seconds while chunks are
// pending (see migrations), so after scripts/migrate.py loads articles, embeddings fill in by
// themselves. It is also safe to call by hand: POST {"limit": 10} with a project API key.
// It only ever processes already-pending rows, so the call is harmless.
import { adminClient, embed } from "../_shared/supabase.ts";

const MAX_LIMIT = 25;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const body = await req.json().catch(() => ({}));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(body?.limit) || 10));
  const started = Date.now();
  const db = adminClient();

  const claimed = await db.rpc("claim_pending_chunks", { n: limit });
  if (claimed.error) {
    console.error("[embed] claim failed", claimed.error);
    return Response.json({ error: "claim failed" }, { status: 500 });
  }
  const chunks = (claimed.data ?? []) as Array<{ id: number; content: string }>;

  const items: Array<{ id: number; embedding: string }> = [];
  try {
    for (const c of chunks) items.push({ id: c.id, embedding: JSON.stringify(await embed(c.content)) });
  } catch (err) {
    // Unfinished chunks keep their claim and are retried after it expires.
    console.error("[embed] model error", err);
  }

  if (items.length) {
    const stored = await db.rpc("store_chunk_embeddings", { items });
    if (stored.error) {
      console.error("[embed] store failed", stored.error);
      return Response.json({ error: "store failed" }, { status: 500 });
    }
  }
  return Response.json({ claimed: chunks.length, embedded: items.length, ms: Date.now() - started });
});
