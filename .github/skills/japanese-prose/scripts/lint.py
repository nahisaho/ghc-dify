#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "ginza>=5.3.0,<5.4",
#   "ja-ginza>=5.3.0,<5.4",
#   "spacy>=3.8.16,<4",
# ]
# ///
# @id CODE-GINZA-001 @implements REQ-GINZA-001
"""GiNZA-based Japanese prose diagnostics developed for kotonoha."""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import Counter
from pathlib import Path

from core import (
    Finding,
    content_tokens,
    dependency_depth,
    excerpt,
    finding_key,
    iter_prose_blocks,
    load_ginza,
    read_text,
    score_findings,
    sentence_line,
)


PHRASE_RULES = {
    "と言えるでしょう": ("formulaic_conclusion", "断定を弱める定型句です。根拠か具体的な判断に置き換えます。"),
    "と言えるだろう": ("formulaic_conclusion", "断定を弱める定型句です。根拠か具体的な判断に置き換えます。"),
    "いかがでしょうか": ("reader_prompt_cliche", "読者への定型的な呼びかけです。必要な行動を直接示します。"),
    "結論として": ("formulaic_transition", "結論の内容を見出しまたは先頭文で直接示します。"),
    "以下のとおりです": ("empty_preview", "後続内容の要点を先に示します。"),
    "重要なポイント": ("abstract_emphasis", "何が重要かを具体的な条件や数値で示します。"),
}

TRANSLATIONESE_RULES = (
    (
        re.compile(r"することが(?:可能|できます|できる)"),
        "indirect_ability",
        "「できる」または具体的な動作へ簡潔にします。",
    ),
    (
        re.compile(r"において(?:は|、)?"),
        "heavy_location_phrase",
        "場所・場面を表すなら「で」で意味が保てるか確認します。",
    ),
    (
        re.compile(r"を通じて(?:、)?"),
        "through_translation",
        "手段・期間・経験のどれを表すか具体化します。",
    ),
)

CONNECTIVES = {
    "また",
    "さらに",
    "一方",
    "そのため",
    "したがって",
    "しかし",
    "なお",
}

DOUBLE_NEGATIVE_RULES = (
    re.compile(r"ないとは言えない"),
    re.compile(r"ないわけではない"),
    re.compile(r"ないことはない"),
    re.compile(r"なくはない"),
)

BRACKET_PAIRS = dict(zip("（［｛「『【", "）］｝」』】"))
POLITE_END_RE = re.compile(r"(?:です|ます|でした|ました|ません(?:でした)?|でしょう|ましょう|ください|下さい)$")
PLAIN_END_RE = re.compile(r"(?:である|だった|だ|る|た|ない)$")

GENRE_LIMITS = {
    "general": {"length": 90, "critical_length": 150, "commas": 5, "depth": 8},
    "tech": {"length": 110, "critical_length": 180, "commas": 6, "depth": 9},
    "business": {"length": 80, "critical_length": 140, "commas": 5, "depth": 8},
}


def add(
    findings: list[Finding],
    line: int,
    category: str,
    severity: str,
    message: str,
    text: str,
    evidence: dict | None = None,
) -> None:
    findings.append(
        Finding(line, category, severity, message, excerpt(text), evidence)
    )


def proofread(block, doc, findings: list[Finding]) -> None:
    stack: list[str] = []
    unbalanced = False
    for character in block.text:
        if character in BRACKET_PAIRS:
            stack.append(character)
        elif character in BRACKET_PAIRS.values():
            if not stack or BRACKET_PAIRS[stack[-1]] != character:
                unbalanced = True
            else:
                stack.pop()
    if stack or unbalanced:
        add(
            findings, block.start_line, "unbalanced_brackets", "warning",
            "括弧の対応が取れていません。引用や数式として意図した表記か確認します。",
            block.text,
        )

    for previous, current in zip(doc, doc[1:]):
        if previous.idx + len(previous.text) != current.idx or previous.text != current.text:
            continue
        particle = previous.pos_ == current.pos_ == "ADP"
        word = (
            len(current.text) >= 2
            and previous.pos_ == current.pos_
            and current.pos_ in {"NOUN", "VERB", "ADJ", "ADV"}
        )
        if particle or word:
            add(
                findings, sentence_line(block, current.idx),
                "duplicate_particle" if particle else "duplicate_word", "warning",
                "同じ助詞が隣接しています。誤入力による重複か確認します。"
                if particle else "同じ語が隣接しています。意図した反復か確認します。",
                current.sent.text, {"repeated": current.text},
            )

    first_style = None
    for sent in doc.sents:
        if re.search(r'[「」『』"“”]', sent.text):
            continue
        ending = sent.text.strip().rstrip("。！？!?")
        style = (
            "polite" if POLITE_END_RE.search(ending)
            else "plain" if PLAIN_END_RE.search(ending)
            else None
        )
        if style and first_style and style != first_style:
            add(
                findings, sentence_line(block, sent.start_char),
                "mixed_sentence_style", "warning",
                "同じ段落に敬体と常体が混在しています。引用や意図した使い分けか確認します。",
                sent.text,
            )
            break
        if style:
            first_style = style


