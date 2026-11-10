#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "ginza>=5.3.0,<5.4",
#   "ja-ginza>=5.3.0,<5.4",
#   "spacy>=3.8.16,<4",
#   "markdown-it-py>=3,<5",
# ]
# ///
"""Behavioral tests for kotonoha's original GiNZA diagnostics."""

from __future__ import annotations

import json
import hashlib
import importlib.metadata
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from packaging.version import Version

from core import load_ginza, strip_markdown_inline
from lint import analyze, compare_baseline
from outline import extract as extract_outline
from terms import extract as extract_terms
from invariants import SEMANTIC_CHECKS, check as check_invariants


SCRIPT_DIR = Path(__file__).resolve().parent
FIXTURES = SCRIPT_DIR / "fixtures"


class DiagnosticTests(unittest.TestCase):
    def test_ginza_53_environment_and_model(self) -> None:
        for package in ("ginza", "ja-ginza"):
            self.assertEqual(
                importlib.metadata.version(package).split(".")[:2],
                ["5", "3"],
                f"{package} must resolve to the supported 5.3 series",
            )
        spacy_version = Version(importlib.metadata.version("spacy"))
        self.assertGreaterEqual(spacy_version, Version("3.8.16"))
        self.assertLess(spacy_version, Version("4"))
        self.assertEqual(load_ginza().meta["lang"], "ja")
        self.assertNotIn("ner", load_ginza().pipe_names)
        self.assertIn("ner", load_ginza(enable_ner=True).pipe_names)

    def analyze_text(self, text: str, reading_load: bool = False) -> dict:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.md"
            path.write_text(text, encoding="utf-8")
            return analyze(path, "tech", reading_load)

    def test_proofreading_detects_adjacent_duplicates(self) -> None:
        for text, category in (
            ("管理者が設定をを確認します。", "duplicate_particle"),
            ("管理者がが設定を確認します。", "duplicate_particle"),
            ("管理者にに通知します。", "duplicate_particle"),
            ("設定設定を保存します。", "duplicate_word"),
        ):
            with self.subTest(text=text):
                result = self.analyze_text(text)
                self.assertIn(category, {item["category"] for item in result["findings"]})
                self.assertNotIn(
                    category,
                    {item["category"] for item in self.analyze_text(text, True)["findings"]},
                )

    def test_proofreading_checks_brackets_and_paragraph_style(self) -> None:
        for text, category in (
            ("設定（管理者向け））を保存します。", "unbalanced_brackets"),
            ("設定を保存します。変更はすぐに反映される。", "mixed_sentence_style"),
        ):
            with self.subTest(text=text):
                self.assertIn(category, {
                    item["category"] for item in self.analyze_text(text)["findings"]
                })

    def test_proofreading_preserves_names_code_and_deliberate_styles(self) -> None:
        text = (
            "ののさんは、ももを食べます。操作を確認してください。\n\n"
            "「設定を保存する」と説明します。結果を確認します。\n\n"
            "設定を保存する。\n\n設定を確認します。\n\n"
            "`設定設定（`という識別子を使用します。\n\n"
            "```text\n設定をを確認します（\n```\n"
        )
        categories = {item["category"] for item in self.analyze_text(text)["findings"]}
        self.assertFalse(categories & {
            "duplicate_particle", "duplicate_word", "unbalanced_brackets", "mixed_sentence_style",
        })

    def test_short_fences_and_fence_info_do_not_expose_code_as_prose(self) -> None:
        for text in (
            "````text\n```python\n設定設定（をを確認する。\n```\n````\n",
            "```text\n```python\n設定設定（をを確認する。\n```\n",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.analyze_text(text)["findings"], [])

    def test_questions_and_obligations_are_not_style_errors(self) -> None:
        for text in (
            "この結果だけでは、安全だと言えるでしょうか。",
            "この結果だけでは、安全だと言えるだろうか。",
            "管理者は確認しなくてはならない。",
            "この場合は停止せざるを得ない。",
        ):
            with self.subTest(text=text):
                categories = {item["category"] for item in self.analyze_text(text)["findings"]}
                self.assertNotIn("formulaic_conclusion", categories)
                self.assertNotIn("double_negative", categories)

    def test_unnatural_fixture_scores_below_natural_fixture(self) -> None:
        unnatural = analyze(FIXTURES / "unnatural.md", "tech", False)
        natural = analyze(FIXTURES / "natural.md", "tech", False)

        self.assertLess(unnatural["score"], natural["score"])
        self.assertEqual(natural["finding_count"], 0)
        categories = {item["category"] for item in unnatural["findings"]}
        self.assertIn("formulaic_conclusion", categories)
        self.assertIn("double_negative", categories)
        self.assertIn("deep_dependency", categories)

    def test_markdown_code_is_not_analyzed_as_prose(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "code.md"
            path.write_text(
                "# Test\n\n自然な説明です。\n\n"
                "```text\n結論として、利用することが可能です。\n```\n",
                encoding="utf-8",
            )
            result = analyze(path, "tech", False)
            categories = {item["category"] for item in result["findings"]}
            self.assertNotIn("formulaic_transition", categories)
            self.assertNotIn("indirect_ability", categories)

    def test_inline_code_is_masked_without_corrupting_plain_identifiers(self) -> None:
        self.assertEqual(strip_markdown_inline("`MAX_RETRY_COUNT`"), "コード")
        self.assertEqual(
            strip_markdown_inline("MAX_RETRY_COUNTを確認する"),
            "MAX_RETRY_COUNTを確認する",
        )

    def test_ordinary_conditional_negation_is_not_double_negative(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "condition.md"
            path.write_text(
                "# Test\n\n設定が存在しない場合、既定値は適用されません。\n",
                encoding="utf-8",
            )
            result = analyze(path, "tech", False)
        categories = {item["category"] for item in result["findings"]}
        self.assertNotIn("double_negative", categories)

    def test_baseline_reports_resolved_findings(self) -> None:
        initial = analyze(FIXTURES / "unnatural.md", "tech", False)
        final = analyze(FIXTURES / "natural.md", "tech", False)
        with tempfile.TemporaryDirectory() as directory:
            baseline = Path(directory) / "baseline.json"
            baseline.write_text(
                json.dumps(initial, ensure_ascii=False),
                encoding="utf-8",
            )
            compare_baseline(final, baseline)
        self.assertGreater(final["resolved_count"], 0)
        self.assertEqual(final["new_count"], 0)

    def test_outline_and_terms_return_structured_results(self) -> None:
        outline = extract_outline(FIXTURES / "natural.md")
        terms = extract_terms(FIXTURES / "natural.md")
        self.assertEqual(outline["heading_count"], 1)
        self.assertGreater(outline["paragraph_count"], 0)
        self.assertIn("terms", terms)

    def test_outline_ignores_headings_inside_code_fences(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "outline.md"
            path.write_text(
                "# Real heading\n\n説明です。\n\n"
                "```bash\n# コマンド内のコメント\n```\n",
                encoding="utf-8",
            )
            outline = extract_outline(path)
        self.assertEqual(outline["heading_count"], 1)
        self.assertEqual(outline["headings"][0]["text"], "Real heading")

    def test_terms_ignore_inline_commands(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "terms.md"
            path.write_text(
                "# Test\n\n`npm run build --workspace=packages/core`を実行します。\n",
                encoding="utf-8",
            )
            terms = extract_terms(path)
        values = {item["term"] for item in terms["terms"]}
        self.assertTrue(values.isdisjoint({"npm", "run", "build", "workspace", "core"}))


class InvariantTests(unittest.TestCase):
    def test_protected_changes_cannot_be_approved_by_semantic_review(self) -> None:
        original = (
            "---\nowner: admin\n---\n# 概要\n\n"
            "REQ-001ではAcmeが3回、30秒で確認します。帯域は3MB/sです。[仕様](https://example.com/spec)\n\n"
            "`MAX_RETRY_COUNT`を使用します。\n\n"
            "| 項目 | 値 |\n| --- | --- |\n| 上限 | 3 |\n\n"
            "````text\n```python\nprint('old')\n```\n````\n"
        )
        changes = (
            ("3回、30秒", "30回、3秒", "numbers_in_order"),
            ("30秒", "30分", "quantities_in_order"),
            ("3MB/s", "3MB/min", "quantities_in_order"),
            ("REQ-001", "REQ-002", "identifiers_in_order"),
            ("https://example.com/spec", "https://example.com/new", "link_destinations"),
            ("MAX_RETRY_COUNT", "RETRY_COUNT", "inline_code"),
            ("| 上限 | 3 |", "| 上限 | 4 |", "protected_blocks"),
            ("owner: admin", "owner: user", "frontmatter"),
            ("# 概要", "## 概要", "heading_levels"),
            ("Acme", "Other", "protected_terms"),
            ("print('old')", "print('new')", "protected_blocks"),
        )
        with tempfile.TemporaryDirectory() as directory:
            before, after, review = (Path(directory) / name for name in ("before.md", "after.md", "review.json"))
            before.write_text(original, encoding="utf-8")
            for old, new, category in changes:
                with self.subTest(category=category):
                    after.write_text(original.replace(old, new), encoding="utf-8")
                    self.write_review(before, after, review)
                    result = check_invariants(before, after, ["Acme"], review)
                    self.assertEqual(result["status"], "blocked")
                    self.assertIn(category, {
                        item["category"] for item in result["mechanical_violations"]
                    })

    def write_review(self, before: Path, after: Path, review: Path) -> None:
        review.write_text(json.dumps({
            "before_sha256": hashlib.sha256(before.read_bytes()).hexdigest(),
            "after_sha256": hashlib.sha256(after.read_bytes()).hexdigest(),
            "reviewer": "test-reviewer",
            "checks": {name: True for name in SEMANTIC_CHECKS},
        }), encoding="utf-8")

    def test_review_must_cover_exact_edits_and_all_semantic_checks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            before, after, review = (Path(directory) / name for name in ("before.md", "after.md", "review.json"))
            before.write_text("管理者だけが設定を確認します。", encoding="utf-8")
            after.write_text("設定を確認できるのは管理者だけです。", encoding="utf-8")
            self.assertEqual(check_invariants(before, before)["status"], "passed")
            self.assertEqual(check_invariants(before, after)["status"], "review_required")
            self.write_review(before, after, review)
            self.assertEqual(check_invariants(before, after, review_path=review)["status"], "passed")
            after.write_text("誰でも設定を確認できます。", encoding="utf-8")
            self.assertEqual(check_invariants(before, after, review_path=review)["status"], "review_required")
            self.write_review(before, after, review)
            value = json.loads(review.read_text(encoding="utf-8"))
            value["checks"]["scope"] = False
            review.write_text(json.dumps(value), encoding="utf-8")
            self.assertEqual(check_invariants(before, after, review_path=review)["status"], "review_required")

    def test_invariant_cli_exit_codes_and_input_errors(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            before, after = (Path(directory) / name for name in ("before.md", "after.md"))
            before.write_text("上限は3回です。", encoding="utf-8")
            for text, code in (
                ("上限は3回です。", 0),
                ("上限は30回です。", 2),
                ("3回を上限とします。", 3),
            ):
                with self.subTest(code=code):
                    after.write_text(text, encoding="utf-8")
                    process = subprocess.run(
                        [sys.executable, str(SCRIPT_DIR / "invariants.py"), str(before), str(after), "--json"],
                        capture_output=True, text=True,
                    )
                    self.assertEqual(process.returncode, code, process.stderr)
                    self.assertIn("status", json.loads(process.stdout))
            process = subprocess.run(
                [sys.executable, str(SCRIPT_DIR / "invariants.py"), str(before), str(Path(directory) / "missing.md")],
                capture_output=True, text=True,
            )
            self.assertEqual(process.returncode, 1)
            self.assertIn("error:", process.stderr)

    def test_units_across_line_breaks_and_boolean_review_types(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            before, after, review = (Path(directory) / name for name in ("before.md", "after.md", "review.json"))
            before.write_text("上限は30\n秒です。", encoding="utf-8")
            after.write_text("上限は30\n分です。", encoding="utf-8")
            self.assertEqual(check_invariants(before, after)["status"], "blocked")
            before.write_text("設定をを保存します。", encoding="utf-8")
            after.write_text("設定を保存します。", encoding="utf-8")
            self.write_review(before, after, review)
            value = json.loads(review.read_text(encoding="utf-8"))
            value["checks"]["negation"] = "true"
            review.write_text(json.dumps(value), encoding="utf-8")
            self.assertEqual(check_invariants(before, after, review_path=review)["status"], "review_required")


if __name__ == "__main__":
    unittest.main()
