// Embedding service used by scripts/embed.py: POST {texts: string[]} -> {embeddings: number[][]}.
// It is protected by the EMBED_SECRET secret (header `x-embed-secret`).
import { embed, safeEqual } from "../_shared/supabase.ts";

const MAX_TEXTS = 32;
const MAX_CHARS = 8_000;
const secret = Deno.env.get("EMBED_SECRET") ?? "";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!secret || !safeEqual(req.headers.get("x-embed-secret") ?? "", secret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let texts: unknown;
  try {
    texts = (await req.json()).texts;
  } catch {
    return Response.json({ error: "body must be JSON {texts: string[]}" }, { status: 400 });
  }
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_TEXTS ||
      !texts.every((t) => typeof t === "string" && t.length > 0 && t.length <= MAX_CHARS)) {
    return Response.json(
      { error: `texts must be 1-${MAX_TEXTS} non-empty strings of at most ${MAX_CHARS} chars` },
      { status: 400 },
    );
  }

  try {
    const embeddings: number[][] = [];
    for (const t of texts as string[]) embeddings.push(await embed(t));
    return Response.json({ embeddings });
  } catch (err) {
    console.error("[embed]", err);
    return Response.json({ error: "embedding failed" }, { status: 500 });
  }
});