def analyze(path: Path, genre: str, reading_load: bool) -> dict:
    text = read_text(path)
    blocks = iter_prose_blocks(text)
    nlp = load_ginza(enable_ner=False)
    limits = GENRE_LIMITS[genre]
    findings: list[Finding] = []
    sentence_records: list[dict] = []
    paragraph_leads: list[tuple[int, str]] = []

    for block, doc in zip(blocks, nlp.pipe([item.text for item in blocks])):
        if not reading_load:
            proofread(block, doc, findings)
        paragraph_tokens = content_tokens(doc)
        if paragraph_tokens:
            paragraph_leads.append((block.start_line, paragraph_tokens[0].lemma_))

        for phrase, (category, message) in PHRASE_RULES.items():
            pattern = re.escape(phrase)
            if category == "formulaic_conclusion":
                pattern += r"(?!か|[?？])"
            if not reading_load and re.search(pattern, block.text):
                add(findings, block.start_line, category, "warning", message, block.text)

        if not reading_load:
            for pattern, category, message in TRANSLATIONESE_RULES:
                if pattern.search(block.text):
                    add(findings, block.start_line, category, "info", message, block.text)

        for sent in doc.sents:
            tokens = content_tokens(sent)
            if not tokens:
                continue
            sent_text = sent.text.strip()
            line = sentence_line(block, sent.start_char)
            length = len(re.sub(r"\s+", "", sent_text))
            comma_count = sent_text.count("、")
            max_depth = max((dependency_depth(token) for token in tokens), default=0)

            noun_run = 0
            max_noun_run = 0
            genitive_count = 0
            max_genitive_count = 0
            for token in sent:
                if token.is_space or token.is_punct or token.pos_ == "SYM":
                    noun_run = 0
                    genitive_count = 0
                    continue
                if token.pos_ in {"NOUN", "PROPN"}:
                    noun_run += 1
                    max_noun_run = max(max_noun_run, noun_run)
                else:
                    noun_run = 0
                if token.lemma_ == "の" and token.pos_ == "ADP":
                    genitive_count += 1
                    max_genitive_count = max(max_genitive_count, genitive_count)
                elif token.pos_ in {"VERB", "AUX"}:
                    genitive_count = 0

            first_lemmas = tuple(token.lemma_ for token in tokens[:2])
            final_pos = tokens[-1].pos_
            verb_count = sum(
                token.pos_ in {"VERB", "AUX"} for token in tokens
            )
            enumeration = comma_count > limits["commas"] and verb_count <= 1
            sentence_records.append(
                {
                    "line": line,
                    "text": sent_text,
                    "length": length,
                    "first": first_lemmas,
                    "final_pos": final_pos,
                }
            )

            if length > limits["length"] and not enumeration:
                severity = (
                    "critical"
                    if length > limits["critical_length"]
                    else "warning"
                )
                add(
                    findings,
                    line,
                    "long_sentence",
                    severity,
                    "一文が長く、係り受けを保持しにくい状態です。意味単位で分割できるか確認します。",
                    sent_text,
                    {"characters": length, "threshold": limits["length"]},
                )
            if comma_count > limits["commas"] and not enumeration:
                add(
                    findings,
                    line,
                    "comma_overload",
                    "warning",
                    "読点が多く、複数の論点が一文に入っている可能性があります。",
                    sent_text,
                    {"commas": comma_count, "threshold": limits["commas"]},
                )
            if max_depth > limits["depth"] and not enumeration:
                add(
                    findings,
                    line,
                    "deep_dependency",
                    "warning",
                    "係り受けが深く、文の骨格を追う負荷が高い状態です。",
                    sent_text,
                    {"depth": max_depth, "threshold": limits["depth"]},
                )
            if max_noun_run >= 6:
                add(
                    findings,
                    line,
                    "noun_chain",
                    "warning",
                    "名詞が連続しています。助詞や述語を補って関係を明示します。",
                    sent_text,
                    {"consecutive_nouns": max_noun_run},
                )
            if max_genitive_count >= 3:
                add(
                    findings,
                    line,
                    "genitive_chain",
                    "info",
                    "「の」が重なっています。所有・対象・所属の関係を分けられるか確認します。",
                    sent_text,
                    {"consecutive_genitives": max_genitive_count},
                )
            if any(pattern.search(sent_text) for pattern in DOUBLE_NEGATIVE_RULES):
                add(
                    findings,
                    line,
                    "double_negative",
                    "warning",
                    "否定が重なっています。肯定文で同じ意味を表せるか確認します。",
                    sent_text,
                )

    if not reading_load:
        for previous, current in zip(sentence_records, sentence_records[1:]):
            if current["first"] and current["first"] == previous["first"]:
                add(
                    findings,
                    current["line"],
                    "repeated_sentence_lead",
                    "info",
                    "連続する文が同じ語順で始まっています。意図した反復か確認します。",
                    current["text"],
                    {"lemmas": list(current["first"])},
                )

        if len(sentence_records) >= 5:
            lengths = [record["length"] for record in sentence_records]
            mean = statistics.mean(lengths)
            if mean and statistics.pstdev(lengths) / mean < 0.16:
                add(
                    findings,
                    0,
                    "uniform_sentence_rhythm",
                    "info",
                    "文長が均一です。重要度に応じた長短があるか通読します。",
                    "文書全体の文長分布",
                    {"coefficient_of_variation": round(statistics.pstdev(lengths) / mean, 3)},
                )

            nominal_count = sum(
                record["final_pos"] in {"NOUN", "PROPN"}
                for record in sentence_records
            )
            if nominal_count / len(sentence_records) >= 0.55:
                add(
                    findings,
                    0,
                    "nominal_ending_density",
                    "info",
                    "体言止めが多く、説明の関係が省略されている可能性があります。",
                    "文書全体の文末分布",
                    {
                        "ratio": round(nominal_count / len(sentence_records), 3),
                        "sentences": len(sentence_records),
                    },
                )

        lead_counts = Counter(lemma for _, lemma in paragraph_leads if lemma in CONNECTIVES)
        for lemma, count in lead_counts.items():
            if count >= 3:
                line = next(line for line, value in paragraph_leads if value == lemma)
                add(
                    findings,
                    line,
                    "repeated_paragraph_connective",
                    "info",
                    "複数段落が同じ接続表現で始まっています。",
                    lemma,
                    {"connective": lemma, "count": count},
                )

    findings.sort(key=lambda item: (item.line, item.category))
    return {
        "file": str(path),
        "engine": "GiNZA",
        "model": nlp.meta.get("name", "ja_ginza"),
        "genre": genre,
        "mode": "reading-load" if reading_load else "prose",
        "score": score_findings(findings),
        "finding_count": len(findings),
        "findings": [item.to_dict() for item in findings],
    }


