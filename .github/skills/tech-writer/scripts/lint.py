#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""tech-writer skill: a lint script that mechanically checks a technical
document's *structure* and Markdown rendering safety.

Where japanese-prose's GiNZA lint detects sentence-level naturalness
(vocabulary, rhythm), this script detects structural problems specific to
technical documents plus Markdown syntax patterns that render inconsistently
(heading hierarchy, code examples, leftover placeholders, suspicious links,
and bold delimiters touching prose). The two scripts intentionally don't
overlap in scope.

Findings are flags, not mandates: exit code is always 0 regardless of the
finding count (it's a lint, so it shouldn't block CI). Exit code 1 is
reserved for the input file being missing or unreadable.

Pass --atomic when linting a commit message, PR description, issue report,
code comment/docstring, or a single release-notes entry: these atomic
artifacts follow their own doctype skeleton (see style-constitution.md's
scope note) and legitimately have no H1 title, so --atomic skips the
living-document intro-paragraph check that would otherwise misfire on
them (e.g. assets/templates/pr-description.md lints clean with --atomic).

Usage:
    uv run scripts/lint.py <file>
    uv run scripts/lint.py --json <file>
    uv run scripts/lint.py --atomic <file>
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Finding:
    line: int
    category: str
    message: str
    snippet: str = ""


@dataclass
class LintResult:
    file: str
    findings: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "file": self.file,
            "finding_count": len(self.findings),
            "findings": [f.__dict__ for f in self.findings],
        }


HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
# Generic heading labels that read as content-free in either language.
GENERIC_HEADINGS = {
    "overview", "introduction", "usage", "notes", "misc", "others",
    "概要", "はじめに", "使い方", "使用方法", "注意点", "注意事項", "その他", "補足",
}
# A fence marker is 3+ backticks or 3+ tildes, optionally followed by an
# info string (e.g. the language). CommonMark requires the closing fence to
# use the same character and be at least as long as the opener, with no
# info string of its own.
FENCE_RE = re.compile(r"^(`{3,}|~{3,})(.*)$")
PLACEHOLDER_RE = re.compile(r"\b(TODO|FIXME|TBD|XXX)\b", re.IGNORECASE)
MD_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")
INLINE_CODE_RE = re.compile(r"(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)")
URL_TOKEN_RE = re.compile(r"(?:[a-z][a-z0-9+.-]*://|mailto:|www\.)[^\s<>`]+", re.IGNORECASE)
COMPOUND_IDENTIFIER_RE = re.compile(r"\w+(?:[-./\\]\w+)+")
BOLD_RE = re.compile(r"(?<![\\*])\*\*(?!\s)(.+?)(?<!\s)\*\*(?!\*)")
NON_PARAGRAPH_RE = re.compile(
    r"^(?:[-*+]\s|\d+[.)]\s|>|<!--|\|)|^(?:-{3,}|\*{3,}|_{3,})$"
)
# CommonMark indented code block: 4+ leading spaces or a leading tab.
INDENTED_CODE_RE = re.compile(r"^(?: {4,}|\t)\S")
# A YAML frontmatter field named "title" with a non-empty value, e.g. a
# Zenn/Qiita article's `title: "..."` (the platform renders this as the
# page title, so the body conventionally has no in-body '#' heading).
TITLE_FIELD_RE = re.compile(r'^title:\s*(["\']?)\S')


def strip_inline_code(line: str) -> str:
    """Blank out inline `code span` contents so placeholder/link checks
    don't fire on tokens that are only being *mentioned* as code, not left
    unresolved in prose (e.g. a doctype guide showing `TODO(#123): ...` as
    an example of the correct form)."""
    return INLINE_CODE_RE.sub(lambda m: " " * len(m.group(0)), line)


def parse_fences(lines: list) -> tuple:
    """Scan for fenced code blocks.

    Returns (findings, fence_mask) where fence_mask[i] is True when line i
    (0-based) is part of a fenced code block (opening/closing marker or
    content in between). Other checks should skip masked lines so that
    headings, TODOs, or links written *inside* example code blocks aren't
    mistaken for real document structure.
    """
    findings = []
    fence_mask = [False] * len(lines)
    open_char = None
    open_len = 0
    open_line = None

    def fence_match(raw_line):
        # CommonMark/GFM only recognizes a fence indented by at most three
        # spaces; four or more spaces (or a leading tab, which expands to
        # 4+ columns) is indented code, not a fence.
        expanded = raw_line.expandtabs(4)
        indent = len(expanded) - len(expanded.lstrip(" "))
        if indent > 3:
            return None
        return FENCE_RE.match(raw_line.strip())

    for i, line in enumerate(lines):
        m = fence_match(line)
        if open_char is None:
            if m:
                marker, info = m.group(1), m.group(2).strip()
                open_char, open_len, open_line = marker[0], len(marker), i + 1
                fence_mask[i] = True
                if not info:
                    findings.append(
                        Finding(
                            line=i + 1,
                            category="code_fence_no_lang",
                            message="Code block has no language tag (recommended for syntax highlighting and copy detection).",
                            snippet=line.strip(),
                        )
                    )
            continue

        fence_mask[i] = True
        if m:
            marker, info = m.group(1), m.group(2).strip()
            is_closing = marker[0] == open_char and len(marker) >= open_len and not info
            if is_closing:
                open_char, open_len, open_line = None, 0, None

    if open_char is not None:
        findings.append(
            Finding(
                line=open_line or 0,
                category="unclosed_code_fence",
                message="A code block may not be closed.",
            )
        )
    return findings, fence_mask


