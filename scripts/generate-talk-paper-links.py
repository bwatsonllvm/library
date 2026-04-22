#!/usr/bin/env python3
"""Generate slide-reference paper and repository/discussion links for talk detail pages.

Only explicit slide-deck references should be emitted. Title-only mentions are
filtered unless nearby slide text also looks like a citation.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path
from typing import Iterable


ARTIFACT_VERSION = 6
BLOG_SOURCE_SLUGS = {"llvm-blog-www", "llvm-www-blog"}
USER_AGENT = "llvm-library-talk-paper-links/1.0"
MATCH_STOPWORDS = {
    "about", "after", "against", "algorithm", "algorithms", "among", "analysis", "approach",
    "approaches", "around", "based", "being", "between", "beyond", "compiler", "compilers",
    "design", "details", "during", "each", "from", "have", "into", "llvm", "more", "most",
    "other", "over", "part", "parts", "paper", "papers", "program", "programs", "research",
    "results", "same", "show", "shows", "some", "study", "system", "systems", "talk", "their",
    "these", "this", "through", "using", "with", "within", "work",
}
GENERIC_TITLE_VARIANT_BLOCKLIST = {
    "conclusions and future work",
    "future work",
    "conclusion",
    "conclusions",
    "summary",
    "acknowledgements",
    "references",
    "related work",
    "background",
    "introduction",
}
WHITESPACE_BYTES = b" \t\n\r\f\x00"
CITATION_CONTEXT_PHRASES = (
    "et al",
    "doi",
    "arxiv",
    "preprint",
    "research paper",
    "references",
    "bibliography",
    "citation",
    "citations",
    "journal",
    "conference",
    "symposium",
    "workshop",
    "proceedings",
    "for more information",
)
TALK_CONTEXT_PHRASES = (
    "tutorial",
    "tutorials",
    "presentation",
    "presentations",
    "recording",
    "recordings",
    "video",
    "videos",
    "speaker",
    "speakers",
    "watch",
    "youtube",
    "conference",
    "workshop",
    "open design meeting",
)
AUTHOR_SUFFIX_TOKENS = {"jr", "sr", "ii", "iii", "iv", "v"}
GITHUB_RESERVED_OWNERS = {
    "about", "account", "apps", "collections", "contact", "customer-stories", "enterprise",
    "events", "explore", "features", "gist", "github", "issues", "login", "marketplace",
    "new", "notifications", "orgs", "organizations", "pricing", "pulls", "search",
    "security", "settings", "site", "sponsors", "team", "teams", "topics", "trending",
    "users",
}
GITHUB_RESOURCE_SEGMENTS = {
    "actions", "blob", "commit", "commits", "compare", "discussions", "issues", "milestone",
    "milestones", "packages", "projects", "pull", "pulls", "pulse", "raw", "releases",
    "security", "tree", "wiki",
}
GITHUB_URL_RE = re.compile(
    r"(?:(?:https?://)?(?:www\.)?github\.com/[^\s<>()\[\]{}\"'`]+)",
    flags=re.IGNORECASE,
)
REFERENCE_URL_RE = re.compile(
    r"(?:(?:https?://)?(?:www\.)?(?:github\.com|discourse\.llvm\.org|reviews\.llvm\.org)/[^\s<>()\[\]{}\"'`]+)",
    flags=re.IGNORECASE,
)
GITHUB_PATH_SEGMENT_RE = re.compile(r"[A-Za-z0-9_.-]+")
GENERIC_REFERENCE_CONTEXT_RE = re.compile(
    r"^(?:github|repo|repository|source|link|links|code|upstreaming|upstream|implementation|"
    r"discussion|discussions|thread|threads|discourse|review|reviews)$",
    flags=re.IGNORECASE,
)
REFERENCE_SPLIT_MARKER_RE = re.compile(
    r"(?=(?:https?://|https?:/|github\.com/|discourse\.llvm\.org/|reviews\.llvm\.org/))",
    flags=re.IGNORECASE,
)


def collapse_ws(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def strip_diacritics(value: str) -> str:
    text = str(value or "")
    return "".join(ch for ch in unicodedata.normalize("NFKD", text) if not ("\u0300" <= ch <= "\u036f"))


def normalize_match_text(value: str) -> str:
    text = strip_diacritics(str(value or "").lower())
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return collapse_ws(text)


def tokenize_important_words(value: str) -> list[str]:
    return [
        token
        for token in normalize_match_text(value).split(" ")
        if len(token) >= 4 and token not in MATCH_STOPWORDS
    ]


def extract_doi(value: str) -> str:
    match = re.search(r"10\.\d{4,9}/[\w.()\-;/:%+]+", str(value or ""), flags=re.IGNORECASE)
    return match.group(0).strip().lower() if match else ""


def dedupe_urls(values: Iterable[str]) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = collapse_ws(str(value or ""))
        if not text or text in seen:
            continue
        seen.add(text)
        urls.append(text)
    return urls


def trim_wrapping_url_punctuation(value: str) -> str:
    text = collapse_ws(value)
    if not text:
        return ""

    while text and text[0] in "([{\"'":
        text = text[1:].strip()
    while text and text[-1] in ".,;:!?)]}\"'":
        text = text[:-1].rstrip()
    return text


def normalize_scheme_slashes(value: str) -> str:
    text = collapse_ws(value)
    if not text:
        return ""
    return re.sub(r"^(https?):/(?!/)", r"\1://", text, flags=re.IGNORECASE)


def looks_like_truncated_reference_segment(value: str) -> bool:
    text = collapse_ws(value)
    if not text:
        return True
    return text[-1] in {"-", "_", "."}


def split_reference_candidate(value: str) -> list[str]:
    text = collapse_ws(value)
    if not text:
        return []

    starts = sorted({
        match.start()
        for match in REFERENCE_SPLIT_MARKER_RE.finditer(text)
        if match.start() >= 0
    })
    if not starts:
        return [text]
    if starts[0] != 0:
        starts.insert(0, 0)

    parts: list[str] = []
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else len(text)
        candidate = collapse_ws(text[start:end])
        if candidate:
            parts.append(candidate)
    return parts or [text]


def normalize_github_url(value: str) -> str:
    raw = normalize_scheme_slashes(str(value or ""))
    if not raw:
        return ""
    raw = trim_wrapping_url_punctuation(raw)
    if not raw:
        return ""
    if raw.lower().startswith("github.com/"):
        raw = f"https://{raw}"

    try:
        parsed = urllib.parse.urlparse(raw)
    except ValueError:
        return ""

    host = collapse_ws(parsed.netloc).lower().replace("www.", "")
    if host != "github.com":
        return ""

    parts = [
        collapse_ws(urllib.parse.unquote(part))
        for part in parsed.path.split("/")
        if collapse_ws(part)
    ]
    if len(parts) < 2:
        return ""

    owner_match = GITHUB_PATH_SEGMENT_RE.match(unicodedata.normalize("NFKC", parts[0]))
    repo_match = GITHUB_PATH_SEGMENT_RE.match(unicodedata.normalize("NFKC", parts[1]))
    owner = owner_match.group(0).strip() if owner_match else ""
    repo = repo_match.group(0).strip() if repo_match else ""
    repo = re.sub(r"\.git$", "", repo, flags=re.IGNORECASE)
    if not owner or not repo:
        return ""
    if looks_like_truncated_reference_segment(owner) or looks_like_truncated_reference_segment(repo):
        return ""
    if owner.lower() in GITHUB_RESERVED_OWNERS:
        return ""
    normalized_parts = [owner, repo]

    if len(parts) > 2:
        resource = collapse_ws(parts[2]).lower()
        if resource not in GITHUB_RESOURCE_SEGMENTS:
            return ""

        if resource in {"blob", "raw"}:
            if len(parts) < 5:
                return ""
            normalized_parts.extend([resource, parts[3], *parts[4:]])
        elif resource == "tree":
            if len(parts) < 4:
                return ""
            normalized_parts.extend([resource, parts[3], *parts[4:]])
        else:
            if len(parts) < 4:
                return ""
            normalized_parts.extend([resource, *parts[3:]])

    if looks_like_truncated_reference_segment(normalized_parts[-1]):
        return ""

    path = "/" + "/".join(urllib.parse.quote(part, safe=":@!$&'()*+,;=-._~") for part in normalized_parts)
    return urllib.parse.urlunparse(("https", "github.com", path, "", "", ""))


def extract_github_urls_from_text(value: str) -> list[str]:
    text = str(value or "")
    if not text:
        return []
    return dedupe_urls(
        normalize_github_url(match.group(0))
        for match in GITHUB_URL_RE.finditer(text)
    )


def normalize_discourse_url(value: str) -> str:
    raw = normalize_scheme_slashes(str(value or ""))
    if not raw:
        return ""
    raw = trim_wrapping_url_punctuation(raw)
    if not raw:
        return ""
    if raw.lower().startswith("discourse.llvm.org/"):
        raw = f"https://{raw}"

    try:
        parsed = urllib.parse.urlparse(raw)
    except ValueError:
        return ""

    host = collapse_ws(parsed.netloc).lower().replace("www.", "")
    if host != "discourse.llvm.org":
        return ""

    parts = [
        collapse_ws(urllib.parse.unquote(part))
        for part in parsed.path.split("/")
        if collapse_ws(part)
    ]
    if not parts:
        return ""

    path = "/" + "/".join(urllib.parse.quote(part, safe=":@!$&'()*+,;=-._~") for part in parts)
    return urllib.parse.urlunparse(("https", "discourse.llvm.org", path, "", "", ""))


def normalize_llvm_review_url(value: str) -> str:
    raw = normalize_scheme_slashes(str(value or ""))
    if not raw:
        return ""
    raw = trim_wrapping_url_punctuation(raw)
    if not raw:
        return ""
    if raw.lower().startswith("reviews.llvm.org/"):
        raw = f"https://{raw}"

    try:
        parsed = urllib.parse.urlparse(raw)
    except ValueError:
        return ""

    host = collapse_ws(parsed.netloc).lower().replace("www.", "")
    if host != "reviews.llvm.org":
        return ""

    parts = [
        collapse_ws(urllib.parse.unquote(part))
        for part in parsed.path.split("/")
        if collapse_ws(part)
    ]
    if not parts:
        return ""

    path = "/" + "/".join(urllib.parse.quote(part, safe=":@!$&'()*+,;=-._~") for part in parts)
    return urllib.parse.urlunparse(("https", "reviews.llvm.org", path, "", "", ""))


def normalize_reference_url(value: str) -> str:
    return (
        normalize_github_url(value)
        or normalize_discourse_url(value)
        or normalize_llvm_review_url(value)
    )


def clean_reference_context(value: str) -> str:
    text = re.sub(r"https?://[^\s<>()\[\]{}\"'`]+", " ", str(value or ""), flags=re.IGNORECASE)
    text = collapse_ws(text)
    if not text:
        return ""
    text = re.sub(r"^(?:\d{4}\s+)+", "", text)
    text = re.sub(r"\b(?:department or event name|confidential)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(?:blob|tree)/main\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(?:[A-Za-z0-9_.-]+/){2,}[A-Za-z0-9_.-]+\b", " ", text)
    text = collapse_ws(text).strip(" -–—:;,.|/•")
    return collapse_ws(text)


def trim_reference_label(value: str, max_words: int = 14) -> str:
    text = clean_reference_context(value)
    if not text:
        return ""
    tokens = text.split()
    if len(tokens) > max_words:
        text = " ".join(tokens[-max_words:])
    return collapse_ws(text)


def looks_like_bad_reference_label(value: str) -> bool:
    text = collapse_ws(value)
    if not text:
        return True
    if GENERIC_REFERENCE_CONTEXT_RE.fullmatch(text):
        return True
    if re.search(r"\[\d+\]", text):
        return True
    lowered = text.lower()
    if any(token in lowered for token in ("github", "discourse", "review", "http")) or "/" in text:
        return True
    return False


def extract_context_label(text: str, start: int, end: int) -> str:
    raw = str(text or "")
    if not raw:
        return ""

    window_start = max(0, start - 220)
    prefix = raw[window_start:start]
    suffix = raw[end : min(len(raw), end + 140)]

    candidate = ""
    bullet_index = prefix.rfind("•")
    if bullet_index != -1:
        candidate = prefix[bullet_index + 1 :]
    elif "|" in prefix:
        candidate = prefix.split("|")[-1]
    else:
        candidate = prefix

    label = trim_reference_label(candidate)
    if looks_like_bad_reference_label(label):
        label = trim_reference_label(suffix, max_words=10)
    if looks_like_bad_reference_label(label):
        return ""

    return label


def parse_github_reference(value: str) -> dict[str, str] | None:
    url = normalize_github_url(value)
    if not url:
        return None

    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return None

    parts = [
        collapse_ws(urllib.parse.unquote(part))
        for part in parsed.path.split("/")
        if collapse_ws(part)
    ]
    if len(parts) < 2:
        return None

    owner = parts[0]
    repo = re.sub(r"\.git$", "", parts[1], flags=re.IGNORECASE)
    if not owner or not repo:
        return None

    resource = collapse_ws(parts[2]).lower() if len(parts) > 2 else ""
    kind = "github-repo"
    file_name = ""
    file_path = ""
    reference_path = ""

    if resource in {"blob", "raw"} and len(parts) >= 5:
        kind = "github-file"
        file_path = "/".join(parts[4:])
        file_name = parts[-1]
        reference_path = file_path
    elif resource == "tree" and len(parts) >= 4:
        kind = "github-tree"
        file_path = "/".join(parts[4:])
        file_name = parts[-1] if file_path else ""
        reference_path = file_path or parts[3]
    elif len(parts) > 2:
        kind = {
            "issues": "github-issue",
            "pull": "github-pull",
            "pulls": "github-pull",
            "discussions": "github-discussion",
            "commit": "github-commit",
            "commits": "github-commit",
            "compare": "github-compare",
            "releases": "github-release",
            "wiki": "github-wiki",
        }.get(resource, "github-resource")
        reference_path = "/".join(parts[2:])

    if kind in {"github-issue", "github-pull", "github-discussion"}:
        if len(parts) < 4 or not re.fullmatch(r"\d+", parts[3]):
            return None
    elif kind == "github-commit":
        if len(parts) < 4 or not re.fullmatch(r"[0-9a-f]{7,40}", parts[3], flags=re.IGNORECASE):
            return None
    elif looks_like_truncated_reference_segment(parts[-1]):
        return None

    return {
        "url": url,
        "host": "github.com",
        "kind": kind,
        "library": repo,
        "repository": f"{owner}/{repo}",
        "fileName": file_name,
        "filePath": file_path,
        "referencePath": reference_path,
    }


def github_reference_score(item: dict[str, str]) -> tuple[int, int, int]:
    label = collapse_ws(item.get("label", ""))
    source = collapse_ws(item.get("source", "")).lower()
    label_quality = 0
    if label:
        label_quality = 2 if 4 <= len(label) <= 80 else 1
    return (
        1 if source == "slides" else 0,
        label_quality,
        max(0, 120 - min(len(label), 120)),
    )


def merge_github_reference_items(*groups: Iterable[dict[str, str]]) -> list[dict[str, str]]:
    merged: dict[str, dict[str, str]] = {}

    for group in groups:
        for raw_item in group or []:
            if not isinstance(raw_item, dict):
                continue
            url = normalize_github_url(raw_item.get("url", ""))
            if not url:
                continue
            item = {
                "url": url,
                "source": collapse_ws(raw_item.get("source", "")),
                "label": collapse_ws(raw_item.get("label", "")),
                "context": collapse_ws(raw_item.get("context", "")),
                "library": collapse_ws(raw_item.get("library", "")),
                "repository": collapse_ws(raw_item.get("repository", "")),
                "fileName": collapse_ws(raw_item.get("fileName", "")),
                "filePath": collapse_ws(raw_item.get("filePath", "")),
                "referencePath": collapse_ws(raw_item.get("referencePath", "")),
            }
            existing = merged.get(url)
            if existing is None or github_reference_score(item) > github_reference_score(existing):
                if existing:
                    for key, value in existing.items():
                        if key == "url" or item.get(key):
                            continue
                        item[key] = value
                merged[url] = item
            else:
                for key, value in item.items():
                    if key == "url" or not value or merged[url].get(key):
                        continue
                    merged[url][key] = value

    return [merged[url] for url in dedupe_urls(merged.keys())]


def extract_github_reference_items_from_text(value: str, *, source: str) -> list[dict[str, str]]:
    text = str(value or "")
    if not text:
        return []
    items: list[dict[str, str]] = []
    for match in GITHUB_URL_RE.finditer(text):
        ref = parse_github_reference(match.group(0))
        if not ref:
            continue
        context_label = extract_context_label(text, match.start(), match.end())
        ref.update(
            {
                "source": source,
                "label": context_label,
                "context": context_label,
            }
        )
        items.append(ref)
    return merge_github_reference_items(items)


def extract_github_reference_items_from_pages(pages: list[str]) -> list[dict[str, str]]:
    page_items: list[dict[str, str]] = []
    for page in pages or []:
        page_items.extend(extract_github_reference_items_from_text(page, source="slides"))
    return merge_github_reference_items(page_items)


def parse_discourse_reference(value: str) -> dict[str, str] | None:
    url = normalize_discourse_url(value)
    if not url:
        return None

    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return None

    parts = [
        collapse_ws(urllib.parse.unquote(part))
        for part in parsed.path.split("/")
        if collapse_ws(part)
    ]
    if not parts:
        return None

    head = parts[0].lower()
    if head == "t":
        if len(parts) >= 2 and re.fullmatch(r"\d+", parts[1]):
            pass
        elif len(parts) >= 3 and re.fullmatch(r"\d+", parts[2]):
            pass
        else:
            return None
        if len(parts) >= 2 and not re.fullmatch(r"\d+", parts[1]) and looks_like_truncated_reference_segment(parts[1]):
            return None
        kind = "discourse-topic"
    elif head == "c":
        if len(parts) < 2:
            return None
        if any(looks_like_truncated_reference_segment(part) for part in parts[1:]):
            return None
        kind = "discourse-category"
    else:
        return None

    return {
        "url": url,
        "host": "discourse.llvm.org",
        "kind": kind,
        "referencePath": "/".join(parts),
    }


def parse_llvm_review_reference(value: str) -> dict[str, str] | None:
    url = normalize_llvm_review_url(value)
    if not url:
        return None

    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return None

    parts = [
        collapse_ws(urllib.parse.unquote(part))
        for part in parsed.path.split("/")
        if collapse_ws(part)
    ]
    if not parts:
        return None

    return {
        "url": url,
        "host": "reviews.llvm.org",
        "kind": "llvm-review",
        "referencePath": "/".join(parts),
    }


def parse_reference_item(value: str) -> dict[str, str] | None:
    return (
        parse_github_reference(value)
        or parse_discourse_reference(value)
        or parse_llvm_review_reference(value)
    )


def reference_item_score(item: dict[str, str]) -> tuple[int, int, int]:
    label = collapse_ws(item.get("label", ""))
    source = collapse_ws(item.get("source", "")).lower()
    label_quality = 0
    if label:
        label_quality = 2 if 4 <= len(label) <= 80 else 1
    return (
        1 if source == "slides" else 0,
        label_quality,
        max(0, 120 - min(len(label), 120)),
    )


def merge_reference_items(*groups: Iterable[dict[str, str]]) -> list[dict[str, str]]:
    merged: dict[str, dict[str, str]] = {}

    for group in groups:
        for raw_item in group or []:
            if not isinstance(raw_item, dict):
                continue
            parsed = parse_reference_item(raw_item.get("url", ""))
            if not parsed:
                continue
            item = {
                **parsed,
                "source": collapse_ws(raw_item.get("source", "")),
                "label": collapse_ws(raw_item.get("label", "")),
                "context": collapse_ws(raw_item.get("context", "")),
                "library": collapse_ws(raw_item.get("library", "")) or parsed.get("library", ""),
                "repository": collapse_ws(raw_item.get("repository", "")) or parsed.get("repository", ""),
                "fileName": collapse_ws(raw_item.get("fileName", "")) or parsed.get("fileName", ""),
                "filePath": collapse_ws(raw_item.get("filePath", "")) or parsed.get("filePath", ""),
                "referencePath": collapse_ws(raw_item.get("referencePath", "")) or parsed.get("referencePath", ""),
            }
            existing = merged.get(parsed["url"])
            if existing is None or reference_item_score(item) > reference_item_score(existing):
                if existing:
                    for key, value in existing.items():
                        if key == "url" or item.get(key):
                            continue
                        item[key] = value
                merged[parsed["url"]] = item
            else:
                for key, value in item.items():
                    if key == "url" or not value or merged[parsed["url"]].get(key):
                        continue
                    merged[parsed["url"]][key] = value

    return [merged[url] for url in dedupe_urls(merged.keys())]


def extract_reference_items_from_text(value: str, *, source: str) -> list[dict[str, str]]:
    text = str(value or "")
    if not text:
        return []

    items: list[dict[str, str]] = []
    for match in REFERENCE_URL_RE.finditer(text):
        for candidate in split_reference_candidate(match.group(0)):
            ref = parse_reference_item(candidate)
            if not ref:
                continue
            context_label = extract_context_label(text, match.start(), match.end())
            ref.update(
                {
                    "source": source,
                    "label": context_label,
                    "context": context_label,
                }
            )
            items.append(ref)
    return merge_reference_items(items)


def extract_reference_items_from_pages(pages: list[str]) -> list[dict[str, str]]:
    page_items: list[dict[str, str]] = []
    for page in pages or []:
        page_items.extend(extract_reference_items_from_text(page, source="slides"))
    return merge_reference_items(page_items)


def filter_github_reference_items(items: Iterable[dict[str, str]]) -> list[dict[str, str]]:
    return merge_reference_items(
        item for item in (items or [])
        if isinstance(item, dict) and collapse_ws(item.get("host", "")).lower() == "github.com"
    )


def reference_urls_from_items(items: Iterable[dict[str, str]]) -> list[str]:
    return dedupe_urls(
        collapse_ws((item or {}).get("url", ""))
        for item in (items or [])
        if isinstance(item, dict)
    )


def build_title_variants(title: str) -> list[str]:
    variants: list[str] = []

    def add(value: str) -> None:
        normalized = normalize_match_text(value)
        if not normalized:
            return
        if normalized in GENERIC_TITLE_VARIANT_BLOCKLIST:
            return
        if len(normalized) < 16 or len(normalized.split()) < 3:
            return
        if normalized not in variants:
            variants.append(normalized)

    raw_title = collapse_ws(title)
    if not raw_title:
        return variants

    add(raw_title)
    add(raw_title.replace('"', "").replace("'", "").replace("“", "").replace("”", ""))
    add(re.sub(r"^(?:a|an|the)\s+", "", raw_title, flags=re.IGNORECASE))

    parts = [collapse_ws(part) for part in re.split(r"\s*(?:[:\-–—])\s*", raw_title) if collapse_ws(part)]
    if len(parts) > 1:
        add(parts[0])

    return variants


def build_talk_title_variants(title: str) -> list[str]:
    return build_title_variants(title)


def extract_author_surnames(authors: Iterable[dict]) -> list[str]:
    surnames: list[str] = []
    for author in authors or []:
        if not isinstance(author, dict):
            continue
        name = normalize_match_text(str(author.get("name", "")))
        tokens = [token for token in name.split(" ") if token]
        while tokens and tokens[-1] in AUTHOR_SUFFIX_TOKENS:
            tokens.pop()
        if not tokens:
            continue
        surname = tokens[-1]
        if len(surname) < 4 or surname in surnames:
            continue
        surnames.append(surname)
    return surnames


def parse_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_event_bundles(repo_root: Path) -> list[dict]:
    manifest = parse_json(repo_root / "devmtg" / "events" / "index.json")
    talks: list[dict] = []
    for rel in manifest.get("eventFiles", []):
        bundle = parse_json(repo_root / "devmtg" / "events" / rel)
        for talk in bundle.get("talks", []):
            if isinstance(talk, dict):
                talks.append(talk)
    return talks


def load_mlir_talks(repo_root: Path) -> list[dict]:
    payload = parse_json(repo_root / "sub-projects" / "mlir" / "data" / "talks.json")
    talks: list[dict] = []

    for section in payload.get("sections", []):
        if not isinstance(section, dict):
            continue
        for group in section.get("groups", []):
            if not isinstance(group, dict):
                continue
            for entry in group.get("entries", []):
                if not isinstance(entry, dict):
                    continue
                talk_id = collapse_ws(str(entry.get("id", "")))
                if not talk_id:
                    continue
                slides_url = ""
                for action in entry.get("actions", []):
                    if not isinstance(action, dict):
                        continue
                    if collapse_ws(str(action.get("kind", ""))).lower() != "slides":
                        continue
                    slides_url = collapse_ws(str(action.get("url", "")))
                    if slides_url:
                        break
                talks.append({
                    "id": talk_id,
                    "slidesUrl": slides_url,
                    "abstract": collapse_ws(str(entry.get("abstract", ""))),
                })

    return talks


def load_papers(repo_root: Path) -> list[dict]:
    manifest = parse_json(repo_root / "papers" / "index.json")
    papers: list[dict] = []
    for rel in manifest.get("paperFiles", []):
        bundle = parse_json(repo_root / "papers" / rel)
        for paper in bundle.get("papers", []):
            if not isinstance(paper, dict):
                continue
            source = collapse_ws(str(paper.get("source", ""))).lower()
            paper_type = collapse_ws(str(paper.get("type", ""))).lower()
            if source in BLOG_SOURCE_SLUGS or paper_type in {"blog", "blog-post"}:
                continue
            paper_id = collapse_ws(str(paper.get("id", "")))
            title = collapse_ws(str(paper.get("title", "")))
            if not paper_id or not title:
                continue
            papers.append(
                {
                    "id": paper_id,
                    "title": title,
                    "titleVariants": build_title_variants(title),
                    "year": collapse_ws(str(paper.get("year", ""))),
                    "authorSurnames": extract_author_surnames(paper.get("authors", [])),
                    "doi": (
                        extract_doi(str(paper.get("doi", "")))
                        or extract_doi(str(paper.get("paperUrl", "")))
                        or extract_doi(str(paper.get("sourceUrl", "")))
                    ),
                    "urlKeys": [
                        collapse_ws(str(value)).lower()
                        for value in (
                            paper.get("paperUrl", ""),
                            paper.get("sourceUrl", ""),
                            paper.get("openalexId", ""),
                        )
                        if collapse_ws(str(value))
                    ],
                }
            )
    return papers


def normalize_reference_talk(talk: dict) -> dict | None:
    talk_id = collapse_ws(str(talk.get("id", "")))
    title = collapse_ws(str(talk.get("title", "")))
    if not talk_id or not title:
        return None

    meeting_match = re.match(r"^(\d{4})-\d{2}", talk_id)
    year = meeting_match.group(1) if meeting_match else ""

    url_values = [
        collapse_ws(str(value))
        for value in (
            talk.get("slidesUrl", ""),
            talk.get("videoUrl", ""),
        )
        if value is not None and collapse_ws(str(value)).lower() not in {"", "none", "null"}
    ]

    return {
        "id": talk_id,
        "title": title,
        "titleVariants": build_talk_title_variants(title),
        "year": year,
        "speakerSurnames": extract_author_surnames(talk.get("speakers", [])),
        "urlKeys": [value.lower() for value in url_values],
    }


def load_existing_artifact(path: Path) -> dict:
    if not path.exists():
        return {
            "dataVersion": "",
            "generatedAt": "",
            "processorVersion": ARTIFACT_VERSION,
            "talks": {},
        }
    payload = parse_json(path)
    if not isinstance(payload, dict):
        return {"processorVersion": ARTIFACT_VERSION, "talks": {}}
    talks = payload.get("talks")
    if not isinstance(talks, dict):
        talks = {}
    payload["talks"] = talks
    try:
        payload["processorVersion"] = int(payload.get("processorVersion") or 0)
    except (TypeError, ValueError):
        payload["processorVersion"] = 0
    return payload


def select_target_talks(all_talks: Iterable[dict], meetings: set[str], talk_ids: set[str]) -> list[dict]:
    selected = []
    for talk in all_talks:
        talk_id = collapse_ws(str(talk.get("id", "")))
        if not talk_id:
            continue
        meeting_match = re.match(r"^(\d{4}-\d{2})-", talk_id)
        meeting = meeting_match.group(1) if meeting_match else ""
        if meetings and meeting not in meetings:
            continue
        if talk_ids and talk_id not in talk_ids:
            continue
        selected.append(talk)
    return selected


def resolve_local_slide_path(slides_url: str, local_devmtg_root: Path | None) -> Path | None:
    if local_devmtg_root is None:
        return None

    raw = collapse_ws(slides_url)
    if not raw:
        return None

    try:
        parsed = urllib.parse.urlparse(raw)
    except ValueError:
        return None

    url_path = collapse_ws(urllib.parse.unquote(parsed.path or ""))
    if not url_path:
        return None

    marker = "/devmtg/"
    if marker not in url_path:
        return None

    relative = url_path.split(marker, 1)[1].lstrip("/")
    if not relative:
        return None

    root = local_devmtg_root.resolve()
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    if not candidate.is_file():
        return None
    return candidate


def resolve_local_mlir_slide_path(slides_url: str, local_mlir_www_root: Path | None) -> Path | None:
    if local_mlir_www_root is None:
        return None

    raw = collapse_ws(slides_url)
    if not raw:
        return None

    try:
        parsed = urllib.parse.urlparse(raw)
    except ValueError:
        return None

    hostname = collapse_ws(parsed.netloc).lower()
    if hostname and hostname not in {"mlir.llvm.org", "www.mlir.llvm.org"}:
        return None

    url_path = collapse_ws(urllib.parse.unquote(parsed.path or ""))
    if not url_path or not url_path.lower().endswith(".pdf"):
        return None

    root = local_mlir_www_root.resolve()
    candidate = (root / "website" / "static" / url_path.lstrip("/")).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    if not candidate.is_file():
        return None
    return candidate


def fetch_bytes(
    url: str,
    timeout: float,
    *,
    local_devmtg_root: Path | None = None,
    local_mlir_www_root: Path | None = None,
) -> bytes:
    local_path = resolve_local_slide_path(url, local_devmtg_root)
    if local_path is None:
        local_path = resolve_local_mlir_slide_path(url, local_mlir_www_root)
    if local_path is not None:
        return local_path.read_bytes()
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def parse_pdf_objects(data: bytes) -> dict[tuple[int, int], bytes]:
    pattern = re.compile(rb"(\d+)\s+(\d+)\s+obj\b")
    matches = list(pattern.finditer(data))
    objects: dict[tuple[int, int], bytes] = {}

    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(data)
        blob = data[start:end]
        endobj = blob.find(b"endobj")
        if endobj != -1:
            blob = blob[:endobj]
        objects[(int(match.group(1)), int(match.group(2)))] = blob.strip()

    return objects


def find_balanced_dict(blob: bytes, start: int) -> tuple[bytes, int] | tuple[None, int]:
    if blob[start : start + 2] != b"<<":
        return None, start
    depth = 0
    index = start
    while index < len(blob) - 1:
        token = blob[index : index + 2]
        if token == b"<<":
            depth += 1
            index += 2
            continue
        if token == b">>":
            depth -= 1
            index += 2
            if depth == 0:
                return blob[start:index], index
            continue
        index += 1
    return None, start


def extract_inline_dict(body: bytes, key: bytes) -> bytes | None:
    marker = key + b"<<"
    start = body.find(marker)
    if start == -1:
        return None
    dict_blob, _ = find_balanced_dict(body, start + len(key))
    return dict_blob


def get_pdf_stream(body: bytes) -> bytes | None:
    stream_match = re.search(rb"stream\r?\n", body)
    if not stream_match:
        return None
    start = stream_match.end()
    end = body.find(b"endstream", start)
    if end == -1:
        return None
    stream = body[start:end]
    if stream.endswith(b"\r\n"):
        stream = stream[:-2]
    elif stream.endswith(b"\n"):
        stream = stream[:-1]

    if b"/FlateDecode" in body:
        try:
            return zlib.decompress(stream)
        except zlib.error:
            return None
    return stream


def parse_to_unicode_cmap(payload: bytes) -> dict[int, str]:
    mapping: dict[int, str] = {}
    lines = [line.strip() for line in payload.decode("latin1", errors="ignore").splitlines()]
    index = 0

    while index < len(lines):
        line = lines[index]
        bfchar_match = re.match(r"(\d+)\s+beginbfchar", line)
        if bfchar_match:
            count = int(bfchar_match.group(1))
            for offset in range(1, count + 1):
                if index + offset >= len(lines):
                    break
                entries = re.findall(r"<([^>]+)>", lines[index + offset])
                if len(entries) < 2:
                    continue
                source = bytes.fromhex(entries[0])
                target = bytes.fromhex(entries[1])
                if len(source) == 2:
                    mapping[int.from_bytes(source, "big")] = target.decode("utf-16-be", errors="ignore")
            index += count + 1
            continue

        bfrange_match = re.match(r"(\d+)\s+beginbfrange", line)
        if bfrange_match:
            count = int(bfrange_match.group(1))
            for offset in range(1, count + 1):
                if index + offset >= len(lines):
                    break
                source = lines[index + offset]
                entries = re.findall(r"<([^>]+)>", source)
                if len(entries) < 3:
                    continue
                start = int(entries[0], 16)
                end = int(entries[1], 16)
                if "[" not in source:
                    dest = int(entries[2], 16)
                    for code in range(start, end + 1):
                        value = dest + (code - start)
                        mapping[code] = bytes.fromhex(f"{value:04x}").decode("utf-16-be", errors="ignore")
                else:
                    values = entries[2:]
                    for item_index, target_hex in enumerate(values):
                        mapping[start + item_index] = bytes.fromhex(target_hex).decode("utf-16-be", errors="ignore")
            index += count + 1
            continue

        index += 1

    return mapping


def parse_pdf_literal_string(data: bytes, start: int) -> tuple[bytes, int]:
    assert data[start : start + 1] == b"("
    index = start + 1
    depth = 1
    out = bytearray()

    while index < len(data):
        byte = data[index]
        if byte == 0x5C:
            index += 1
            if index >= len(data):
                break
            esc = data[index]
            escape_map = {
                ord("n"): b"\n",
                ord("r"): b"\r",
                ord("t"): b"\t",
                ord("b"): b"\b",
                ord("f"): b"\f",
                ord("("): b"(",
                ord(")"): b")",
                ord("\\"): b"\\",
            }
            if esc in escape_map:
                out.extend(escape_map[esc])
                index += 1
                continue
            if 48 <= esc <= 55:
                octal = bytes([esc])
                index += 1
                for _ in range(2):
                    if index < len(data) and 48 <= data[index] <= 55:
                        octal += bytes([data[index]])
                        index += 1
                    else:
                        break
                out.append(int(octal, 8))
                continue
            if esc in (10, 13):
                if esc == 13 and index + 1 < len(data) and data[index + 1] == 10:
                    index += 2
                else:
                    index += 1
                continue
            out.append(esc)
            index += 1
            continue

        if byte == 0x28:
            depth += 1
            out.append(byte)
            index += 1
            continue

        if byte == 0x29:
            depth -= 1
            if depth == 0:
                return bytes(out), index + 1
            out.append(byte)
            index += 1
            continue

        out.append(byte)
        index += 1

    return bytes(out), index


def parse_pdf_hex_string(data: bytes, start: int) -> tuple[bytes, int]:
    end = data.find(b">", start + 1)
    if end == -1:
        return b"", start + 1
    raw = re.sub(rb"[^0-9A-Fa-f]", b"", data[start + 1 : end])
    if len(raw) % 2 == 1:
        raw += b"0"
    return bytes.fromhex(raw.decode()), end + 1


def decode_pdf_text(raw: bytes, cmap: dict[int, str]) -> str:
    if not raw:
        return ""

    if all(byte == 0 for byte in raw[::2]) and len(raw) % 2 == 0:
        codes = [int.from_bytes(raw[i : i + 2], "big") for i in range(0, len(raw), 2)]
    elif len(raw) % 2 == 0 and any(int.from_bytes(raw[i : i + 2], "big") in cmap for i in range(0, len(raw), 2)):
        codes = [int.from_bytes(raw[i : i + 2], "big") for i in range(0, len(raw), 2)]
    else:
        codes = list(raw)

    out: list[str] = []
    for code in codes:
        if code in cmap:
            out.append(cmap[code])
        elif 32 <= code <= 126:
            out.append(chr(code))
        else:
            out.append(" ")
    return "".join(out)


def extract_font_aliases(body: bytes) -> dict[str, tuple[int, int]]:
    aliases: dict[str, tuple[int, int]] = {}
    for match in re.finditer(rb"/([A-Za-z0-9_.-]+)\s+(\d+)\s+(\d+)\s+R", body):
        alias = match.group(1).decode("latin1")
        aliases[alias] = (int(match.group(2)), int(match.group(3)))
    return aliases


def extract_named_refs_from_dict(body: bytes) -> dict[str, tuple[int, int]]:
    refs: dict[str, tuple[int, int]] = {}
    for match in re.finditer(rb"/([A-Za-z0-9_.-]+)\s+(\d+)\s+(\d+)\s+R", body):
        refs[match.group(1).decode("latin1")] = (int(match.group(2)), int(match.group(3)))
    return refs


def extract_content_refs(body: bytes) -> list[tuple[int, int]]:
    single = re.search(rb"/Contents\s+(\d+)\s+(\d+)\s+R", body)
    if single:
        return [(int(single.group(1)), int(single.group(2)))]

    array = re.search(rb"/Contents\s*\[(.*?)\]", body, flags=re.DOTALL)
    if not array:
        return []
    return [(int(a), int(b)) for a, b in re.findall(rb"(\d+)\s+(\d+)\s+R", array.group(1))]


def resolve_resource_dict(body: bytes, objects: dict[tuple[int, int], bytes]) -> bytes | None:
    resources_match = re.search(rb"/Resources\s+(\d+)\s+(\d+)\s+R", body)
    if resources_match:
        return objects.get((int(resources_match.group(1)), int(resources_match.group(2))))
    return extract_inline_dict(body, b"/Resources")


def resolve_annotation_uris(body: bytes, objects: dict[tuple[int, int], bytes]) -> list[str]:
    uris: list[str] = []
    for annot_ref in re.findall(rb"/Annots\s*\[(.*?)\]", body, flags=re.DOTALL):
        for obj_num, gen_num in re.findall(rb"(\d+)\s+(\d+)\s+R", annot_ref):
            annot = objects.get((int(obj_num), int(gen_num)))
            if not annot:
                continue
            for match in re.finditer(rb"/URI\((.*?)\)", annot, flags=re.DOTALL):
                raw = match.group(1).replace(b"\\(", b"(").replace(b"\\)", b")")
                try:
                    uris.append(raw.decode("utf-8"))
                except UnicodeDecodeError:
                    uris.append(raw.decode("latin1", errors="ignore"))
    return uris


def extract_text_from_content_stream(
    stream: bytes,
    alias_to_cmap: dict[str, dict[int, str]],
    *,
    xobject_text: dict[str, str] | None = None,
) -> str:
    chunks: list[str] = []
    current_font = ""
    index = 0

    while index < len(stream):
        if stream[index : index + 1] == b"/":
            font_match = re.match(rb"/([A-Za-z0-9_.-]+)", stream[index:])
            if font_match:
                alias = font_match.group(1).decode("latin1")
                cursor = index + font_match.end()
                while cursor < len(stream) and stream[cursor : cursor + 1] in WHITESPACE_BYTES:
                    cursor += 1
                size_match = re.match(rb"[-+]?\d+(?:\.\d+)?", stream[cursor:])
                if size_match:
                    cursor += size_match.end()
                    while cursor < len(stream) and stream[cursor : cursor + 1] in WHITESPACE_BYTES:
                        cursor += 1
                    if stream[cursor : cursor + 2] == b"Tf":
                        current_font = alias
                        index = cursor + 2
                        continue
                while cursor < len(stream) and stream[cursor : cursor + 1] in WHITESPACE_BYTES:
                    cursor += 1
                if stream[cursor : cursor + 2] == b"Do" and xobject_text and alias in xobject_text:
                    chunks.append(xobject_text[alias])
                    chunks.append("\n")
                    index = cursor + 2
                    continue
            index += 1
            continue

        if stream[index : index + 1] == b"(":
            raw, next_index = parse_pdf_literal_string(stream, index)
            cursor = next_index
            while cursor < len(stream) and stream[cursor : cursor + 1] in WHITESPACE_BYTES:
                cursor += 1
            if stream[cursor : cursor + 2] == b"Tj" or stream[cursor : cursor + 1] == b"'":
                chunks.append(decode_pdf_text(raw, alias_to_cmap.get(current_font, {})))
            index = next_index
            continue

        if stream[index : index + 1] == b"<":
            if stream[index : index + 2] == b"<<":
                index += 2
                continue
            raw, next_index = parse_pdf_hex_string(stream, index)
            cursor = next_index
            while cursor < len(stream) and stream[cursor : cursor + 1] in WHITESPACE_BYTES:
                cursor += 1
            if stream[cursor : cursor + 2] == b"Tj":
                chunks.append(decode_pdf_text(raw, alias_to_cmap.get(current_font, {})))
            index = next_index
            continue

        if stream[index : index + 1] == b"[":
            end = stream.find(b"]", index + 1)
            if end == -1:
                break
            segment = stream[index + 1 : end]
            cursor = end + 1
            while cursor < len(stream) and stream[cursor : cursor + 1] in WHITESPACE_BYTES:
                cursor += 1
            if stream[cursor : cursor + 2] == b"TJ":
                seg_index = 0
                cmap = alias_to_cmap.get(current_font, {})
                while seg_index < len(segment):
                    if segment[seg_index : seg_index + 1] in WHITESPACE_BYTES:
                        seg_index += 1
                        continue
                    if segment[seg_index : seg_index + 1] == b"(":
                        raw, seg_index = parse_pdf_literal_string(segment, seg_index)
                        chunks.append(decode_pdf_text(raw, cmap))
                        continue
                    if segment[seg_index : seg_index + 1] == b"<":
                        raw, seg_index = parse_pdf_hex_string(segment, seg_index)
                        chunks.append(decode_pdf_text(raw, cmap))
                        continue
                    number_match = re.match(rb"[-+]?\d+(?:\.\d+)?", segment[seg_index:])
                    if number_match:
                        value = float(number_match.group(0))
                        if abs(value) > 120 and chunks and not chunks[-1].endswith((" ", "\n")):
                            chunks.append(" ")
                        seg_index += number_match.end()
                        continue
                    seg_index += 1
                chunks.append("\n")
            index = end + 1
            continue

        if stream[index : index + 2] in {b"Td", b"TD", b"T*"}:
            chunks.append("\n")
            index += 2
            continue

        index += 1

    return "".join(chunks)


def extract_pdf_pages(pdf_bytes: bytes) -> list[str]:
    objects = parse_pdf_objects(pdf_bytes)
    font_cmaps: dict[tuple[int, int], dict[int, str]] = {}

    for obj_ref, body in objects.items():
        if b"/Type" not in body or b"/Font" not in body or b"/ToUnicode" not in body:
            continue
        cmap_match = re.search(rb"/ToUnicode\s+(\d+)\s+(\d+)\s+R", body)
        if not cmap_match:
            continue
        cmap_ref = (int(cmap_match.group(1)), int(cmap_match.group(2)))
        cmap_body = objects.get(cmap_ref)
        if not cmap_body:
            continue
        cmap_stream = get_pdf_stream(cmap_body)
        if not cmap_stream:
            continue
        font_cmaps[obj_ref] = parse_to_unicode_cmap(cmap_stream)

    xobject_text_cache: dict[tuple[int, int], str] = {}

    def extract_xobject_text(
        xobject_ref: tuple[int, int],
        parent_resources: bytes | None,
        active_stack: set[tuple[int, int]] | None = None,
    ) -> str:
        if xobject_ref in xobject_text_cache:
            return xobject_text_cache[xobject_ref]
        if active_stack and xobject_ref in active_stack:
            return ""
        body = objects.get(xobject_ref)
        if not body or b"/Subtype/Form" not in body:
            xobject_text_cache[xobject_ref] = ""
            return ""
        next_stack = set(active_stack or set())
        next_stack.add(xobject_ref)
        resource_body = resolve_resource_dict(body, objects) or parent_resources
        if not resource_body:
            xobject_text_cache[xobject_ref] = ""
            return ""
        alias_to_font = extract_font_aliases(resource_body)
        alias_to_cmap = {alias: font_cmaps.get(font_ref, {}) for alias, font_ref in alias_to_font.items()}
        xobject_refs = extract_named_refs_from_dict(extract_inline_dict(resource_body, b"/XObject") or b"")
        nested_xobject_text = {
            alias: extract_xobject_text(ref, resource_body, next_stack)
            for alias, ref in xobject_refs.items()
        }
        stream = get_pdf_stream(body)
        if not stream:
            xobject_text_cache[xobject_ref] = ""
            return ""
        text = extract_text_from_content_stream(stream, alias_to_cmap, xobject_text=nested_xobject_text)
        xobject_text_cache[xobject_ref] = text
        return text

    pages: list[str] = []
    for body in objects.values():
        if b"/Type" not in body or b"/Page" not in body or b"/Pages" in body:
            continue
        resources_body = resolve_resource_dict(body, objects)
        if not resources_body:
            continue

        alias_to_font = extract_font_aliases(resources_body)
        alias_to_cmap = {alias: font_cmaps.get(font_ref, {}) for alias, font_ref in alias_to_font.items()}
        xobject_refs = extract_named_refs_from_dict(extract_inline_dict(resources_body, b"/XObject") or b"")
        xobject_text = {
            alias: extract_xobject_text(ref, resources_body)
            for alias, ref in xobject_refs.items()
        }
        page_chunks: list[str] = []
        for content_ref in extract_content_refs(body):
            content_body = objects.get(content_ref)
            if not content_body:
                continue
            content_stream = get_pdf_stream(content_body)
            if not content_stream:
                continue
            page_chunks.append(extract_text_from_content_stream(content_stream, alias_to_cmap, xobject_text=xobject_text))
        page_chunks.extend(resolve_annotation_uris(body, objects))
        if page_chunks:
            page_text = collapse_ws("\n".join(page_chunks))
            if page_text:
                pages.append(page_text)

    return pages


def extract_pdf_text(pdf_bytes: bytes) -> str:
    return collapse_ws("\n\n".join(extract_pdf_pages(pdf_bytes)))


def page_has_title_citation_context(normalized_page: str, paper: dict) -> bool:
    variants = paper.get("titleVariants") or []
    if not variants or not normalized_page:
        return False

    author_surnames = paper.get("authorSurnames") or []
    year = collapse_ws(str(paper.get("year", "")))

    for variant in variants:
        needle = f" {variant} "
        start = normalized_page.find(needle)
        while start != -1:
            window = normalized_page[max(0, start - 220): start + len(needle) + 220]
            if any(f" {surname} " in window for surname in author_surnames):
                return True
            if re.fullmatch(r"\d{4}", year) and (f" {year} " in window or f" {year[-2:]} " in window):
                return True
            if any(phrase in window for phrase in CITATION_CONTEXT_PHRASES):
                return True
            start = normalized_page.find(needle, start + len(needle))

    return False


def page_has_talk_reference_context(normalized_page: str, talk: dict) -> bool:
    variants = talk.get("titleVariants") or []
    if not variants or not normalized_page:
        return False

    speaker_surnames = talk.get("speakerSurnames") or []
    year = collapse_ws(str(talk.get("year", "")))

    for variant in variants:
        needle = f" {variant} "
        start = normalized_page.find(needle)
        while start != -1:
            window = normalized_page[max(0, start - 220): start + len(needle) + 220]
            if any(f" {phrase} " in window for phrase in TALK_CONTEXT_PHRASES):
                return True
            if any(f" {surname} " in window for surname in speaker_surnames):
                return True
            if re.fullmatch(r"\d{4}", year) and f" {year} " in window:
                return True
            start = normalized_page.find(needle, start + len(needle))

    return False


def find_slide_paper_matches(slide_pages: list[str], papers: list[dict]) -> list[str]:
    page_texts = [collapse_ws(page) for page in slide_pages if collapse_ws(page)]
    slide_text = "\n\n".join(page_texts)
    raw_lower = collapse_ws(slide_text).lower()
    normalized = normalize_match_text(slide_text)
    if not normalized:
        return []

    normalized_pages = [f" {normalize_match_text(page)} " for page in page_texts]
    matched_ids: list[str] = []
    seen: set[str] = set()

    for paper in papers:
        paper_id = paper["id"]
        if paper_id in seen:
            continue

        doi = paper.get("doi") or ""
        if doi and doi in normalized:
            seen.add(paper_id)
            matched_ids.append(paper_id)
            continue

        url_keys = paper.get("urlKeys") or []
        if any(url and url in raw_lower for url in url_keys):
            seen.add(paper_id)
            matched_ids.append(paper_id)
            continue

        if any(page_has_title_citation_context(page, paper) for page in normalized_pages):
            seen.add(paper_id)
            matched_ids.append(paper_id)

    return matched_ids


def find_slide_talk_matches(slide_pages: list[str], talks: list[dict], current_talk_id: str) -> list[str]:
    page_texts = [collapse_ws(page) for page in slide_pages if collapse_ws(page)]
    slide_text = "\n\n".join(page_texts)
    raw_lower = collapse_ws(slide_text).lower()
    normalized = normalize_match_text(slide_text)
    if not normalized:
        return []

    normalized_pages = [f" {normalize_match_text(page)} " for page in page_texts]
    matched_ids: list[str] = []
    seen: set[str] = set()

    for talk in talks:
        talk_id = collapse_ws(str(talk.get("id", "")))
        if not talk_id or talk_id == current_talk_id or talk_id in seen:
            continue

        url_keys = talk.get("urlKeys") or []
        if any(url and url in raw_lower for url in url_keys):
            seen.add(talk_id)
            matched_ids.append(talk_id)
            continue

        if any(page_has_talk_reference_context(page, talk) for page in normalized_pages):
            seen.add(talk_id)
            matched_ids.append(talk_id)

    return matched_ids


def generate_talk_artifact(
    talks: list[dict],
    papers: list[dict],
    reference_talks: list[dict],
    existing: dict,
    *,
    fetch_pdf_references: bool,
    timeout: float,
    refresh_existing: bool,
    local_devmtg_root: Path | None,
    local_mlir_www_root: Path | None,
) -> dict:
    talks_map = dict(existing.get("talks") or {})
    existing_processor_version = int(existing.get("processorVersion") or 0)

    for talk in talks:
        talk_id = collapse_ws(str(talk.get("id", "")))
        if not talk_id:
            continue

        slides_url = collapse_ws(str(talk.get("slidesUrl", "")))
        abstract_reference_items = extract_reference_items_from_text(str(talk.get("abstract", "")), source="abstract")
        previous = talks_map.get(talk_id)
        previous_slides_url = collapse_ws(str((previous or {}).get("slidesUrl", "")))
        previous_slide_paper_ids = (
            [collapse_ws(str(value)) for value in (previous or {}).get("slidePaperIds", []) if collapse_ws(str(value))]
            if isinstance((previous or {}).get("slidePaperIds"), list)
            else []
        )
        previous_slide_talk_ids = (
            [collapse_ws(str(value)) for value in (previous or {}).get("slideTalkIds", []) if collapse_ws(str(value))]
            if isinstance((previous or {}).get("slideTalkIds"), list)
            else []
        )
        previous_slide_github_repo_urls = (
            dedupe_urls(
                normalize_github_url(value)
                for value in (previous or {}).get("slideGithubRepoUrls", [])
            )
            if isinstance((previous or {}).get("slideGithubRepoUrls"), list)
            else []
        )
        previous_slide_reference_items = merge_reference_items(
            (previous or {}).get("slideReferenceItems", []),
            (previous or {}).get("slideGithubReferences", []),
        )
        previous_reference_items = merge_reference_items(
            (previous or {}).get("referenceItems", []),
            (previous or {}).get("githubReferences", []),
        )
        previous_slide_github_references = filter_github_reference_items(previous_slide_reference_items)
        if not fetch_pdf_references:
            merged_reference_items = merge_reference_items(
                abstract_reference_items,
                previous_slide_reference_items,
                previous_reference_items,
            )
            merged_github_references = filter_github_reference_items(merged_reference_items)
            talks_map[talk_id] = {
                "slidesUrl": slides_url,
                "slidePaperIds": previous_slide_paper_ids,
                "slideTalkIds": previous_slide_talk_ids,
                "slideGithubRepoUrls": previous_slide_github_repo_urls,
                "slideGithubReferences": previous_slide_github_references,
                "slideReferenceItems": previous_slide_reference_items,
                "githubRepoUrls": reference_urls_from_items(merged_github_references),
                "githubReferences": merged_github_references,
                "referenceItems": merged_reference_items,
            }
            continue
        if not slides_url.lower().startswith(("http://", "https://")):
            merged_reference_items = merge_reference_items(abstract_reference_items)
            merged_github_references = filter_github_reference_items(merged_reference_items)
            talks_map[talk_id] = {
                "slidesUrl": slides_url,
                "slidePaperIds": [],
                "slideTalkIds": [],
                "slideGithubRepoUrls": [],
                "slideGithubReferences": [],
                "slideReferenceItems": [],
                "githubRepoUrls": reference_urls_from_items(merged_github_references),
                "githubReferences": merged_github_references,
                "referenceItems": merged_reference_items,
            }
            continue

        if (
            not refresh_existing
            and existing_processor_version == ARTIFACT_VERSION
            and previous
            and previous_slides_url == slides_url
            and isinstance(previous.get("slidePaperIds"), list)
        ):
            merged_reference_items = merge_reference_items(
                abstract_reference_items,
                previous_slide_reference_items,
                previous_reference_items,
            )
            merged_github_references = filter_github_reference_items(merged_reference_items)
            talks_map[talk_id] = {
                **previous,
                "slidesUrl": slides_url,
                "slidePaperIds": previous_slide_paper_ids,
                "slideTalkIds": previous_slide_talk_ids,
                "slideGithubRepoUrls": previous_slide_github_repo_urls,
                "slideGithubReferences": previous_slide_github_references,
                "slideReferenceItems": previous_slide_reference_items,
                "githubRepoUrls": reference_urls_from_items(merged_github_references),
                "githubReferences": merged_github_references,
                "referenceItems": merged_reference_items,
            }
            print(f"kept {talk_id}: existing slide-reference papers", file=sys.stderr)
            continue

        try:
            pdf_bytes = fetch_bytes(
                slides_url,
                timeout=timeout,
                local_devmtg_root=local_devmtg_root,
                local_mlir_www_root=local_mlir_www_root,
            )
            pdf_pages = extract_pdf_pages(pdf_bytes)
            slide_paper_ids = find_slide_paper_matches(pdf_pages, papers)
            slide_talk_ids = find_slide_talk_matches(pdf_pages, reference_talks, talk_id)
            slide_reference_items = extract_reference_items_from_pages(pdf_pages)
            slide_github_references = filter_github_reference_items(slide_reference_items)
            slide_github_repo_urls = reference_urls_from_items(slide_github_references)
            merged_reference_items = merge_reference_items(abstract_reference_items, slide_reference_items)
            merged_github_references = filter_github_reference_items(merged_reference_items)
            talks_map[talk_id] = {
                "slidesUrl": slides_url,
                "slidePaperIds": slide_paper_ids,
                "slideTalkIds": slide_talk_ids,
                "slideGithubRepoUrls": slide_github_repo_urls,
                "slideGithubReferences": slide_github_references,
                "slideReferenceItems": slide_reference_items,
                "githubRepoUrls": reference_urls_from_items(merged_github_references),
                "githubReferences": merged_github_references,
                "referenceItems": merged_reference_items,
                "slideChecksum": hashlib.sha1(pdf_bytes).hexdigest(),
            }
            print(
                f"linked {talk_id}: {len(slide_paper_ids)} slide-reference papers, "
                f"{len(slide_talk_ids)} slide-reference talks, {len(slide_reference_items)} link refs",
                file=sys.stderr,
            )
        except Exception as exc:
            merged_reference_items = merge_reference_items(
                abstract_reference_items,
                previous_slide_reference_items,
                previous_reference_items,
            )
            merged_github_references = filter_github_reference_items(merged_reference_items)
            if previous:
                talks_map[talk_id] = {
                    **previous,
                    "slidesUrl": slides_url,
                    "slidePaperIds": previous_slide_paper_ids,
                    "slideTalkIds": previous_slide_talk_ids,
                    "slideGithubRepoUrls": previous_slide_github_repo_urls,
                    "slideGithubReferences": previous_slide_github_references,
                    "slideReferenceItems": previous_slide_reference_items,
                    "githubRepoUrls": reference_urls_from_items(merged_github_references),
                    "githubReferences": merged_github_references,
                    "referenceItems": merged_reference_items,
                }
            else:
                talks_map[talk_id] = {
                    "slidesUrl": slides_url,
                    "slidePaperIds": [],
                    "slideTalkIds": [],
                    "slideGithubRepoUrls": [],
                    "slideGithubReferences": [],
                    "slideReferenceItems": [],
                    "githubRepoUrls": reference_urls_from_items(merged_github_references),
                    "githubReferences": merged_github_references,
                    "referenceItems": merged_reference_items,
                }
            print(f"warning: could not refresh slide references for {talk_id}: {exc}", file=sys.stderr)

    timestamp = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return {
        "dataVersion": f"{dt.date.today().isoformat()}-talk-paper-links-v{ARTIFACT_VERSION}",
        "generatedAt": timestamp,
        "processorVersion": ARTIFACT_VERSION,
        "talks": dict(sorted(talks_map.items())),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--output", default="js/data/talk-paper-links.json")
    parser.add_argument("--meeting", action="append", default=[])
    parser.add_argument("--talk-id", action="append", default=[])
    parser.add_argument("--fetch-pdf-references", action="store_true")
    parser.add_argument("--refresh-existing", action="store_true")
    parser.add_argument("--include-mlir", action="store_true")
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--local-devmtg-root", default="")
    parser.add_argument("--local-mlir-www-root", default="")
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    output_path = (repo_root / args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    local_devmtg_root = Path(args.local_devmtg_root).resolve() if collapse_ws(args.local_devmtg_root) else None
    local_mlir_www_root = Path(args.local_mlir_www_root).resolve() if collapse_ws(args.local_mlir_www_root) else None

    all_talks = load_event_bundles(repo_root)
    if args.include_mlir:
        all_talks.extend(load_mlir_talks(repo_root))
    papers = load_papers(repo_root)
    reference_talks = [item for item in (normalize_reference_talk(talk) for talk in all_talks) if item]
    existing = load_existing_artifact(output_path)

    meetings = {collapse_ws(value) for value in args.meeting if collapse_ws(value)}
    talk_ids = {collapse_ws(value) for value in args.talk_id if collapse_ws(value)}
    target_talks = select_target_talks(all_talks, meetings, talk_ids)

    if not target_talks and (meetings or talk_ids):
        print("warning: no talks matched the provided filters", file=sys.stderr)
        return 0

    if not target_talks:
        target_talks = all_talks

    artifact = generate_talk_artifact(
        target_talks,
        papers,
        reference_talks,
        existing,
        fetch_pdf_references=args.fetch_pdf_references,
        timeout=args.timeout,
        refresh_existing=args.refresh_existing,
        local_devmtg_root=local_devmtg_root,
        local_mlir_www_root=local_mlir_www_root,
    )

    output_path.write_text(json.dumps(artifact, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    print(f"wrote {output_path} (talks updated: {len(target_talks)})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
