"""Split article text into overlapping, embedding-sized passages.

gte-small accepts at most 512 tokens. English text runs about 1.3 tokens per word, so the
defaults (~220 words, plus a 40-word overlap and the title) keep every chunk around 350 tokens.
"""

from __future__ import annotations

import re

TARGET_WORDS = 220
OVERLAP_WORDS = 40

_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")


def _paragraphs(text: str) -> list[str]:
    paras = []
    for block in re.split(r"\n\s*\n", text or ""):
        block = re.sub(r"\s+", " ", block).strip()
        if block:
            paras.append(block)
    return paras


def _split_long(paragraph: str, limit: int) -> list[str]:
    """Break a paragraph longer than `limit` words at sentence boundaries, then at words."""
    pieces: list[str] = []
    current: list[str] = []
    for sentence in _SENTENCE_RE.split(paragraph):
        words = sentence.split()
        while len(words) > limit:  # a single giant "sentence"
            if current:
                pieces.append(" ".join(current))
                current = []
            pieces.append(" ".join(words[:limit]))
            words = words[limit:]
        if current and len(current) + len(words) > limit:
            pieces.append(" ".join(current))
            current = []
        current.extend(words)
    if current:
        pieces.append(" ".join(current))
    return pieces


def chunk_article(
    title: str,
    text: str,
    fallback: str = "",
    target_words: int = TARGET_WORDS,
    overlap_words: int = OVERLAP_WORDS,
) -> list[str]:
    """Return chunk strings, each formatted as "<title>\\n\\n<passage>".

    `fallback` (e.g. the excerpt) is used when the article has no body text.
    """
    title = re.sub(r"\s+", " ", title or "").strip()
    units: list[str] = []
    for para in _paragraphs(text) or _paragraphs(fallback):
        if len(para.split()) > target_words:
            units.extend(_split_long(para, target_words))
        else:
            units.append(para)

    if not units:
        return [title] if title else []

    chunks: list[str] = []
    current: list[str] = []
    current_words = 0
    for unit in units:
        n = len(unit.split())
        if current and current_words + n > target_words:
            chunks.append(" ".join(current))
            tail = " ".join(current).split()[-overlap_words:] if overlap_words else []
            current = [" ".join(tail)] if tail else []
            current_words = len(tail)
        current.append(unit)
        current_words += n
    if current:
        chunks.append(" ".join(current))

    return [f"{title}\n\n{c}" if title else c for c in chunks]