def check_heading_hierarchy(lines: list, fence_mask: list) -> list:
    findings = []
    prev_level = 0
    for i, line in enumerate(lines):
        if fence_mask[i]:
            continue
        m = HEADING_RE.match(line)
        if not m:
            continue
        level = len(m.group(1))
        text = m.group(2).strip()
        if prev_level and level > prev_level + 1:
            findings.append(
                Finding(
                    line=i + 1,
                    category="heading_skip",
                    message=f"Heading level jumps from H{prev_level} to H{level}.",
                    snippet=line.strip(),
                )
            )
        stripped = text.rstrip(":：").strip().lower()
        if stripped in GENERIC_HEADINGS:
            findings.append(
                Finding(
                    line=i + 1,
                    category="generic_heading",
                    message="Generic heading label; make it preview the content instead (structure constitution rule 2).",
                    snippet=line.strip(),
                )
            )
        prev_level = level
    return findings


# @id CODE-TW-PH-002
# @implements REQ-TW-PH-002
def strip_placeholder_context(line: str) -> str:
    checked = strip_inline_code(line)
    for match in MD_LINK_RE.finditer(checked):
        start, end = match.span(2)
        checked = checked[:start] + " " * (end - start) + checked[end:]
    for pattern in (URL_TOKEN_RE, COMPOUND_IDENTIFIER_RE):
        checked = pattern.sub(lambda match: " " * len(match.group(0)), checked)
    return checked


# @id CODE-TW-PH-001
# @implements REQ-TW-PH-001
def check_placeholders(lines: list, fence_mask: list) -> list:
    findings = []
    for i, line in enumerate(lines):
        if fence_mask[i]:
            continue
        checked = strip_placeholder_context(line)
        for m in PLACEHOLDER_RE.finditer(checked):
            suffix = line[m.end():].lstrip(" \t")
            # Unpunctuated lower-case names remain ambiguous; require an
            # explicit colon or annotation before treating them as markers.
            if (
                m.group(1).lower() == "todo"
                and not m.group(1).isupper()
                and not suffix.startswith((":", "\uff1a", "("))
            ):
                continue
            # A justified/tracked marker like "TODO(#123): ..." documents a
            # reason and a tracking reference, which is exactly what this
            # skill's own guidance asks for — don't flag that form. An empty
            # "TODO()" carries no reason at all, so it still gets flagged.
            if suffix.startswith("("):
                close_idx = suffix.find(")")
                content = suffix[1:close_idx] if close_idx != -1 else ""
                if content.strip():
                    continue
            findings.append(
                Finding(
                    line=i + 1,
                    category="placeholder",
                    message=f"Unresolved placeholder '{m.group(1)}' remains without a reason/tracking reference; resolve before publishing.",
                    snippet=line.strip(),
                )
            )
    return findings


def check_links(lines: list, fence_mask: list) -> list:
    findings = []
    for i, line in enumerate(lines):
        if fence_mask[i]:
            continue
        checked = strip_inline_code(line)
        for m in MD_LINK_RE.finditer(checked):
            text, target = m.group(1), m.group(2)
            if not text.strip():
                findings.append(
                    Finding(
                        line=i + 1,
                        category="empty_link_text",
                        message="Link text is empty. Avoid content-free link text like 'here'/'こちら' too.",
                        snippet=line.strip(),
                    )
                )
            if target.strip() in ("#", "", "javascript:void(0)"):
                findings.append(
                    Finding(
                        line=i + 1,
                        category="dead_link_placeholder",
                        message="Link target is still an unset placeholder.",
                        snippet=line.strip(),
                    )
                )
    return findings


def check_bold_spacing(lines: list, fence_mask: list) -> list:
    """Flag bold delimiters with missing or non-ASCII surrounding spaces.

    Some Markdown renderers fail to recognize strong emphasis when `**`
    directly adjoins Japanese or other word characters. Punctuation and
    line boundaries do not need padding. When padding is present, it must
    be an ASCII half-width space rather than a tab or Unicode space.
    """
    findings = []
    for i, line in enumerate(lines):
        if fence_mask[i]:
            continue
        checked = strip_inline_code(line)
        for match in BOLD_RE.finditer(checked):
            before = checked[match.start() - 1] if match.start() else ""
            after = checked[match.end()] if match.end() < len(checked) else ""
            if (before and (before.isalnum() or before == "_")) or (
                after and (after.isalnum() or after == "_")
            ) or (
                before and before.isspace() and before != " "
            ) or (
                after and after.isspace() and after != " "
            ):
                findings.append(
                    Finding(
                        line=i + 1,
                        category="bold_spacing",
                        message=(
                            "Use ASCII half-width spaces immediately before "
                            "and after '**...**' when it is embedded in prose; "
                            "do not use full-width or other Unicode spaces."
                        ),
                        snippet=line.strip(),
                    )
                )
    return findings


