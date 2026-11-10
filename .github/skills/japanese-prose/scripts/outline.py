#!/usr/bin/env python3
"""Extract headings and paragraph openings from a Markdown document."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from core import excerpt, iter_content_lines, iter_prose_blocks, read_text


HEADING_CAPTURE_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*$")


def extract(path: Path) -> dict:
    text = read_text(path)
    headings = []
    for line_number, line in iter_content_lines(text):
        match = HEADING_CAPTURE_RE.match(line)
        if match:
            headings.append(
                {
                    "line": line_number,
                    "level": len(match.group(1)),
                    "text": match.group(2),
                }
            )
    paragraphs = [
        {"line": block.start_line, "opening": excerpt(block.text, 140)}
        for block in iter_prose_blocks(text)
    ]
    return {
        "file": str(path),
        "heading_count": len(headings),
        "paragraph_count": len(paragraphs),
        "headings": headings,
        "paragraphs": paragraphs,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract a Markdown skeleton")
    parser.add_argument("file")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        result = extract(Path(args.file))
    except OSError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for heading in result["headings"]:
            print(
                f"L{heading['line']} H{heading['level']} {heading['text']}"
            )
        for paragraph in result["paragraphs"]:
            print(f"L{paragraph['line']} P {paragraph['opening']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
