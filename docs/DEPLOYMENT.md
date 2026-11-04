# Deployment log

## Supabase project `wit-ai-search` (created 2026-11-04)

- **Org:** GOL Developers · **Region:** ap-southeast-1 (Singapore) · **Ref:** `bdmkdczpotsfnjfhrvwn`
- **MCP endpoint:** `https://bdmkdczpotsfnjfhrvwn.supabase.co/functions/v1/mcp`

What was set up (through the Supabase MCP connector):

1. Migrations `init` and `auto_embed` applied. They match the two files in `supabase/migrations/`, minus comments.
2. Vault secrets `project_url` and `anon_key` (public anon key), read by the cron job.
3. `pg_cron` job `embed-pending-chunks`: every **5 seconds**, 3 parallel calls with `limit: 5`.
4. Edge Functions deployed:
   - `mcp`, with `verify_jwt` off
   - `embed`, with `verify_jwt` on. Its bundle used a type-only stub for `_shared/tools.ts`;
     `supabase functions deploy embed` replaces it with the real file.
5. Test data: **17 articles / 31 chunks** from the 300-row sample, all embedded. Load the full
   archive with `scripts/migrate.py`.

Verified live:

- `tools/list` returns 4 tools.
- `search` "last-minute hotel booking apps" returns HotelQuickly, HotelTonight and Flocations.
- `search` with `category: "startups"` is filtered correctly.

Not done yet:

- **`MCP_PATH_SECRET` is not set**, so the endpoint is open. Storing secrets through the connector
  was paused by Supabase. To set it: Dashboard → Edge Functions → Secrets → add `MCP_PATH_SECRET`.
  The URL then becomes `/functions/v1/mcp/<secret>`.
- Free-plan projects pause after inactivity. Upgrade before relying on it.
