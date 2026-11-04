# wit-ai-search: project plan (v2)

Goal: a **public ChatGPT app** (listed in the ChatGPT Apps Directory) that anyone can connect
to ask questions about our ~6,500 published English articles. ChatGPT handles the conversation
and calls our MCP server. The MCP server runs semantic search over Supabase Postgres with pgvector.

```
 local SQLite ──(Python migrate; embed via Edge Fn)──► Supabase Postgres
                                                              articles, article_chunks (vector(384))
                                                                   ▲  RPC: match_chunks()
                                                                   │
 ChatGPT user ─► ChatGPT (LLM) ─► https://mcp.<our-domain>  ─► Supabase Edge Function "mcp"
                                  (Cloudflare: custom domain,      embeds the query (built-in gte-small),
                                   rate limiting, cache)           hybrid search, returns hits
```

ChatGPT's model writes the answers, so **our server never calls an LLM**. It only retrieves.
With the built-in embedding model there is no per-query AI cost at all.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Distribution | ChatGPT App (Apps SDK / MCP), submitted to the Apps Directory | This is what "plugins" became. A public app is an MCP server plus listing metadata. |
| Embeddings | **`gte-small`** (384 dims), built into the Supabase Edge Runtime (`Supabase.ai.Session`) | Content is all English, so the English-only limitation doesn't matter. No API key, no per-query cost, and nothing to abuse on a public endpoint. Upgrade path: switch to OpenAI `text-embedding-3-small` later by re-embedding (~$0.20). |
| Retrieval | Hybrid search: pgvector cosine + Postgres full-text, merged with RRF | Catches exact names and keywords that small embedding models miss. |
| Chunking | ~400 tokens (gte-small max is 512), ~60 overlap, title prepended | Stays inside the model's input limit. |
| Data copied | Article fields only. **Dropped:** `content_html`, `content_blocks_json`, `yoast_json`, `raw_json` | Requested by the owner. See the open question on categories and tags. |
| Public URL | Our own domain (e.g. `mcp.<domain>`) on Cloudflare, proxying to the Supabase function | The Directory wants a stable, verified domain, and the app's server URL reportedly can't change after publishing. Cloudflare also provides rate limiting and caching for free. |
| Auth | None (public, read-only data) | Users connect with one click. Abuse is handled by rate limits rather than logins. |
| Supabase plan | Pro ($25/mo) at launch | Free projects pause when inactive, which would break a public app. |

## Phase 1: Supabase schema (`supabase/migrations/20261104000000_init.sql`) ✅ built

`articles` (only rows with status `publish`):
`id bigint pk` (WordPress ID), `title`, `slug unique`, `published_at timestamptz`,
`published_at_gmt`, `modified_at`, `modified_at_gmt`, `status`, `post_type`, `source_url`,
`author_id`, `author_name`, `author_profile_url`, `excerpt`, `content_text`, `imported_at`,
plus `category_names text[]`, `tag_names text[]` (pending the open question), and
`content_hash text` so unchanged articles aren't re-embedded.

`article_chunks`: `id bigserial`, `article_id → articles on delete cascade`, `chunk_index`,
`content`, `embedding vector(384)`, `fts tsvector` (generated, `english` config).
Indexes: HNSW (`vector_cosine_ops`) on `embedding`, GIN on `fts`, btree on `article_id`.

`match_chunks(query_embedding, query_text, match_count, category?, date_from?, date_to?)`:
hybrid RRF search, at most one or two chunks per article, returning article metadata with each hit.

RLS is on for all tables with no public policies. Only the Edge Function reads, using the service role.

## Phase 2: migration and embedding (`scripts/`) ✅ built
1. `migrate.py`: SQLite (or a `.sql` dump) → Postgres (`psycopg`). It converts types, upserts by `id`,
   drops the four HTML/JSON columns, and chunks new or changed articles (~250 words, 40-word overlap,
   title prepended). The 300-row sample produced 1,364 chunks; the full ~6,500 articles should give about 30k.