def check_intro_paragraph(lines: list, fence_mask: list) -> list:
    """Check that the document opens with a non-empty H1 title immediately
    followed by a genuine body paragraph.

    This is a heuristic proxy for structure constitution rule 1 ("say what
    this is and the outcome up front"). The very first non-blank line after
    the title must be plain prose — a list item, blockquote, HTML comment,
    table row, thematic break, another heading, a fenced code block, or
    indented code does not count, even if real prose follows it further
    down. A leading YAML frontmatter block (e.g. skill metadata, or a
    platform frontmatter with its own `title:` field such as Zenn/Qiita) is
    skipped before this check begins; fenced code is only skipped while
    still searching for the title itself (a heading can't appear inside
    one).

    A frontmatter block that already carries a non-empty `title:` field
    counts as satisfying the title requirement on its own — those platforms
    render that field as the page/article title and conventionally don't
    repeat it as an in-body '#' heading.
    """
    start = 0
    frontmatter_has_title = False
    if lines and lines[0].strip() == "---":
        for j in range(1, len(lines)):
            if lines[j].strip() == "---":
                start = j + 1
                break
            if TITLE_FIELD_RE.match(lines[j]):
                frontmatter_has_title = True
    state = "after_title" if frontmatter_has_title else "before_title"
    for i, line in enumerate(lines):
        if i < start:
            continue
        if state == "before_title" and fence_mask[i]:
            continue
        stripped = line.strip()
        if not stripped:
            continue
        if state == "after_title" and (fence_mask[i] or INDENTED_CODE_RE.match(line)):
            # Fenced or indented code right after the title isn't prose.
            break
        m = HEADING_RE.match(stripped)
        if state == "before_title":
            if m and len(m.group(1)) == 1 and m.group(2).strip():
                state = "after_title"
                continue
            # Either the first heading isn't a non-empty top-level title,
            # or non-heading content appeared before any title — either way
            # there's nothing valid to anchor the check against.
            break
        # state == "after_title": the very next non-blank line decides it.
        if m or NON_PARAGRAPH_RE.match(stripped):
            break
        return []
    return [
        Finding(
            line=1,
            category="missing_intro",
            message="Document must open with a non-empty '#' title heading immediately followed by a plain-prose paragraph (not a list, blockquote, comment, table, code block, or another heading) stating what this is and the reader outcome (structure constitution rule 1).",
        )
    ]


# @id CODE-TW-PH-003
# @implements REQ-TW-PH-003
def run_lint(path: Path, atomic: bool = False) -> LintResult:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    result = LintResult(file=str(path))
    fence_findings, fence_mask = parse_fences(lines)
    result.findings.extend(fence_findings)
    result.findings.extend(check_heading_hierarchy(lines, fence_mask))
    result.findings.extend(check_placeholders(lines, fence_mask))
    result.findings.extend(check_links(lines, fence_mask))
    result.findings.extend(check_bold_spacing(lines, fence_mask))
    if not atomic:
        # check_intro_paragraph assumes a living, multi-section document
        # (H1 title + opening paragraph); atomic artifacts like a PR
        # description or a single release-notes entry follow their own
        # doctype skeleton instead (see style-constitution.md's scope
        # note) and legitimately have no H1 at all.
        result.findings.extend(check_intro_paragraph(lines, fence_mask))
    result.findings.sort(key=lambda f: f.line)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="tech-writer structural lint")
    parser.add_argument("file", type=str, help="Target Markdown file")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument(
        "--atomic",
        action="store_true",
        help=(
            "Lint as an atomic artifact (commit message, PR description, "
            "issue report, code comment/docstring, a single release-notes "
            "entry): skips the living-document intro-paragraph check, "
            "which doesn't apply to these doctypes' own skeletons."
        ),
    )
    args = parser.parse_args()

    path = Path(args.file)
    if not path.is_file():
        print(f"error: file not found: {path}", file=sys.stderr)
        return 1

    try:
        result = run_lint(path, atomic=args.atomic)
    except OSError as e:
        print(f"error: failed to read file: {e}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    else:
        if not result.findings:
            print(f"{path}: no structural findings.")
        else:
            print(f"{path}: {len(result.findings)} finding(s)")
            for f in result.findings:
                print(f"  L{f.line} [{f.category}] {f.message}")
                if f.snippet:
                    print(f"    > {f.snippet}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
