-- wit-ai-search: articles + chunk embeddings (gte-small, 384 dims) with hybrid search.

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- Articles: the original WordPress fields (no HTML / JSON blobs).
-- Categories and tags are stored as plain-text name arrays.
-- ---------------------------------------------------------------------------
create table public.articles (
  id                 bigint primary key,           -- WordPress post ID
  title              text not null,
  slug               text not null,
  published_at       timestamp,                    -- site-local time, as WordPress reports it
  published_at_gmt   timestamptz,
  modified_at        timestamp,
  modified_at_gmt    timestamptz,
  status             text,
  post_type          text,
  source_url         text,
  staging_url        text,
  author_id          bigint,
  author_name        text,
  author_profile_url text,
  excerpt            text,                         -- plain text (HTML tags stripped)
  content_text       text,
  categories         text[] not null default '{}',
  tags               text[] not null default '{}',
  imported_at        timestamptz,
  content_hash       text not null,                -- hash of what was chunked; skips unchanged articles on re-sync
  synced_at          timestamptz not null default now()
);

create index articles_slug_idx         on public.articles (slug);
create index articles_published_idx    on public.articles (published_at_gmt desc);
create index articles_categories_idx   on public.articles using gin (categories);
create index articles_tags_idx         on public.articles using gin (tags);

-- ---------------------------------------------------------------------------
-- Chunks: ~250-word passages (title prepended), embedded with gte-small.
-- embedding is NULL until scripts/embed.py fills it.
-- ---------------------------------------------------------------------------
create table public.article_chunks (
  id          bigint generated always as identity primary key,
  article_id  bigint not null references public.articles (id) on delete cascade,
  chunk_index int    not null,
  content     text   not null,
  embedding   extensions.vector(384),
  fts         tsvector generated always as (to_tsvector('english', content)) stored,
  unique (article_id, chunk_index)
);

create index article_chunks_embedding_idx on public.article_chunks
  using hnsw (embedding extensions.vector_cosine_ops);
create index article_chunks_fts_idx       on public.article_chunks using gin (fts);
create index article_chunks_pending_idx   on public.article_chunks (id) where embedding is null;

-- ---------------------------------------------------------------------------
-- Lock down: only the service role (Edge Functions, scripts) can read/write.
-- ---------------------------------------------------------------------------
alter table public.articles       enable row level security;
alter table public.article_chunks enable row level security;

-- ---------------------------------------------------------------------------
-- Hybrid search: semantic (cosine) + full-text, merged with Reciprocal Rank
-- Fusion. Returns at most one chunk (the best) per article.
-- ---------------------------------------------------------------------------
create or replace function public.match_chunks(
  query_embedding   extensions.vector(384),
  query_text        text,
  match_count       int         default 8,
  filter_category   text        default null,
  filter_tag        text        default null,
  date_from         timestamptz default null,
  date_to           timestamptz default null,
  full_text_weight  float       default 1.0,
  semantic_weight   float       default 1.0,
  rrf_k             int         default 50
)
returns table (
  chunk_id     bigint,
  article_id   bigint,
  content      text,
  score        float,
  title        text,
  source_url   text,
  published_at timestamptz,
  author_name  text,
  categories   text[],
  tags         text[]
)
language sql stable
set search_path = public, extensions
set hnsw.ef_search = 200   -- wider HNSW candidate list so category/date filters still return enough rows
as $$
  with eligible as (
    select a.id
    from articles a
    where (filter_category is null
           or exists (select 1 from unnest(a.categories) c where lower(c) = lower(filter_category)))
      and (filter_tag is null
           or exists (select 1 from unnest(a.tags) t where lower(t) = lower(filter_tag)))
      and (date_from is null or a.published_at_gmt >= date_from)
      and (date_to   is null or a.published_at_gmt <  date_to)
  ),
  semantic as (
    select c.id,
           row_number() over (order by c.embedding <=> query_embedding) as rank_ix
    from article_chunks c
    where c.embedding is not null
      and c.article_id in (select id from eligible)
    order by c.embedding <=> query_embedding
    limit greatest(match_count, 1) * 5
  ),
  full_text as (
    select c.id,
           row_number() over (
             order by ts_rank_cd(c.fts, websearch_to_tsquery('english', query_text)) desc
           ) as rank_ix
    from article_chunks c
    where c.fts @@ websearch_to_tsquery('english', query_text)
      and c.article_id in (select id from eligible)
    order by rank_ix
    limit greatest(match_count, 1) * 5
  ),
  fused as (
    select coalesce(s.id, f.id) as id,
           coalesce(1.0 / (rrf_k + s.rank_ix), 0.0) * semantic_weight
         + coalesce(1.0 / (rrf_k + f.rank_ix), 0.0) * full_text_weight as score
    from semantic s
    full outer join full_text f on f.id = s.id
  ),
  best_per_article as (
    select c.id, c.article_id, c.content, fu.score,
           row_number() over (partition by c.article_id order by fu.score desc) as rn
    from fused fu
    join article_chunks c on c.id = fu.id
  )
  select b.id, b.article_id, b.content, b.score::float,
         a.title, a.source_url, a.published_at_gmt, a.author_name, a.categories, a.tags
  from best_per_article b
  join articles a on a.id = b.article_id
  where b.rn = 1
  order by b.score desc
  limit match_count;
$$;

-- Category names with article counts (lets the model discover valid filters).
create or replace function public.category_counts()
returns table (category text, article_count bigint)
language sql stable
set search_path = public
as $$
  select c, count(*) from articles, unnest(categories) c
  group by c order by count(*) desc, c;
$$;

revoke execute on function public.match_chunks(extensions.vector, text, int, text, text, timestamptz, timestamptz, float, float, int) from public, anon, authenticated;
revoke execute on function public.category_counts() from public, anon, authenticated;
grant  execute on function public.match_chunks(extensions.vector, text, int, text, text, timestamptz, timestamptz, float, float, int) to service_role;
grant  execute on function public.category_counts() to service_role;
