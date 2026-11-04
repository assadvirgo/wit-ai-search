# Run: python -m unittest discover -s tests
import sqlite3
import sys
import unittest
from datetime import timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from chunking import chunk_article  # noqa: E402
from source import SOURCE_COLUMNS, read_articles, strip_html  # noqa: E402


class ChunkingTest(unittest.TestCase):
    def test_short_article_is_one_chunk_with_title(self):
        self.assertEqual(chunk_article("T", "Hello world."), ["T\n\nHello world."])

    def test_long_article_respects_limits_and_overlaps(self):
        paras = [" ".join(f"w{p}_{i}" for i in range(90)) for p in range(10)]
        chunks = chunk_article("Title", "\n\n".join(paras), target_words=220, overlap_words=40)
        self.assertGreater(len(chunks), 3)
        for c in chunks:
            self.assertTrue(c.startswith("Title\n\n"))
            self.assertLessEqual(len(c.split()) - 1, 220 + 40 + 90)
        # consecutive chunks share overlap words
        prev_tail = chunks[0].split()[-5:]
        self.assertTrue(all(w in chunks[1] for w in prev_tail))

    def test_giant_paragraph_is_split(self):
        text = " ".join(["word"] * 1000)
        chunks = chunk_article("T", text, target_words=200, overlap_words=0)
        self.assertTrue(all(len(c.split()) <= 201 for c in chunks))
        self.assertEqual(sum(len(c.split()) - 1 for c in chunks), 1000)

    def test_empty_body_falls_back_to_excerpt_then_title(self):
        self.assertEqual(chunk_article("T", "", fallback="Excerpt"), ["T\n\nExcerpt"])
        self.assertEqual(chunk_article("T", None), ["T"])


class SourceTest(unittest.TestCase):
    def test_row_conversion(self):
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        db.execute(f"create table articles ({', '.join(SOURCE_COLUMNS)})")
        row = {c: None for c in SOURCE_COLUMNS}
        row.update(id="5", title="A &amp; B", slug="a-b", status="publish",
                   published_at="2014-03-05T20:28:40", published_at_gmt="2014-03-05T12:28:40",
                   author_id="2", excerpt="<p>Hi &amp; bye</p>", content_text="Body",
                   categories_json='[{"name": "Sectors"}, {"name": "Sectors"}]', tags_json="[]",
                   imported_at="2026-11-04T05:49:39.034953+00:00")
        db.execute(f"insert into articles values ({','.join('?' * len(SOURCE_COLUMNS))})",
                   [row[c] for c in SOURCE_COLUMNS])
        db.execute("insert into articles (id, title, status) values ('6', 'draft', 'draft')")
        (a,) = list(read_articles(db))
        self.assertEqual(a["id"], 5)
        self.assertEqual(a["author_id"], 2)
        self.assertEqual(a["title"], "A & B")
        self.assertEqual(a["excerpt"], "Hi & bye")
        self.assertEqual(a["categories"], ["Sectors"])
        self.assertEqual(a["tags"], [])
        self.assertEqual(a["published_at"], "2014-03-05T20:28:40")
        self.assertEqual(a["published_at_gmt"].tzinfo, timezone.utc)
        self.assertEqual(a["published_at_gmt"].hour, 12)
        self.assertEqual(len(a["content_hash"]), 64)

    def test_strip_html(self):
        self.assertEqual(strip_html("<p>a</p><p>b</p>"), "a b")
        self.assertIsNone(strip_html("<p></p>"))


if __name__ == "__main__":
    unittest.main()
