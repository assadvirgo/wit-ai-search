# wit-ai-search

Semantic search over the WiT article archive, served to ChatGPT as an MCP server.

- **Supabase Postgres + pgvector** stores the articles, plus ~250-word chunks embedded with `gte-small` (384 dims).
- **`match_chunks()`** runs hybrid search: vector similarity plus full-text, merged with Reciprocal Rank Fusion, best chunk per article.
- **Edge Function `mcp`** is a stateless MCP server (Streamable HTTP) with the tools `search`, `fetch`, `latest_articles`, `list_categories`.
- **Edge Function `embed`** is a background worker: a `pg_cron` job calls it every 5 seconds while chunks are pending. It embeds them with the same built-in model the MCP server uses for queries, so stored vectors always match query vectors.

See [docs/PLAN.md](docs/PLAN.md) for the full plan and roadmap.

```
supabase/migrations/…_init.sql      tables, indexes, RLS, match_chunks(), category_counts()
supabase/functions/mcp/             MCP server entry point
supabase/functions/embed/           background embedder (called by pg_cron)
supabase/functions/_shared/         mcp.ts (protocol), tools.ts (tools), supabase.ts (DB + model)
scripts/migrate.py                  SQLite -> Supabase (articles + chunks)
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

**2. Functions**

```bash
supabase functions deploy mcp --no-verify-jwt
```

```bash
supabase functions deploy embed
```

Optionally, set `MCP_PATH_SECRET` (Dashboard → Edge Functions → Secrets) to keep the MCP endpoint private.

**3. Turn on auto-embedding** (once per project, in the SQL editor)

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<legacy anon key>', 'anon_key');
```

The second migration created a `pg_cron` job called `embed-pending-chunks`. It reads these two values
and calls the `embed` function whenever chunks are missing embeddings. Find the anon key under Dashboard →
Project Settings → API Keys (legacy). It is a public key.

**4. Load the articles**

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -r scripts/requirements.txt
```

```bash
export DATABASE_URL='postgresql://postgres.<project-ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres'
```

```bash
python scripts/migrate.py --source path/to/articles.db
```

`--source` takes the SQLite file directly, or a `.sql` dump of the `articles` table. Only
`status = 'publish'` rows are copied. `content_html`, `content_blocks_json`, `yoast_json` and
`raw_json` are dropped, and categories and tags become plain-text arrays. The script can be re-run
safely: it only rebuilds chunks for new or changed articles, and `--prune` also deletes articles that
are gone from the source.

Embeddings then fill in by themselves at roughly 150–180 chunks a minute (about 3 hours for ~30k chunks).
Check progress in the SQL editor:

```sql
select * from embedding_status();
```

**5. Try it**

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector, choose transport *Streamable HTTP* with the URL
`https://<project-ref>.supabase.co/functions/v1/mcp` (add `/<MCP_PATH_SECRET>` if you set one), then run `search`.

**6. Connect to ChatGPT (private, Developer Mode)**

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
  is set in `scripts/chunking.py`; re-run `migrate.py --rechunk` after changing it (embeddings refill automatically).
