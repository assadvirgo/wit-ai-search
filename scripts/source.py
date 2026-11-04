"""Read articles from the local SQLite database (or a SQL dump of it)."""

from __future__ import annotations

import hashlib
import html
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

SOURCE_COLUMNS = [
    "id", "title", "slug", "published_at", "published_at_gmt", "modified_at",
    "modified_at_gmt", "status", "post_type", "source_url", "staging_url", "author_id",
    "author_name", "author_profile_url", "excerpt", "content_text", "content_blocks_json",
    "content_html", "categories_json", "tags_json", "yoast_json", "imported_at", "raw_json",
]


def open_source(path: str) -> sqlite3.Connection:
    """Open a .sqlite/.db file directly, or load a .sql dump into an in-memory database."""
    p = Path(path)
    if p.suffix.lower() == ".sql":
        db = sqlite3.connect(":memory:")
        script = p.read_text(encoding="utf-8")
        if "create table" not in script.lower():
            db.execute(f"CREATE TABLE articles ({', '.join(SOURCE_COLUMNS)})")
        db.executescript(script)
    else:
        db = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def _text(v) -> str | None:
    if v is None:
        return None
    v = str(v).strip()
    return v or None


def _int(v) -> int | None:
    v = _text(v)
    return int(v) if v is not None else None


def _local_ts(v) -> str | None:
    """WordPress local time, no timezone -> ISO string for a `timestamp` column."""
    v = _text(v)
    return datetime.fromisoformat(v).replace(tzinfo=None).isoformat() if v else None


def _utc_ts(v) -> datetime | None:
    """GMT time (with or without offset) -> aware UTC datetime for `timestamptz`."""
    v = _text(v)
    if not v:
        return None
    dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _names(v) -> list[str]:
    """categories_json / tags_json -> list of plain-text names."""
    v = _text(v)
    if not v:
        return []
    try:
        items = json.loads(v)
    except json.JSONDecodeError:
        return []
    names = []
    for item in items if isinstance(items, list) else []:
        name = item.get("name") if isinstance(item, dict) else item
        if isinstance(name, str):
            name = html.unescape(name).strip()
            if name and name not in names:
                names.append(name)
    return names


def strip_html(v) -> str | None:
    v = _text(v)
    if v is None:
        return None
    v = re.sub(r"<[^>]+>", " ", v)
    v = re.sub(r"\s+", " ", html.unescape(v)).strip()
    return v or None


def content_hash(title: str | None, content: str | None, excerpt: str | None) -> str:
    h = hashlib.sha256()
    for part in (title or "", content or "", excerpt or ""):
        h.update(part.encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()


def read_articles(db: sqlite3.Connection, statuses: tuple[str, ...] = ("publish",)):
    """Yield article dicts shaped for the Postgres `articles` table."""
    placeholders = ",".join("?" for _ in statuses)
    query = f"SELECT * FROM articles WHERE status IN ({placeholders}) ORDER BY CAST(id AS INTEGER)"
    for row in db.execute(query, statuses):
        title = html.unescape(_text(row["title"]) or "")
        content = _text(row["content_text"])
        excerpt = strip_html(row["excerpt"])
        yield {
            "id": _int(row["id"]),
            "title": title,
            "slug": _text(row["slug"]) or str(row["id"]),
            "published_at": _local_ts(row["published_at"]),
            "published_at_gmt": _utc_ts(row["published_at_gmt"]),
            "modified_at": _local_ts(row["modified_at"]),
            "modified_at_gmt": _utc_ts(row["modified_at_gmt"]),
            "status": _text(row["status"]),
            "post_type": _text(row["post_type"]),
            "source_url": _text(row["source_url"]),
            "staging_url": _text(row["staging_url"]),
            "author_id": _int(row["author_id"]),
            "author_name": _text(row["author_name"]),
            "author_profile_url": _text(row["author_profile_url"]),
            "excerpt": excerpt,
            "content_text": content,
            "categories": _names(row["categories_json"]),
            "tags": _names(row["tags_json"]),
            "imported_at": _utc_ts(row["imported_at"]),
            "content_hash": content_hash(title, content, excerpt),
        }
