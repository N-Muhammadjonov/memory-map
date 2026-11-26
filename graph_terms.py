"""Bounded local topic signals for the knowledge graph."""

from __future__ import annotations

import codecs
import re
import unicodedata
from collections import Counter
from pathlib import Path

WORD = re.compile(r"[^\W\d_][^\W_]{1,}", re.UNICODE)
TEXT_SUFFIXES = {".txt", ".md", ".markdown", ".csv", ".tsv", ".srt", ".vtt", ".log"}
HEADING = re.compile(r"^ {0,3}#{1,6}[ \t]+(.+)$", re.MULTILINE)


def topic_terms(body: str) -> list[str]:
    """Send ordered keywords rather than entire note bodies in graph responses."""
    normalized = unicodedata.normalize("NFKC", body[:8192]).casefold()
    normalized = normalized.translate(str.maketrans("", "", "'’‘ʻʼ"))
    counts = Counter(WORD.findall(normalized))
    for title in HEADING.findall(normalized):
        counts.update(WORD.findall(title))
    return [word for word, _ in counts.most_common(36) if len(word) <= 40]



def attachment_terms(name: str, content: bytes) -> list[str]:
    """Use bounded UTF-8 text for newly added attachments."""
    if Path(name).suffix.lower() not in TEXT_SUFFIXES:
        return []
    sample = content[:8192]
    try:
        # Ignore an incomplete final character when the file exceeds the sample.
        decoder = codecs.getincrementaldecoder("utf-8-sig")()
        text = decoder.decode(sample, final=len(content) <= len(sample))
    except UnicodeDecodeError:
        return []
    return topic_terms(text)
