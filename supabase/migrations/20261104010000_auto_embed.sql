-- Automatic embedding: pg_cron calls the `embed` Edge Function while chunks are pending.
--
-- One-time setup per project (values are project-specific, so they aren't in this file):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<legacy anon key (JWT)>', 'anon_key');

create extension if not exists pg_net;
create extension if not exists pg_cron;

alter table public.article_chunks add column if not exists embed_claimed_at timestamptz;

-- Claim up to n pending chunks. A claim expires after 3 minutes so a crashed worker's rows get retried.
create or replace function public.claim_pending_chunks(n int default 10)
returns table (id bigint, content text)
language sql volatile
set search_path = public
as $$
  update article_chunks c
     set embed_claimed_at = now()
   where c.id in (
     select p.id from article_chunks p
      where p.embedding is null
        and (p.embed_claimed_at is null or p.embed_claimed_at < now() - interval '3 minutes')
      order by p.id
      limit greatest(1, least(n, 100))
      for update skip locked
   )
  returning c.id, c.content;
$$;

-- items: [{"id": 1, "embedding": "[0.1, ...]"}, ...]
create or replace function public.store_chunk_embeddings(items jsonb)
returns int
language sql volatile
set search_path = public, extensions
as $$
  with u as (
    update article_chunks c
       set embedding = x.embedding::extensions.vector(384),
           embed_claimed_at = null
      from jsonb_to_recordset(items) as x(id bigint, embedding text)
     where c.id = x.id
    returning 1
  )
  select count(*)::int from u;
$$;

-- Progress at a glance: select * from public.embedding_status();
create or replace function public.embedding_status()
returns table (total bigint, embedded bigint, pending bigint)
language sql stable
set search_path = public
as $$
  select count(*), count(embedding), count(*) - count(embedding) from article_chunks;
$$;

revoke execute on function public.claim_pending_chunks(int)   from public, anon, authenticated;
revoke execute on function public.store_chunk_embeddings(jsonb) from public, anon, authenticated;
revoke execute on function public.embedding_status()          from public, anon, authenticated;
grant  execute on function public.claim_pending_chunks(int)   to service_role;
grant  execute on function public.store_chunk_embeddings(jsonb) to service_role;
grant  execute on function public.embedding_status()          to service_role;

-- Every 5 seconds: if anything is pending, fire 3 parallel embed calls (5 chunks each; 10 hit WORKER_RESOURCE_LIMIT).
select cron.schedule(
  'embed-pending-chunks',
  '5 seconds',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/embed',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key')
      ),
      body := jsonb_build_object('limit', 5),
      timeout_milliseconds := 120000
    )
    from generate_series(1, 3)
    where exists (select 1 from public.article_chunks where embedding is null);
  $job$
);
