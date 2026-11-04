# wit-ai-search

Semantic search over the WiT article archive, served to ChatGPT as an MCP server.

- **Supabase Postgres + pgvector** stores the articles, plus ~250-word chunks embedded with `gte-small` (384 dims).
- **`match_chunks()`** runs hybrid search: vector similarity plus full-text, merged with Reciprocal Rank Fusion, best chunk per article.
- **Edge Function `mcp`** is a stateless MCP server (Streamable HTTP) with the tools `search`, `fetch`, `latest_articles`, `list_categories`.
- **Edge Function `embed`** embeds text with the same built-in model. The migration uses it, so stored vectors always match query vectors.

See [docs/PLAN.md](docs/PLAN.md) for the full plan and roadmap.

```
supabase/migrations/…_init.sql      tables, indexes, RLS, match_chunks(), category_counts()
supabase/functions/mcp/             MCP server entry point
supabase/functions/embed/           embedding endpoint used by scripts/embed.py
supabase/functions/_shared/         mcp.ts (protocol), tools.ts (tools), supabase.ts (DB + model)
scripts/migrate.py                  SQLite -> Supabase (articles + chunks)
scripts/embed.py                    fills chunk embeddings via the embed function
tests/                              node + python tests (npm test)
```

## Setup

Prerequisites: the [Supabase CLI](https://supabase.com/docs/guides/cli), Python 3.10+, and a Supabase project.

**1. Database**

```bash
supabase login
```

```bash
supabase link --project-ref <project-ref>
```

```bash
supabase db push
```

**2. Secrets and functions** (use long random strings for the secrets)

```bash
supabase secrets set EMBED_SECRET=$(openssl rand -hex 24) MCP_PATH_SECRET=$(openssl rand -hex 24)
```

```bash
supabase functions deploy mcp --no-verify-jwt
```

```bash
supabase functions deploy embed --no-verify-jwt
```

Copy `.env.example` to `.env` and fill in the same two secrets (`supabase secrets list` shows
only hashes, so save the values when you create them), plus `DATABASE_URL` (Dashboard → Connect →
Session pooler) and `SUPABASE_URL`.

**3. Load the articles**

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -r scripts/requirements.txt
```

```bash
set -a; . ./.env; set +a
```

```bash
python scripts/migrate.py --source path/to/articles.db
```

```bash
python scripts/embed.py
```

`--source` takes the SQLite file directly, or a `.sql` dump of the `articles` table. Only
`status = 'publish'` rows are copied. `content_html`, `content_blocks_json`, `yoast_json` and
`raw_json` are dropped, and categories and tags become plain-text arrays.

Both scripts can be re-run safely. `migrate.py` only rebuilds chunks for new or changed articles
(`--prune` also deletes articles that are gone from the source), and `embed.py` only embeds chunks
that have no embedding yet. If the embed function hits CPU or time limits, lower `--batch-size`
(default 8) or `--workers` (default 4).

**4. Try it**

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector, choose transport *Streamable HTTP* with the URL
`https://<project-ref>.supabase.co/functions/v1/mcp/<MCP_PATH_SECRET>`, then run `search`.

**5. Connect to ChatGPT (private, Developer Mode)**

ChatGPT → Settings → Apps & Connectors → Advanced settings → turn on **Developer mode**. Then create a
connector with the URL above and authentication set to **No authentication**. In a chat, enable the
connector and ask something like *"What did WiT write about Google's semantic search?"*. (Menu names
change often; look for "Developer mode" or "Create connector" if these differ.)

## Development

```bash
npm test
```

`npm test` runs the MCP protocol and tool tests with Node ≥ 22.6, plus the Python chunking and parsing tests.

To run the functions locally:

```bash
supabase start
```

```bash
supabase functions serve --env-file .env
```

## Configuration notes

- **Going public:** unset `MCP_PATH_SECRET` (`supabase secrets unset MCP_PATH_SECRET`) and the server
  answers on `/functions/v1/mcp`. Before publishing, put it behind your own domain with rate limiting
  (see the plan, Phase 4).
- **Site name and tool wording:** edit `SITE_NAME` and the tool descriptions in
  `supabase/functions/_shared/tools.ts`. These descriptions decide when ChatGPT calls the tools.
- **Search tuning:** `match_chunks()` takes `full_text_weight`, `semantic_weight` and `rrf_k`. Chunk size
  is set in `scripts/chunking.py`; re-run `migrate.py --rechunk` and then `embed.py` after changing it.
