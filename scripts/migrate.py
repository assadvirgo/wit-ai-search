#!/usr/bin/env python3
"""Copy articles from local SQLite into Supabase Postgres and (re)build their chunks.

Safe to re-run: unchanged articles are only metadata-updated, while new or edited articles
get fresh chunks (with NULL embeddings, filled afterwards by embed.py).

    python scripts/migrate.py --source data/articles.db
    python scripts/migrate.py --source data/articles.sql --prune
"""

from __future__ import annotations

import argparse
import os
import sys
import time

import psycopg

from chunking import chunk_article
from source import open_source, read_articles

ARTICLE_FIELDS = [
    "id", "title", "slug", "published_at", "published_at_gmt", "modified_at",
    "modified_at_gmt", "status", "post_type", "source_url", "staging_url", "author_id",
    "author_name", "author_profile_url", "excerpt", "content_text", "categories", "tags",
    "imported_at", "content_hash",
]

UPSERT_SQL = f"""
insert into public.articles ({", ".join(ARTICLE_FIELDS)}, synced_at)
values ({", ".join("%(" + f + ")s" for f in ARTICLE_FIELDS)}, now())
on conflict (id) do update set
  {", ".join(f"{f} = excluded.{f}" for f in ARTICLE_FIELDS if f != "id")},
  synced_at = now()
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", required=True, help="SQLite file (.db/.sqlite) or SQL dump (.sql)")
    ap.add_argument("--database-url", default=os.environ.get("DATABASE_URL"),
                    help="Postgres connection string (default: $DATABASE_URL)")
    ap.add_argument("--prune", action="store_true",
                    help="delete articles from Supabase that are no longer in the source")
    ap.add_argument("--rechunk", action="store_true",
                    help="rebuild chunks for every article, even unchanged ones")
    args = ap.parse_args()
    if not args.database_url:
        ap.error("set DATABASE_URL or pass --database-url")

    t0 = time.time()
    articles = list(read_articles(open_source(args.source)))
    print(f"read {len(articles)} published articles from {args.source}")

    with psycopg.connect(args.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute("select id, content_hash from public.articles")
            existing = dict(cur.fetchall())
            changed = [a for a in articles
                       if args.rechunk or existing.get(a["id"]) != a["content_hash"]]

            cur.executemany(UPSERT_SQL, articles)
            print(f"upserted {len(articles)} articles ({len(articles) - len(existing.keys() & {a['id'] for a in articles})} new)")

            n_chunks = 0
            for a in changed:
                chunks = chunk_article(a["title"], a["content_text"], fallback=a["excerpt"] or "")
                cur.execute("delete from public.article_chunks where article_id = %s", (a["id"],))
                with cur.copy("copy public.article_chunks (article_id, chunk_index, content) from stdin") as cp:
                    for i, text in enumerate(chunks):
                        cp.write_row((a["id"], i, text))
                n_chunks += len(chunks)
            print(f"rebuilt chunks for {len(changed)} articles ({n_chunks} chunks, embeddings pending)")

            if args.prune:
                source_ids = [a["id"] for a in articles]
                cur.execute("delete from public.articles where not (id = any(%s))", (source_ids,))
                print(f"pruned {cur.rowcount} articles no longer in the source")
        conn.commit()

    print(f"done in {time.time() - t0:.1f}s. Next: python scripts/embed.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
