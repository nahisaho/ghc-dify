#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "ginza>=5.3.0,<5.4",
#   "ja-ginza>=5.3.0,<5.4",
#   "spacy>=3.8.16,<4",
# ]
# ///
# @id CODE-GINZA-002 @implements REQ-GINZA-001
"""Extract terminology candidates with GiNZA POS and entity analysis."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

from core import iter_prose_blocks, load_ginza, read_text, sentence_line


ASCII_TERM_RE = re.compile(r"^[A-Za-z][A-Za-z0-9.+#/_-]{1,}$")
EXPLANATION_MARKERS = ("とは", "を指す", "と呼ぶ", "（", "(")


def is_candidate(token) -> bool:
    if token.ent_type_:
        return True
    if token.pos_ == "PROPN":
        return True
    return bool(ASCII_TERM_RE.match(token.text))


def extract(path: Path) -> dict:
    text = read_text(path)
    blocks = iter_prose_blocks(text)
    nlp = load_ginza(enable_ner=True)
    terms: dict[str, dict] = {}
    occurrences: dict[str, list[int]] = defaultdict(list)

    for block, doc in zip(blocks, nlp.pipe([item.text for item in blocks])):
        for token in doc:
            if not is_candidate(token):
                continue
            value = token.text.strip()
            if len(value) < 2:
                continue
            line = sentence_line(block, token.idx)
            occurrences[value].append(line)
            if value not in terms:
                context = block.text[
                    max(0, token.idx - 30) : token.idx + len(value) + 45
                ]
                explained = any(
                    marker in block.text[token.idx + len(value) : token.idx + len(value) + 24]
                    for marker in EXPLANATION_MARKERS
                )
                terms[value] = {
                    "term": value,
                    "lemma": token.lemma_,
                    "pos": token.pos_,
                    "entity": token.ent_type_ or None,
                    "first_line": line,
                    "explained_near_first_use": explained,
                    "context": re.sub(r"\s+", " ", context).strip(),
                }

    result_terms = []
    for value, item in terms.items():
        item["count"] = len(occurrences[value])
        item["lines"] = sorted(set(occurrences[value]))
        result_terms.append(item)
    result_terms.sort(key=lambda item: (item["first_line"], item["term"]))
    return {
        "file": str(path),
        "engine": "GiNZA",
        "term_count": len(result_terms),
        "terms": result_terms,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract terminology candidates")
    parser.add_argument("file")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        result = extract(Path(args.file))
    except OSError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"error: GiNZA analysis failed: {error}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for item in result["terms"]:
            marker = "explained" if item["explained_near_first_use"] else "review"
            entity = f" {item['entity']}" if item["entity"] else ""
            print(
                f"L{item['first_line']} {item['term']} "
                f"({item['pos']}{entity}, {item['count']} occurrence(s), {marker})"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
