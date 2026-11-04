# wit-ai-search: project plan

Goal: put the local SQLite `articles` table into Supabase Postgres with pgvector, expose
semantic search through an MCP server hosted as a Supabase Edge Function, and connect
that server to ChatGPT so you can ask questions about the articles.

```
 local SQLite ──(Python migrate + embed)──► Supabase Postgres (articles + article_chunks, pgvector)
                                                     ▲
                                                     │ SQL RPC: match_chunks()
                                                     │
 ChatGPT (custom MCP connector) ──HTTPS──► Supabase Edge Function "mcp" (Streamable HTTP)
                                            └─ embeds the query, calls match_chunks, returns hits
```

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| ChatGPT integration | **Remote MCP connector** (ChatGPT Developer Mode / Apps SDK), not a legacy "plugin" | ChatGPT plugins were retired in 2024. ChatGPT now connects directly to remote MCP servers, so the MCP server *is* the ChatGPT integration. Fallback: a Custom GPT with an Action (OpenAPI) calling the same function. |
| MCP hosting | Supabase Edge Function (Deno + `@modelcontextprotocol/sdk` or `mcp-lite`, Streamable HTTP transport) | Runs next to the database; no extra server. |
| Embedding model | `text-embedding-3-small` (1536 dims) | Multilingual and good quality. Supabase's built-in `gte-small` (384 dims, no API key) is cheaper but English-only. Pick it only if every article is in English. |
| Unit of search | **Chunks**, not whole articles | Long articles produce weak single vectors. Split `content_text` into ~500-token chunks with overlap and prefix each one with the title. |
| Retrieval | Hybrid: pgvector cosine + Postgres full-text, merged with Reciprocal Rank Fusion | Vector search alone misses exact names and keywords. |
| Index | HNSW (`vector_cosine_ops`) | Works well without tuning and handles new rows without a rebuild. |
| Migration path | Python script → direct Postgres connection (`psycopg`, `COPY` or batched upserts) | Faster and simpler than the REST API for bulk loads. |

## Phase 0: setup
- Create the Supabase project, then run `supabase init` and `supabase link` locally.
- Secrets: `OPENAI_API_KEY` and `MCP_ACCESS_KEY` (`supabase secrets set ...`).
- Look over the SQLite data: number of rows, languages, average `content_text` length, and
  whether `content_text` is clean or needs to be rebuilt from `content_html`.

## Phase 1: database schema (`supabase/migrations/*.sql`)

`articles`: mirrors the SQLite columns, with proper types:
- `id bigint primary key` (keep the WordPress ID), `slug text unique`
- `published_at`, `modified_at`, etc. → `timestamptz`
- `categories_json`, `tags_json`, `yoast_json`, `content_blocks_json`, `raw_json` → `jsonb`
  (renamed to `categories`, `tags`, ...). Add `category_names text[]` and `tag_names text[]`
  with GIN indexes so filtering is cheap.
- `content_hash text` so the script can skip re-embedding articles that haven't changed.

`article_chunks`:
- `id bigserial`, `article_id bigint references articles on delete cascade`, `chunk_index int`
- `content text`, `token_count int`, `embedding vector(1536)`
- `fts tsvector generated always as (to_tsvector('simple', content)) stored`
- Indexes: HNSW on `embedding`, GIN on `fts`, btree on `article_id`

SQL functions (called via RPC):
- `match_chunks(query_embedding, query_text, match_count, filter_category, date_from, date_to)`
  runs hybrid RRF and returns the chunk plus article title/slug/url/published_at.
- RLS on both tables, with no public policies. Only the Edge Function (service role) reads.

## Phase 2: migration and embedding (`scripts/`)
1. `migrate.py`: read SQLite, convert types (parse JSON strings and ISO dates, flatten
   category and tag names), and upsert into `articles`.
2. `embed.py`: for each article whose `content_hash` changed, chunk it (tiktoken, ~500 tokens,
   ~75 overlap, `"{title}\n\n{chunk}"`), embed in batches of about 100 inputs, and replace that
   article's rows in `article_chunks`.
3. Both scripts can be re-run safely, so later syncs just re-run them.
4. Cost check: 10k articles × ~1.5k tokens ≈ 15M tokens ≈ $0.30 with text-embedding-3-small.

## Phase 3: MCP server (`supabase/functions/mcp/`)
Tools:
- `search(query, limit?, category?, date_from?, date_to?)`: returns a ranked list of
  `{id, title, url, published_at, snippet, score}`.
- `fetch(id)`: returns the full article (title, metadata, `content_text`, url).
  `search` and `fetch` are the tool names ChatGPT expects for connectors and deep research, so keep them exactly.
- Optional later: `list_categories`, `latest_articles(n)`.

Implementation notes:
- Deploy with `--no-verify-jwt`, because ChatGPT won't send a Supabase JWT. Check
  `MCP_ACCESS_KEY` yourself, using either a secret path segment or a header/OAuth.
- Embed the query with the same model used for the stored chunks.
- Cap response sizes: snippets of about 300 characters, and `fetch` truncates very long articles.
- Test locally with `supabase functions serve` and MCP Inspector.

## Phase 4: ChatGPT connection
- ChatGPT → Settings → Connectors (Developer mode) → add a custom connector with the URL
  `https://<project>.supabase.co/functions/v1/mcp`.
- Auth: ChatGPT connectors support either no auth or OAuth. For a quick private setup, keep the URL
  secret and don't use no-auth if the data is sensitive. To lock it down properly later, add OAuth
  (Supabase Auth can be the identity provider).
- Write evaluation questions you already know the answers to, and adjust chunk size, `match_count`,
  and RRF weights based on the results.

## Phase 5 (optional)
- Incremental sync from WordPress (cron Edge Function or a webhook on publish).
- Reranking step (e.g. Cohere rerank) if result quality needs it.
- Query logging table to see what you ask and which answers miss.

## Repo layout
```
supabase/
  config.toml
  migrations/0001_init.sql
  functions/mcp/index.ts
scripts/
  migrate.py
  embed.py
  requirements.txt
docs/PLAN.md
.env.example
```

## Open questions
1. How many articles are there, and what languages are they in? This decides between gte-small and OpenAI.
2. Is the content public (published posts), or does it need real auth?
3. Should `raw_json`/`content_html` go to Supabase too, or be left out to save space?
4. Do you use ChatGPT Plus/Pro/Business? Custom MCP connectors need a plan with Developer mode.