def compare_baseline(result: dict, baseline_path: Path) -> None:
    baseline = json.loads(read_text(baseline_path))
    previous = {
        finding_key(
            Finding(
                item.get("line", 0),
                item["category"],
                item.get("severity", "warning"),
                item.get("message", ""),
                item.get("excerpt", ""),
            )
        )
        for item in baseline.get("findings", [])
    }
    current = set()
    for item in result["findings"]:
        finding = Finding(
            item["line"],
            item["category"],
            item["severity"],
            item["message"],
            item["excerpt"],
            item.get("evidence"),
        )
        key = finding_key(finding)
        current.add(key)
        item["status"] = "persisting" if key in previous else "new"
    result["resolved_count"] = len(previous - current)
    result["new_count"] = len(current - previous)
    result["persisting_count"] = len(current & previous)


def main() -> int:
    parser = argparse.ArgumentParser(description="GiNZA-based Japanese prose lint")
    parser.add_argument("file")
    parser.add_argument("--genre", choices=GENRE_LIMITS, default="general")
    parser.add_argument("--reading-load", action="store_true")
    parser.add_argument("--baseline")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    try:
        result = analyze(Path(args.file), args.genre, args.reading_load)
        if args.baseline:
            compare_baseline(result, Path(args.baseline))
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"error: GiNZA analysis failed: {error}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(
            f"{result['file']}: score {result['score']}/100, "
            f"{result['finding_count']} finding(s)"
        )
        for finding in result["findings"]:
            print(
                f"  L{finding['line']} [{finding['severity']}] "
                f"{finding['category']}: {finding['message']}"
            )
            print(f"    > {finding['excerpt']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
