#!/usr/bin/env python3
"""Fill in missing chunk embeddings by calling the `embed` Edge Function.

Embeddings are computed inside Supabase with the built-in gte-small model, the same model the
MCP server uses for queries, so stored vectors and query vectors always match. Nothing needs
to be installed locally besides psycopg.

    python scripts/embed.py                 # embed every chunk where embedding is NULL
    python scripts/embed.py --batch-size 4 --workers 2

Env: DATABASE_URL, SUPABASE_URL, EMBED_SECRET
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import psycopg


def call_embed(url: str, secret: str, texts: list[str], retries: int = 5) -> list[list[float]]:
    body = json.dumps({"texts": texts}).encode()
    delay = 2.0
    for attempt in range(retries):
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "content-type": "application/json",
            "x-embed-secret": secret,
        })
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                vectors = json.loads(resp.read())["embeddings"]
                if len(vectors) != len(texts):
                    raise ValueError(f"expected {len(texts)} embeddings, got {len(vectors)}")
                return vectors
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise SystemExit(f"embed function rejected the secret (HTTP {e.code}); check EMBED_SECRET")
            err = f"HTTP {e.code}: {e.read()[:300]!r}"
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            err = str(e)
        if attempt == retries - 1:
            raise RuntimeError(f"embed call failed after {retries} attempts: {err}")
        print(f"  retry {attempt + 1} after error: {err}", file=sys.stderr)
        time.sleep(delay)
        delay *= 2
    raise AssertionError("unreachable")


def to_pgvector(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.7f}" for x in v) + "]"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--supabase-url", default=os.environ.get("SUPABASE_URL"),
                    help="https://<project-ref>.supabase.co (or http://127.0.0.1:54321 locally)")
    ap.add_argument("--secret", default=os.environ.get("EMBED_SECRET"))
    ap.add_argument("--batch-size", type=int, default=8, help="chunks per function call")
    ap.add_argument("--workers", type=int, default=4, help="parallel function calls")
    ap.add_argument("--limit", type=int, default=0, help="stop after N chunks (0 = all)")
    args = ap.parse_args()
    for name in ("database_url", "supabase_url", "secret"):
        if not getattr(args, name):
            ap.error(f"missing --{name.replace('_', '-')} (or its env var)")

    url = args.supabase_url.rstrip("/") + "/functions/v1/embed"
    with psycopg.connect(args.database_url, autocommit=True) as conn:
        pending = conn.execute(
            "select id, content from public.article_chunks where embedding is null order by id"
            + (f" limit {int(args.limit)}" if args.limit else "")
        ).fetchall()
        total = len(pending)
        print(f"{total} chunks need embeddings")
        if not total:
            return 0

        batches = [pending[i:i + args.batch_size] for i in range(0, total, args.batch_size)]
        done, t0 = 0, time.time()

        def work(batch):
            return batch, call_embed(url, args.secret, [text for _, text in batch])

        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for batch, vectors in pool.map(work, batches):
                with conn.cursor() as cur:
                    cur.executemany(
                        "update public.article_chunks set embedding = %s::extensions.vector where id = %s",
                        [(to_pgvector(v), cid) for (cid, _), v in zip(batch, vectors)],
                    )
                done += len(batch)
                rate = done / max(time.time() - t0, 1e-6)
                print(f"\r  {done}/{total} embedded ({rate:.1f}/s, ~{(total - done) / rate / 60:.1f} min left)",
                      end="", flush=True)
        print()
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
