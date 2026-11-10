"""Shared Markdown and GiNZA utilities for kotonoha's Japanese prose tools."""

from __future__ import annotations

import hashlib
import re
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable


FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+")
LIST_RE = re.compile(r"^\s*(?:[-+*]|\d+[.)])\s+")
BLOCKQUOTE_RE = re.compile(r"^\s*>\s?")
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
LINK_RE = re.compile(r"!?\[([^\]]*)\]\([^)]+\)")
URL_RE = re.compile(r"https?://\S+")
HTML_TAG_RE = re.compile(r"<[^>]+>")
SENTENCE_END_RE = re.compile(r"[。！？!?]+(?:[」』）】〉》]*)")
JAPANESE_RE = re.compile(r"[ぁ-んァ-ヶ一-龠々]")


@dataclass
class Finding:
    line: int
    category: str
    severity: str
    message: str
    excerpt: str
    evidence: dict | None = None
    status: str | None = None

    def to_dict(self) -> dict:
        value = asdict(self)
        return {key: item for key, item in value.items() if item is not None}


@dataclass
class ProseBlock:
    text: str
    start_line: int


def read_text(path: Path) -> str:
    if not path.is_file():
        raise FileNotFoundError(f"file not found: {path}")
    return path.read_text(encoding="utf-8")


def strip_markdown_inline(text: str) -> str:
    text = INLINE_CODE_RE.sub(" コード ", text)
    text = LINK_RE.sub(lambda match: match.group(1), text)
    text = URL_RE.sub(" ", text)
    text = HTML_TAG_RE.sub(" ", text)
    text = text.replace("**", "").replace("__", "")
    text = text.replace("~~", "")
    return re.sub(r"[ \t]+", " ", text).strip()


def iter_content_lines(text: str) -> Iterable[tuple[int, str]]:
    """Yield line-numbered Markdown outside metadata, code, and comments."""
    lines = text.splitlines()
    fence_marker = ""
    in_frontmatter = bool(lines and lines[0].strip() == "---")
    in_comment = False

    for index, raw in enumerate(lines, start=1):
        stripped = raw.strip()
        if in_frontmatter:
            if index > 1 and stripped == "---":
                in_frontmatter = False
            yield index, ""
            continue

        fence = FENCE_RE.match(raw)
        if fence:
            marker = fence.group(1)
            if not fence_marker:
                fence_marker = marker
            elif (
                marker[0] == fence_marker[0]
                and len(marker) >= len(fence_marker)
                and not raw[fence.end():].strip()
            ):
                fence_marker = ""
            yield index, ""
            continue
        if fence_marker:
            yield index, ""
            continue

        if "<!--" in raw:
            in_comment = True
        if in_comment:
            if "-->" in raw:
                in_comment = False
            yield index, ""
            continue
        yield index, raw


def iter_prose_blocks(text: str) -> list[ProseBlock]:
    """Return Markdown prose blocks while excluding metadata and code."""
    blocks: list[ProseBlock] = []
    buffer: list[str] = []
    buffer_line = 0

    def flush() -> None:
        nonlocal buffer, buffer_line
        if buffer:
            cleaned = strip_markdown_inline("\n".join(buffer))
            if cleaned and JAPANESE_RE.search(cleaned):
                blocks.append(ProseBlock(cleaned, buffer_line))
        buffer = []
        buffer_line = 0

    for index, raw in iter_content_lines(text):
        stripped = raw.strip()
        if not stripped or stripped.startswith("|") or HEADING_RE.match(raw):
            flush()
            continue

        list_item = LIST_RE.match(raw)
        if list_item:
            flush()
        line = LIST_RE.sub("", raw)
        line = BLOCKQUOTE_RE.sub("", line)
        if not buffer:
            buffer_line = index
        buffer.append(line)

    flush()
    return blocks


def sentence_line(block: ProseBlock, start_char: int) -> int:
    return block.start_line + block.text[:start_char].count("\n")


def split_sentences_fallback(text: str) -> Iterable[tuple[str, int]]:
    start = 0
    for match in SENTENCE_END_RE.finditer(text):
        end = match.end()
        sentence = text[start:end].strip()
        if sentence:
            yield sentence, start
        start = end
    tail = text[start:].strip()
    if tail:
        yield tail, start


@lru_cache(maxsize=2)
def load_ginza(enable_ner: bool = False):
    import spacy

    disabled = [] if enable_ner else ["ner"]
    return spacy.load("ja_ginza", disable=disabled)


def content_tokens(span) -> list:
    return [
        token
        for token in span
        if not token.is_space and not token.is_punct and token.pos_ != "SYM"
    ]


def dependency_depth(token) -> int:
    depth = 0
    current = token
    seen: set[int] = set()
    while current.head.i != current.i and current.i not in seen and depth < 40:
        seen.add(current.i)
        current = current.head
        depth += 1
    return depth


def excerpt(text: str, limit: int = 100) -> str:
    value = re.sub(r"\s+", " ", text).strip()
    return value if len(value) <= limit else f"{value[:limit - 1]}…"


def finding_key(finding: Finding) -> str:
    normalized = re.sub(r"\d+", "#", finding.excerpt.lower())
    raw = f"{finding.category}\0{normalized}".encode()
    return hashlib.sha256(raw).hexdigest()[:20]


def score_findings(findings: list[Finding]) -> int:
    weights = {"info": 1, "warning": 4, "critical": 10}
    deduction = sum(weights.get(item.severity, 4) for item in findings)
    return max(0, 100 - deduction)
