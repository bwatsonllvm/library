#!/usr/bin/env python3
"""Audit paper abstract/topic quality without mutating bundle data."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from paper_keywords import PaperKeywordExtractor
from tag_vocabulary import load_canonical_tags


PLACEHOLDER_TITLE_PATTERNS = [
    re.compile(r"^\s*(?:404|403|500|502|503)\b", re.IGNORECASE),
    re.compile(r"bad gateway", re.IGNORECASE),
    re.compile(r"access denied", re.IGNORECASE),
    re.compile(r"just a moment", re.IGNORECASE),
    re.compile(r"attention required", re.IGNORECASE),
]

STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "based",
    "by",
    "for",
    "from",
    "in",
    "into",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "their",
    "these",
    "this",
    "to",
    "through",
    "using",
    "via",
    "with",
}

TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9+#-]*")
YEAR_RE = re.compile(r"^(?:19|20)\d{2}$")
WS_RE = re.compile(r"\s+")


def collapse_ws(value: Any) -> str:
    return WS_RE.sub(" ", str(value or "")).strip()


def normalize_title_key(value: str) -> str:
    text = unicodedata.normalize("NFKD", collapse_ws(value))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return collapse_ws(text)


def tokenize_title_words(value: str) -> list[str]:
    tokens = []
    for token in TOKEN_RE.findall(value.lower()):
        if len(token) <= 2 or token in STOPWORDS or YEAR_RE.fullmatch(token):
            continue
        tokens.append(token)
    return tokens


def title_abstract_overlap(title: str, abstract: str) -> float:
    title_tokens = set(tokenize_title_words(title))
    if len(title_tokens) < 2:
        return 1.0
    abstract_tokens = set(tokenize_title_words(abstract))
    return len(title_tokens & abstract_tokens) / max(1, len(title_tokens))


def short_preview(value: str, limit: int = 180) -> str:
    text = collapse_ws(value)
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def build_issue(issue_type: str, record: dict[str, Any], **extra: Any) -> dict[str, Any]:
    payload = {
        "type": issue_type,
        "id": collapse_ws(record.get("id", "")),
        "title": collapse_ws(record.get("title", "")),
        "source": collapse_ws(record.get("source", "")),
        "paperType": collapse_ws(record.get("type", "")),
        "year": collapse_ws(record.get("year", "")),
    }
    payload.update(extra)
    return payload


def audit_bundle(bundle_path: Path, app_js_path: Path) -> dict[str, Any]:
    payload = json.loads(bundle_path.read_text(encoding="utf-8"))
    papers = [item for item in payload.get("papers", []) if isinstance(item, dict)]

    canonical_tags = load_canonical_tags(app_js_path)
    canonical_tag_set = set(canonical_tags)
    extractor = PaperKeywordExtractor(canonical_tags)

    duplicate_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    issues: dict[str, list[dict[str, Any]]] = {
        "placeholderTitle": [],
        "lowTitleAbstractOverlap": [],
        "duplicateAbstract": [],
        "nonCanonicalTags": [],
        "tagDrift": [],
    }

    for paper in papers:
        title = collapse_ws(paper.get("title", ""))
        abstract = collapse_ws(paper.get("abstract", ""))
        publication = collapse_ws(paper.get("publication", ""))
        venue = collapse_ws(paper.get("venue", ""))
        stored_tags = [collapse_ws(tag) for tag in (paper.get("tags") or []) if collapse_ws(tag)]

        for pattern in PLACEHOLDER_TITLE_PATTERNS:
            if pattern.search(title):
                issues["placeholderTitle"].append(
                    build_issue("placeholderTitle", paper, abstractPreview=short_preview(abstract))
                )
                break

        if len(abstract) >= 120:
            overlap = title_abstract_overlap(title, abstract)
            if overlap < 0.15:
                issues["lowTitleAbstractOverlap"].append(
                    build_issue(
                        "lowTitleAbstractOverlap",
                        paper,
                        overlap=round(overlap, 3),
                        abstractPreview=short_preview(abstract),
                    )
                )
            duplicate_groups[hashlib.sha1(abstract.encode("utf-8")).hexdigest()].append(paper)

        non_canonical = [tag for tag in stored_tags if tag not in canonical_tag_set]
        if non_canonical:
            issues["nonCanonicalTags"].append(
                build_issue("nonCanonicalTags", paper, tags=stored_tags, nonCanonicalTags=non_canonical)
            )

        extracted_tags = extractor.extract(title=title, abstract=abstract, publication=publication, venue=venue)["tags"]
        missing_tags = [tag for tag in extracted_tags if tag not in stored_tags]
        extra_tags = [tag for tag in stored_tags if tag not in extracted_tags]
        if missing_tags or extra_tags:
            issues["tagDrift"].append(
                build_issue(
                    "tagDrift",
                    paper,
                    storedTags=stored_tags,
                    extractedTags=extracted_tags,
                    missingTags=missing_tags,
                    extraTags=extra_tags,
                    driftScore=len(missing_tags) + len(extra_tags),
                )
            )

    for group in duplicate_groups.values():
        if len(group) < 2:
            continue
        title_keys = {normalize_title_key(collapse_ws(item.get("title", ""))) for item in group}
        if len(title_keys) < 2:
            continue
        preview = short_preview(collapse_ws(group[0].get("abstract", "")))
        for paper in group:
            issues["duplicateAbstract"].append(
                build_issue(
                    "duplicateAbstract",
                    paper,
                    groupSize=len(group),
                    abstractPreview=preview,
                    groupTitles=[collapse_ws(item.get("title", "")) for item in group[:8]],
                )
            )

    summary = {
        "totalRecords": len(papers),
        "byPaperType": Counter(collapse_ws(item.get("type", "")) for item in papers),
        "bySource": Counter(collapse_ws(item.get("source", "")) for item in papers),
        "issueCounts": {name: len(values) for name, values in issues.items()},
    }

    summary["duplicateAbstractGroupCount"] = len(
        {
            (
                issue["abstractPreview"],
                tuple(issue["groupTitles"]),
            )
            for issue in issues["duplicateAbstract"]
        }
    )

    top_examples = {
        "placeholderTitle": issues["placeholderTitle"][:25],
        "lowTitleAbstractOverlap": sorted(issues["lowTitleAbstractOverlap"], key=lambda item: item["overlap"])[:50],
        "duplicateAbstract": sorted(
            issues["duplicateAbstract"],
            key=lambda item: (-int(item.get("groupSize", 0)), item["title"]),
        )[:50],
        "nonCanonicalTags": issues["nonCanonicalTags"][:50],
        "tagDrift": sorted(
            issues["tagDrift"],
            key=lambda item: (-int(item.get("driftScore", 0)), item["title"]),
        )[:50],
    }

    return {
        "bundle": str(bundle_path),
        "summary": {
            **summary,
            "byPaperType": dict(summary["byPaperType"]),
            "bySource": dict(summary["bySource"]),
        },
        "topExamples": top_examples,
    }


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]

    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", default=str(repo_root / "papers" / "combined-all-papers-deduped.json"))
    parser.add_argument("--app-js", default=str(repo_root / "js" / "app.js"))
    parser.add_argument("--json-out", default="")
    args = parser.parse_args()

    bundle_path = Path(args.bundle).resolve()
    app_js_path = Path(args.app_js).resolve()

    report = audit_bundle(bundle_path, app_js_path)

    if args.json_out:
        out_path = Path(args.json_out).resolve()
        out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    json.dump(report, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
