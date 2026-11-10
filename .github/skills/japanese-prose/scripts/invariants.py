#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["markdown-it-py>=3,<5"]
# ///
"""Check protected content and require a hash-bound semantic review of edits."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

from markdown_it import MarkdownIt


SEMANTIC_CHECKS = (
    "actors", "negation", "conditions", "modality", "scope", "causality",
    "quantity_bindings", "terminology", "structure",
)
NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)*")
IDENTIFIER_RE = re.compile(r"(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+(?![A-Za-z0-9_])")
QUANTITY_RE = re.compile(
    r"(\d+(?:[.,]\d+)*)\s*"
    r"(ミリ秒|時間|年間|か月|ヶ月|秒|分|日|週|月|年|回|件|台|人|個|円|倍|"
    r"[A-Za-zµμ]+(?:/[A-Za-zµμ]+)?|%|％|℃)(?![A-Za-z])"
)
BARE_URL_RE = re.compile(r"https?://[^\s<>`\"()\[\]、。！？「」『』（）]+")


def fingerprint(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def snapshot(text: str, protected_terms: list[str]) -> dict:
    lines = text.splitlines(keepends=True)
    frontmatter = ""
    body = text
    if lines and lines[0].strip() == "---":
        end = next(
            (index for index in range(1, len(lines)) if lines[index].strip() in {"---", "..."}),
            None,
        )
        if end is not None:
            frontmatter = "".join(lines[:end + 1])
            body = "".join(lines[end + 1:])
    body_lines = body.splitlines(keepends=True)
    tokens = MarkdownIt("commonmark").enable("table").parse(body)
    blocks = []
    headings = []
    code = []
    links = []
    html = []
    for token in tokens:
        if token.type in {"fence", "code_block", "table_open", "html_block"}:
            if token.map is None:
                raise ValueError(f"Missing source map for {token.type}")
            start, end = token.map
            blocks.append((token.type, "".join(body_lines[start:end])))
        if token.type == "heading_open":
            headings.append(token.tag)
        for child in token.children or []:
            if child.type == "code_inline":
                code.append(child.content)
            elif child.type == "link_open":
                links.append(child.attrGet("href"))
            elif child.type == "image":
                links.append(child.attrGet("src"))
            elif child.type == "html_inline":
                html.append(child.content)
    return {
        "frontmatter": frontmatter,
        "protected_blocks": blocks,
        "heading_levels": headings,
        "inline_code": code,
        "link_destinations": links,
        "html_tags": html,
        "numbers_in_order": NUMBER_RE.findall(text),
        "quantities_in_order": QUANTITY_RE.findall(text),
        "identifiers_in_order": IDENTIFIER_RE.findall(text),
        "bare_urls_in_order": BARE_URL_RE.findall(text),
        "protected_terms": {term: text.count(term) for term in protected_terms},
    }


def check(
    before: Path,
    after: Path,
    protected_terms: list[str] | None = None,
    review_path: Path | None = None,
) -> dict:
    review = (
        json.loads(review_path.read_text(encoding="utf-8"))
        if review_path is not None else None
    )
    if review_path is not None and not isinstance(review, dict):
        raise ValueError("Semantic review must be a JSON object")
    return check_bytes(
        before.read_bytes(), after.read_bytes(), protected_terms, review,
        before_name=str(before), after_name=str(after),
    )


def check_bytes(
    original: bytes,
    edited: bytes,
    protected_terms: list[str] | None = None,
    review: dict | None = None,
    *,
    before_name: str = "<before>",
    after_name: str = "<after>",
) -> dict:
    terms = protected_terms or []
    if any(not term.strip() for term in terms):
        raise ValueError("Protected terms must not be empty")
    before_hash = hashlib.sha256(original).hexdigest()
    after_hash = hashlib.sha256(edited).hexdigest()
    initial = snapshot(original.decode("utf-8"), terms)
    final = snapshot(edited.decode("utf-8"), terms)
    violations = [
        {
            "category": name,
            "message": f"Protected content changed: {name}",
            "before_fingerprint": fingerprint(initial[name]),
            "after_fingerprint": fingerprint(final[name]),
        }
        for name in initial if initial[name] != final[name]
    ]
    review_errors = []
    review_required = original != edited
    reviewer = None
    if review is not None:
        if not isinstance(review, dict):
            raise ValueError("Semantic review must be a JSON object")
        reviewer = review.get("reviewer")
        if not isinstance(reviewer, str) or not reviewer.strip():
            review_errors.append("reviewer must be a non-empty identifier")
        if review.get("before_sha256") != before_hash or review.get("after_sha256") != after_hash:
            review_errors.append("review hashes do not match this exact before/after pair")
        checks = review.get("checks")
        if not isinstance(checks, dict):
            review_errors.append("checks must be an object")
        else:
            review_errors.extend(
                f"{name} has not been affirmed" for name in SEMANTIC_CHECKS
                if checks.get(name) is not True
            )
    elif review_required:
        review_errors.append("changed text requires a hash-bound semantic review")
    status = "blocked" if violations else "review_required" if review_errors else "passed"
    return {
        "before": before_name,
        "after": after_name,
        "before_sha256": before_hash,
        "after_sha256": after_hash,
        "status": status,
        "mechanical_violations": violations,
        "semantic_review_required": review_required,
        "semantic_checks": list(SEMANTIC_CHECKS),
        "semantic_review_errors": review_errors,
        "reviewer": reviewer,
        "limitations": [
            "Mechanical equality does not prove semantic equivalence.",
            "Proper names and domain terms require caller-supplied --protect values and contextual review.",
            "Semantic checks are reviewer attestations, not automated entailment judgments.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before")
    parser.add_argument("after")
    parser.add_argument("--protect", action="append", default=[])
    parser.add_argument("--review", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        result = check(Path(args.before), Path(args.after), args.protect, args.review)
    except (OSError, ValueError, UnicodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"{result['status']}: {args.before} -> {args.after}")
        for violation in result["mechanical_violations"]:
            print(f"  {violation['message']}")
        for error in result["semantic_review_errors"]:
            print(f"  Semantic review: {error}")
    return {"passed": 0, "blocked": 2, "review_required": 3}[result["status"]]


if __name__ == "__main__":
    sys.exit(main())