2. Auto-embedding: a `pg_cron` job (every 5 seconds, 3 parallel calls of 5 chunks each) calls the `embed`
   Edge Function while chunks are pending. The function runs the same built-in gte-small model the MCP server
   uses for queries, so stored and query vectors always match, and nothing needs installing locally beyond
   psycopg. Measured at ~1.5–2 s per 5 chunks; 10 chunks per call hit `WORKER_RESOURCE_LIMIT`.
3. `migrate.py` can be re-run safely and acts as the sync step for new articles.

## Phase 3: MCP server (`supabase/functions/mcp/index.ts`) ✅ built
- Deno, with a small dependency-free stateless Streamable HTTP implementation (`_shared/mcp.ts`), `--no-verify-jwt`.
- Also `list_categories`, so the model can discover valid category filters.
- Tools, all annotated `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`:
  - `search(query, limit?, category?, date_from?, date_to?)` → `[{id, title, url, published_at, author, snippet}]`
  - `fetch(id)` → full article text, metadata, and canonical URL (truncated if very long)
  - `latest_articles(limit?, category?)` → covers "what's new" questions, which vector search handles poorly
- Clear tool descriptions, because they decide when ChatGPT calls the tools. Every result
  includes the source URL so ChatGPT cites and links back to the site.
- Input limits (query length, max `limit`), and errors that don't leak internals.
- Local testing: `supabase functions serve` + MCP Inspector.

## Milestone A: private use (manual connector)
Build Phases 1–3, then connect the server to ChatGPT yourself in **Developer Mode**
(Settings → Apps & Connectors → Advanced → Developer mode → create a connector, then paste the URL).
The raw `https://<ref>.supabase.co/functions/v1/mcp` URL works here, so there's no custom domain,
Cloudflare, or Directory paperwork yet. Use this stage to tune search quality with the evaluation set.
For now, protect it with a secret path segment (`/functions/v1/mcp/<secret>`) so it stays private.

## Milestone B: public launch (Phases 4–6)
Pick the final domain **before** submitting, because the published server URL reportedly can't change.

## Phase 4: public edge (Cloudflare)
- `mcp.<domain>` → Worker or route proxying to `https://<ref>.supabase.co/functions/v1/mcp`.
- Rate limit per IP (e.g. 60 requests/min), and serve the Directory's domain-verification file from the same domain.

## Phase 5: ChatGPT app and Directory submission
1. Repoint the Developer Mode connector at the final domain and test again.
2. Build an evaluation set of 30–50 questions with known answers, then tune chunk size, `match_count`, and RRF weights.
3. Submission prerequisites: OpenAI organization verification, a public HTTPS server on a
   verified domain, app name, logo, description, starter prompts, screenshots, privacy policy
   URL, terms URL, and tool annotations. **These are from third-party guides and the official
   page couldn't be loaded from this session, so recheck OpenAI's current submission docs
   before starting this phase.**
4. Optional v2: an Apps SDK UI widget (article result cards) instead of plain-text results.

## Phase 6: operations
- `query_log` table for queries (no personal data), latency, and zero-result searches, to see what users ask and where retrieval fails.
- Scheduled sync from WordPress (Edge Function cron) for new articles.

## Repo layout
```
supabase/config.toml
supabase/migrations/20261104000000_init.sql
supabase/functions/{mcp,embed,_shared}/
scripts/{migrate,chunking,source}.py, requirements.txt
cloudflare/worker.ts (+ wrangler.toml)
docs/PLAN.md, docs/privacy.md, docs/terms.md
.env.example
```

## Decisions made
- Categories and tags are stored as plain-text name arrays.
- Content rights: the owner has permission. Directory review comes at the public-launch stage.

## Open questions (for Milestone B)
1. Which domain should host the public MCP endpoint, and is it on Cloudflare?
2. Is there an OpenAI Platform organization that can complete verification?
