// Supabase-backed implementation of the tools' Backend (Deno / Edge Runtime only).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import type { ArticleRow, Backend, ChunkHit } from "./tools.ts";

const ARTICLE_COLUMNS =
  "id, title, slug, source_url, published_at_gmt, modified_at_gmt, author_name, excerpt, categories, tags";

let session: { run: (input: string, opts: Record<string, unknown>) => Promise<unknown> } | null = null;

/** gte-small (384 dims), mean-pooled and normalized. It must match how the stored chunks were embedded. */
export async function embed(text: string): Promise<number[]> {
  // deno-lint-ignore no-explicit-any
  session ??= new (globalThis as any).Supabase.ai.Session("gte-small");
  const out = await session!.run(text, { mean_pool: true, normalize: true });
  return Array.from(out as ArrayLike<number>);
}

/** Service-role client (bypasses RLS). Server-side only. */
export function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export function supabaseBackend(): Backend {
  const db = adminClient();

  const check = <T>(r: { data: T | null; error: unknown }): T => {
    if (r.error) throw r.error;
    return r.data as T;
  };

  return {
    embed,
    async matchChunks(p) {
      return check(await db.rpc("match_chunks", {
        ...p,
        query_embedding: JSON.stringify(p.query_embedding),
      })) as ChunkHit[];
    },
    async getArticle(id, slug) {
      let q = db.from("articles").select(`${ARTICLE_COLUMNS}, content_text`);
      q = id !== null ? q.eq("id", id) : q.eq("slug", slug!);
      const rows = check(await q.order("published_at_gmt", { ascending: false }).limit(1)) as ArticleRow[];
      return rows[0] ?? null;
    },
    async latestArticles(limit, category, tag) {
      // Exact (case-sensitive) array containment here; list_categories gives the exact names.
      let q = db.from("articles").select(ARTICLE_COLUMNS);
      if (category) q = q.contains("categories", [category]);
      if (tag) q = q.contains("tags", [tag]);
      return check(await q.order("published_at_gmt", { ascending: false, nullsFirst: false }).limit(limit)) as ArticleRow[];
    },
    async categoryCounts() {
      return check(await db.rpc("category_counts")) as Array<{ category: string; article_count: number }>;
    },
  };
}

/** Constant-time string comparison for secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
