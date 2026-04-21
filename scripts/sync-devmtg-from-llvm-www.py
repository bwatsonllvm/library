#!/usr/bin/env python3
"""Sync LLVM Developers' Meeting talks/slides/videos from llvm-www/devmtg.

The sync is intentionally conservative:
  - existing talk IDs are preserved
  - existing matched talks are left as-is
  - newly discovered talks are appended with the next sequential ID
  - only upstream-changed meeting folders are revisited automatically
  - meeting bundles are created only when a source page has parseable talks
"""

from __future__ import annotations

import argparse
import datetime as _dt
import html
import json
import os
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


GITHUB_API_BASE = "https://api.github.com"
LLVM_WWW_REPO = "llvm/llvm-www"
LLVM_WWW_REF = "main"

URLLIB_SSL_CONTEXT: ssl.SSLContext | None = None

CATEGORY_MAP: dict[str, str] = {
    "keynote": "keynote",
    "keynotes": "keynote",
    "technical talk": "technical-talk",
    "technical talks": "technical-talk",
    "student technical talk": "student-talk",
    "student technical talks": "student-talk",
    "tutorial": "tutorial",
    "tutorials": "tutorial",
    "panel": "panel",
    "panels": "panel",
    "quick talk": "quick-talk",
    "quick talks": "quick-talk",
    "lightning talk": "lightning-talk",
    "lightning talks": "lightning-talk",
    "bof": "bof",
    "birds of a feather": "bof",
    "poster": "poster",
    "posters": "poster",
    "workshop": "workshop",
    "workshops": "workshop",
}


def collapse_ws(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def normalize_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", collapse_ws(value).lower())


def sanitize_http_url(value: str) -> str:
    raw = collapse_ws(value)
    if not raw:
        return ""
    try:
        parsed = urllib.parse.urlsplit(raw)
    except Exception:
        return ""
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        return ""
    if not parsed.netloc:
        return ""
    path = urllib.parse.quote(
        urllib.parse.unquote(parsed.path or ""),
        safe="/:@!$&'()*,;=-._~",
    )
    query = urllib.parse.quote(
        urllib.parse.unquote(parsed.query or ""),
        safe="=&/?:@!$'()*+,;%-._~",
    )
    fragment = urllib.parse.quote(
        urllib.parse.unquote(parsed.fragment or ""),
        safe="/?:@!$&'()*+,;=-._~",
    )
    return urllib.parse.urlunsplit((scheme, parsed.netloc, path, query, fragment))


def is_github_api_url(url: str) -> bool:
    raw = collapse_ws(url)
    if not raw:
        return False
    try:
        parsed = urllib.parse.urlparse(raw)
    except Exception:
        return False
    host = (parsed.hostname or "").lower()
    return host == "api.github.com"


def normalize_meta_value(value: str) -> str:
    return normalize_key(value)


META_PLACEHOLDER_KEYS = {
    "tbd",
    "tba",
    "tbc",
    "na",
    "n/a",
    "none",
    "unknown",
    "null",
    "todo",
    "comingsoon",
    "tobeannounced",
    "tobedetermined",
}


ABSTRACT_PLACEHOLDER_KEYS = {
    "tbd",
    "tba",
    "none",
    "unknown",
    "noabstract",
    "noabstractavailable",
    "abstracttbd",
}


def has_meaningful_meta_value(value: str) -> bool:
    key = normalize_meta_value(value)
    if not key:
        return False
    return key not in META_PLACEHOLDER_KEYS


def has_meaningful_abstract(value: str) -> bool:
    key = normalize_meta_value(value)
    if not key:
        return False
    return key not in ABSTRACT_PLACEHOLDER_KEYS


def pick_preferred_meta_value(*values: str) -> str:
    for value in values:
        text = collapse_ws(str(value or ""))
        if has_meaningful_meta_value(text):
            return text
    for value in values:
        text = collapse_ws(str(value or ""))
        if text:
            return text
    return ""


def strip_html(value: str) -> str:
    if not value:
        return ""
    value = re.sub(r"<script\b[^>]*>.*?</script>", " ", value, flags=re.IGNORECASE | re.DOTALL)
    value = re.sub(r"<style\b[^>]*>.*?</style>", " ", value, flags=re.IGNORECASE | re.DOTALL)
    value = re.sub(r"<br\s*/?>", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"</p\s*>", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"<[^>]+>", " ", value)
    return collapse_ws(html.unescape(value))


def normalize_speaker_name(name: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", "", collapse_ws(name).lower()).strip()


def strip_leading_title_from_abstract(text: str, title: str) -> str:
    abstract_text = collapse_ws(text)
    title_text = collapse_ws(title)
    if not abstract_text or not title_text:
        return abstract_text

    def _looks_like_metadata_prefix(value: str) -> bool:
        return bool(
            re.match(
                r"^\s*(?:\[\s*(?:video|slides?)\s*\]|(?:speakers?|presenters?)\s*:)",
                value,
                flags=re.IGNORECASE,
            )
        )

    literal_pattern = re.compile(
        rf"^\s*{re.escape(title_text)}\s*(?:[:\-–—]\s*)?",
        flags=re.IGNORECASE,
    )
    literal_match = literal_pattern.match(abstract_text)
    if literal_match:
        remainder = abstract_text[literal_match.end() :]
        if not collapse_ws(remainder) or _looks_like_metadata_prefix(remainder):
            return remainder
        return abstract_text

    abstract_key = normalize_key(abstract_text)
    title_key = normalize_key(title_text)
    if not title_key or not abstract_key.startswith(title_key):
        return abstract_text

    consumed: list[str] = []
    end_index = -1
    for idx, char in enumerate(abstract_text):
        if char.isalnum():
            consumed.append(char.lower())
            if len(consumed) >= len(title_key):
                end_index = idx + 1
                break

    if end_index <= 0:
        return abstract_text
    if "".join(consumed[: len(title_key)]) != title_key:
        return abstract_text
    remainder = abstract_text[end_index:]
    if not collapse_ws(remainder) or _looks_like_metadata_prefix(remainder):
        return remainder
    return abstract_text


def strip_leading_speaker_block(text: str, speakers: list[dict]) -> str:
    value = collapse_ws(text)
    if not value:
        return value

    prefix_match = re.match(
        r"^\s*(?:speakers?|presenters?)\s*:\s*",
        value,
        flags=re.IGNORECASE,
    )
    if not prefix_match:
        return value

    remainder = value[prefix_match.end() :].lstrip()
    speaker_names = [
        collapse_ws(str(item.get("name", "")))
        for item in (speakers or [])
        if isinstance(item, dict) and collapse_ws(str(item.get("name", "")))
    ]
    speaker_names = sorted(set(speaker_names), key=len, reverse=True)

    if speaker_names:
        speaker_alt = "|".join(re.escape(name) for name in speaker_names)
        list_pattern = re.compile(
            rf"^(?:{speaker_alt})(?:\s*(?:,|and|&)\s*(?:{speaker_alt}))*\s*(?:[:;\-–—]\s*)?",
            flags=re.IGNORECASE,
        )
        list_match = list_pattern.match(remainder)
        if list_match:
            return remainder[list_match.end() :]

    return remainder


def strip_leading_speaker_context_block(text: str, speakers: list[dict]) -> str:
    value = collapse_ws(text)
    if not value:
        return value

    speaker_names = [
        collapse_ws(str(item.get("name", "")))
        for item in (speakers or [])
        if isinstance(item, dict) and collapse_ws(str(item.get("name", "")))
    ]
    speaker_names = sorted(set(speaker_names), key=len, reverse=True)
    if not speaker_names:
        return value

    speaker_alt = "|".join(re.escape(name) for name in speaker_names)
    speaker_list = rf"(?:{speaker_alt})(?:\s*(?:,|and|&)\s*(?:{speaker_alt}))*"
    context_prefix = "|".join(SPEAKER_CONTEXT_PREFIXES)
    pattern = re.compile(
        rf"^\s*(?:(?:{context_prefix})\b[\s:;\-–—,]*{speaker_list}\s*,?\s*)+",
        flags=re.IGNORECASE,
    )
    match = pattern.match(value)
    if not match:
        return value
    return value[match.end() :]


def clean_abstract_text(raw: str, title: str = "", speakers: list[dict] | None = None) -> str:
    text = collapse_ws(raw)
    if not text:
        return ""

    for _ in range(6):
        before = text
        text = strip_leading_title_from_abstract(text, title)
        text = re.sub(
            r"^\s*(?:\[\s*(?:video|slides?)\s*\]\s*)+",
            "",
            text,
            flags=re.IGNORECASE,
        )
        text = strip_leading_speaker_block(text, speakers or [])
        text = strip_leading_speaker_context_block(text, speakers or [])
        text = re.sub(r"^\s*[-:;,.]+\s*", "", text)
        text = collapse_ws(text)
        if text == before:
            break

    return text


def build_speaker_record(name: str, affiliation: str = "") -> dict:
    return {
        "name": collapse_ws(name),
        "affiliation": collapse_ws(affiliation),
        "github": "",
        "linkedin": "",
        "twitter": "",
    }


SPEAKER_CONTEXT_PREFIXES = [
    r"(?:presented\s+(?:virtually\s+)?by)",
    r"(?:virtual\s+presenter)",
    r"(?:virtual\s+presentation\s+by)",
    r"(?:(?:virtual\s+)?q\s*(?:&|and)\s*a(?:\s+(?:with|featuring))?)",
    r"(?:(?:virtual\s+)?questions?\s*(?:&|and)\s*answers?\s+(?:with|featuring))",
]


def strip_speaker_context_prefix(value: str) -> str:
    text = collapse_ws(value)
    if not text:
        return ""

    changed = True
    while changed:
        changed = False
        next_text = re.sub(
            rf"^\s*(?:{'|'.join(SPEAKER_CONTEXT_PREFIXES)})\b[\s:;\-–—,]*",
            "",
            text,
            flags=re.IGNORECASE,
        )
        next_text = collapse_ws(next_text)
        if next_text != text:
            text = next_text
            changed = True
    return text


def dedupe_speaker_records(speakers: list[dict] | None) -> list[dict]:
    out: list[dict] = []
    by_name: dict[str, dict] = {}
    for speaker in normalize_speaker_records(speakers):
        key = normalize_speaker_name(str(speaker.get("name", "")))
        if not key:
            continue
        existing = by_name.get(key)
        if existing is None:
            existing = dict(speaker)
            by_name[key] = existing
            out.append(existing)
            continue
        for field in ["affiliation", "github", "linkedin", "twitter"]:
            if not existing.get(field) and speaker.get(field):
                existing[field] = speaker[field]
    return out


def split_speaker_names(raw: str) -> list[str]:
    clean = collapse_ws(raw)
    if not clean or clean in {"-", "—"}:
        return []

    parts: list[str] = []
    current: list[str] = []
    depth = 0
    idx = 0
    length = len(clean)
    while idx < length:
        char = clean[idx]
        if char == "(":
            depth += 1
            current.append(char)
            idx += 1
            continue
        if char == ")":
            depth = max(0, depth - 1)
            current.append(char)
            idx += 1
            continue

        if depth == 0 and char == ",":
            part = collapse_ws("".join(current))
            if part:
                parts.append(part)
            current = []
            idx += 1
            while idx < length and clean[idx].isspace():
                idx += 1
            continue

        if depth == 0:
            remaining = clean[idx:]
            and_match = re.match(r"^(?:\s+(?:and|&)\s+)", remaining, flags=re.IGNORECASE)
            if and_match:
                part = collapse_ws("".join(current))
                if part:
                    parts.append(part)
                current = []
                idx += and_match.end()
                continue

        current.append(char)
        idx += 1

    tail = collapse_ws("".join(current))
    if tail:
        parts.append(tail)
    out: list[str] = []
    for part in parts:
        text = collapse_ws(re.sub(r"^(?:and|&)\s+", "", part, flags=re.IGNORECASE))
        text = strip_speaker_context_prefix(text)
        if text:
            out.append(text)
    return out


def parse_speaker_token(raw: str, default_affiliation: str = "") -> dict | None:
    clean = collapse_ws(raw)
    if not clean:
        return None

    affiliation = collapse_ws(default_affiliation)
    name = clean

    paren_match = re.match(r"^(.*?)\s*\(([^()]+)\)\s*$", clean)
    if paren_match:
        name = collapse_ws(paren_match.group(1))
        affiliation = collapse_ws(paren_match.group(2)) or affiliation
        if not name:
            return None
        return build_speaker_record(name, affiliation)

    if not affiliation:
        shared_match = re.match(r"^(.*?)\s+[-–—]\s+(.+)$", clean)
        if shared_match and has_meaningful_meta_value(shared_match.group(2)):
            name = collapse_ws(shared_match.group(1))
            affiliation = collapse_ws(shared_match.group(2))

    if not name:
        return None
    return build_speaker_record(name, affiliation)


def parse_speakers(raw: str, default_affiliation: str = "") -> list[dict]:
    clean = collapse_ws(raw)
    if not clean or clean in {"-", "—"}:
        return []

    shared_affiliation = collapse_ws(default_affiliation)
    if not shared_affiliation:
        shared_match = re.match(r"^(.*?)\s+[-–—]\s+(.+)$", clean)
        if shared_match and has_meaningful_meta_value(shared_match.group(2)):
            clean = collapse_ws(shared_match.group(1))
            shared_affiliation = collapse_ws(shared_match.group(2))

    parts = split_speaker_names(clean)
    if not parts and clean:
        parts = [clean]

    out: list[dict] = []
    for part in parts:
        speaker = parse_speaker_token(part, default_affiliation=shared_affiliation)
        if speaker:
            out.append(speaker)
    return dedupe_speaker_records(out)


def extract_anchor_links(fragment: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for match in re.finditer(r"<a\b(?P<attrs>[^>]*)>(?P<label>.*?)</a>", fragment, flags=re.IGNORECASE | re.DOTALL):
        attrs = match.group("attrs") or ""
        href_match = re.search(r"href\s*=\s*(.+)$", attrs, flags=re.IGNORECASE | re.DOTALL)
        if not href_match:
            continue
        href_tail = href_match.group(1).lstrip()
        href = ""
        if href_tail[:1] in {'"', "'"}:
            quote = href_tail[0]
            end = href_tail.find(quote, 1)
            if end > 1:
                href = href_tail[1:end]
            else:
                href = re.split(r"[\s>]", href_tail.lstrip("\"'"), maxsplit=1)[0]
        else:
            href = re.split(r"[\s>]", href_tail, maxsplit=1)[0]
        href = collapse_ws(href).strip("\"'")
        if not href:
            continue
        out.append((href, match.group("label") or ""))
    return out


def normalize_talk_title_for_matching(title: str) -> str:
    clean = clean_title(title)
    lower = clean.lower()
    for prefix in (
        "keynote:",
        "tutorial:",
        "workshop:",
        "panel:",
        "quick talk:",
        "quick talks:",
        "bof:",
        "lightning talk:",
        "lightning talks:",
        "poster:",
    ):
        if lower.startswith(prefix):
            return collapse_ws(clean[len(prefix) :])
    return clean


def normalize_talk_title_key(title: str) -> str:
    return normalize_key(normalize_talk_title_for_matching(title))


def parse_legacy_speaker_cell(fragment: str) -> list[dict]:
    chunks = [
        part
        for part in re.split(r"<br\s*/?>", fragment, flags=re.IGNORECASE)
        if collapse_ws(strip_html(part))
    ]
    out: list[dict] = []
    for chunk in chunks:
        affiliations = [
            collapse_ws(strip_html(value))
            for value in re.findall(r"<i\b[^>]*>(.*?)</i>", chunk, flags=re.IGNORECASE | re.DOTALL)
            if collapse_ws(strip_html(value))
        ]
        shared_affiliation = " / ".join(affiliations)
        speaker_text = collapse_ws(
            strip_html(
                re.sub(
                    r"<i\b[^>]*>.*?</i>",
                    " ",
                    chunk,
                    flags=re.IGNORECASE | re.DOTALL,
                )
            )
        )
        speaker_text = re.sub(r"\s*,\s*$", "", speaker_text)
        parsed = parse_speakers(speaker_text, default_affiliation=shared_affiliation)
        if shared_affiliation:
            parsed = [
                speaker
                for speaker in parsed
                if not speaker_name_looks_like_affiliation(str(speaker.get("name", "")))
            ]
        out.extend(parsed)
    return out


def parse_legacy_info_cell(info_html: str) -> tuple[str, str, list[dict]]:
    info_parts = re.split(r"<br\s*/?>", info_html, maxsplit=1, flags=re.IGNORECASE)
    header_html = info_parts[0] if info_parts else info_html
    speaker_html = info_parts[1] if len(info_parts) > 1 else ""
    title = clean_title(strip_html(header_html))
    anchor_match = re.search(r"href=['\"]#([^'\"]+)['\"]", header_html, flags=re.IGNORECASE)
    anchor_id = collapse_ws(anchor_match.group(1)) if anchor_match else ""
    speakers = parse_legacy_speaker_cell(speaker_html)
    return title, anchor_id, speakers


def legacy_category_marker_from_title(title: str) -> str | None:
    clean = collapse_ws(title).lower().rstrip(":")
    if clean in {"lightning talk", "lightning talks"}:
        return "lightning-talk"
    if clean in {"poster", "posters"}:
        return "poster"
    if clean in {"bof", "bofs", "birds of a feather"}:
        return "bof"
    return None


def parse_inline_category_title(raw_title: str, default_category: str) -> tuple[str, str]:
    title = clean_title(raw_title)
    lower = title.lower()
    if lower.startswith("keynote:"):
        return "keynote", collapse_ws(title.split(":", 1)[1])
    if lower.startswith("tutorial:"):
        return "tutorial", collapse_ws(title.split(":", 1)[1])
    if lower.startswith("workshop:"):
        return "workshop", collapse_ws(title.split(":", 1)[1])
    if lower.startswith("panel:"):
        return "panel", collapse_ws(title.split(":", 1)[1])
    if lower.startswith("quick talk:"):
        return "quick-talk", collapse_ws(title.split(":", 1)[1])
    if lower.startswith("quick talks:"):
        return "quick-talk", collapse_ws(title.split(":", 1)[1])
    if lower.startswith("bof:"):
        return "bof", collapse_ws(title.split(":", 1)[1])
    if lower.startswith("lightning talk:"):
        return "lightning-talk", collapse_ws(title.split(":", 1)[1])
    if lower.startswith("lightning talks:"):
        return "lightning-talk", collapse_ws(title.split(":", 1)[1])
    if lower.startswith("poster:"):
        return "poster", collapse_ws(title.split(":", 1)[1])
    return default_category, title


def derive_legacy_table_context(page_html: str, table_start: int, meeting_slug: str) -> tuple[str, str]:
    context_html = page_html[max(0, table_start - 1600) : table_start]
    blocks = list(
        re.finditer(
            r"(<p\b[^>]*>\s*<b\b[^>]*>.*?</b>.*?</p>|<h[1-6]\b[^>]*>.*?</h[1-6]>|<div\b[^>]*class=['\"]www_sectiontitle['\"][^>]*>.*?</div>)",
            context_html,
            flags=re.IGNORECASE | re.DOTALL,
        )
    )
    if not blocks:
        return "technical-talk", ""

    heading_html = blocks[-1].group(1)
    heading_text = clean_title(strip_html(heading_html))
    category = "technical-talk"
    heading_lower = heading_text.lower()
    if "," not in heading_text and " and " not in heading_lower:
        derived = category_from_heading(heading_text)
        if derived:
            category = derived

    shared_video = ""
    if category == "lightning-talk":
        for href, label in reversed(extract_anchor_links(heading_html)):
            if "video" in collapse_ws(strip_html(label)).lower():
                shared_video = abs_devmtg_url(meeting_slug, href)
                break
    return category, shared_video


def parse_legacy_table_entries(page_html: str, meeting_slug: str) -> list[dict]:
    table_matches = list(
        re.finditer(
            r"<table[^>]*id=['\"]devmtg['\"][^>]*>(.*?)</table>",
            page_html,
            flags=re.IGNORECASE | re.DOTALL,
        )
    )
    if not table_matches:
        return []

    talks: list[dict] = []

    for table_match in table_matches:
        table_html = table_match.group(1)
        current_category, shared_lightning_video = derive_legacy_table_context(
            page_html,
            table_match.start(),
            meeting_slug,
        )
        row_mode = "paired"

        header_match = re.search(r"<tr\b[^>]*>(.*?)</tr>", table_html, flags=re.IGNORECASE | re.DOTALL)
        if header_match and "<th" in header_match.group(1).lower():
            header_labels = [
                collapse_ws(strip_html(cell)).lower()
                for cell in re.findall(r"<th\b[^>]*>(.*?)</th>", header_match.group(1), flags=re.IGNORECASE | re.DOTALL)
            ]
            if len(header_labels) >= 3 and header_labels[0] == "author" and header_labels[1] == "title":
                row_mode = "author-title-media"
            elif (
                len(header_labels) >= 3
                and header_labels[0].startswith("video")
                and "slides" in header_labels[1]
                and header_labels[2] in {"talk", "title", "talk information"}
            ):
                row_mode = "video-slides-info"

        for row_html in re.findall(r"<tr\b[^>]*>(.*?)</tr>", table_html, flags=re.IGNORECASE | re.DOTALL):
            if "<th" in row_html.lower():
                continue

            cells = re.findall(r"<td\b[^>]*>(.*?)</td>", row_html, flags=re.IGNORECASE | re.DOTALL)
            if row_mode == "author-title-media":
                if len(cells) < 3:
                    continue

                speaker_cell, title_cell, media_cell = cells[0], cells[1], cells[2]
                raw_title = clean_title(strip_html(title_cell))
                marker_category = legacy_category_marker_from_title(raw_title)
                row_video_url, row_slides_url = parse_links_from_html(media_cell, meeting_slug)
                if marker_category:
                    if marker_category == "lightning-talk":
                        current_category = marker_category
                        if row_video_url:
                            shared_lightning_video = row_video_url
                    continue

                category, title = parse_inline_category_title(raw_title, current_category)
                if not title:
                    continue

                speaker_parts = re.split(r"<br\s*/?>", speaker_cell, maxsplit=1, flags=re.IGNORECASE)
                speaker_text = collapse_ws(strip_html(speaker_parts[0])) if speaker_parts else ""
                shared_affiliation = collapse_ws(strip_html(speaker_parts[1])) if len(speaker_parts) > 1 else ""
                video_url = row_video_url or (shared_lightning_video if category == "lightning-talk" else "")
                talks.append(
                    {
                        "title": title,
                        "category": category,
                        "speakers": parse_speakers(speaker_text, default_affiliation=shared_affiliation),
                        "abstract": "",
                        "videoUrl": video_url or None,
                        "videoId": parse_video_id(video_url),
                        "slidesUrl": row_slides_url or None,
                    }
                )
                continue

            if row_mode == "video-slides-info":
                if len(cells) < 3:
                    continue

                video_cell, slides_cell, info_cell = cells[0], cells[1], cells[2]
                raw_title, anchor_id, speakers = parse_legacy_info_cell(info_cell)
                marker_category = legacy_category_marker_from_title(raw_title)
                row_video_url, _ = parse_links_from_html(video_cell, meeting_slug)
                _, row_slides_url = parse_links_from_html(slides_cell, meeting_slug)
                if marker_category:
                    if marker_category == "lightning-talk":
                        current_category = marker_category
                        if row_video_url:
                            shared_lightning_video = row_video_url
                    continue

                category, title = parse_inline_category_title(raw_title, current_category)
                if not title:
                    continue
                video_url = row_video_url or (shared_lightning_video if category == "lightning-talk" else "")
                talks.append(
                    {
                        "_anchorId": anchor_id,
                        "title": title,
                        "category": category,
                        "speakers": speakers,
                        "abstract": "",
                        "videoUrl": video_url or None,
                        "videoId": parse_video_id(video_url),
                        "slidesUrl": row_slides_url or None,
                    }
                )
                continue

            if len(cells) < 2:
                continue

            for idx in range(0, len(cells) - 1, 2):
                media_cell, info_cell = cells[idx], cells[idx + 1]
                raw_title, anchor_id, speakers = parse_legacy_info_cell(info_cell)
                marker_category = legacy_category_marker_from_title(raw_title)
                video_url, slides_url = parse_links_from_html(media_cell, meeting_slug)
                if marker_category:
                    if marker_category == "lightning-talk":
                        current_category = marker_category
                        if video_url:
                            shared_lightning_video = video_url
                    continue

                category, title = parse_inline_category_title(raw_title, current_category)
                if not title:
                    continue

                if category == "lightning-talk" and not video_url and shared_lightning_video:
                    video_url = shared_lightning_video
                talks.append(
                    {
                        "_anchorId": anchor_id,
                        "title": title,
                        "category": category,
                        "speakers": speakers,
                        "abstract": "",
                        "videoUrl": video_url or None,
                        "videoId": parse_video_id(video_url),
                        "slidesUrl": slides_url or None,
                    }
                )

    return talks


def parse_labeled_links(fragment: str, meeting_slug: str) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for href, label in extract_anchor_links(fragment):
        url = abs_devmtg_url(meeting_slug, href)
        label_text = collapse_ws(strip_html(label)).strip("[]")
        if not url or not label_text:
            continue
        out.append({"label": label_text, "url": url})
    return out


def parse_programme_speaker_cell(fragment: str) -> list[dict]:
    chunks = [
        collapse_ws(strip_html(part))
        for part in re.split(r"<br\s*/?>", fragment, flags=re.IGNORECASE)
    ]
    chunks = [chunk for chunk in chunks if chunk]
    out: list[dict] = []
    pending_names: list[str] = []

    def flush_pending(affiliation: str = "") -> None:
        nonlocal pending_names
        for name in pending_names:
            out.append(build_speaker_record(name, affiliation))
        pending_names = []

    for chunk in chunks:
        paren_only = re.match(r"^\((.+)\)$", chunk)
        if paren_only and pending_names:
            flush_pending(collapse_ws(paren_only.group(1)))
            continue

        inline_affiliation = re.match(r"^(.*?)\s*\((.+)\)\s*$", chunk)
        if inline_affiliation:
            flush_pending()
            names = split_speaker_names(inline_affiliation.group(1))
            affiliation = collapse_ws(inline_affiliation.group(2))
            for name in names:
                out.append(build_speaker_record(name, affiliation))
            continue

        if pending_names:
            flush_pending()
        pending_names = split_speaker_names(chunk)

    flush_pending()
    return dedupe_speaker_records(out)


def parse_programme_tables(page_html: str, meeting_slug: str) -> list[dict]:
    programme_anchor = re.search(
        r"<h3[^>]*id=['\"]callfor['\"][^>]*>.*?</h3>",
        page_html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not programme_anchor:
        return []

    section_html = page_html[programme_anchor.end() :]
    shared_lightning_video = ""
    lightning_video_match = re.search(
        r"Lightning Talks.*?</h4>\s*<p>\s*<a[^>]+href=['\"]([^'\"]+)['\"]",
        section_html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if lightning_video_match:
        shared_lightning_video = abs_devmtg_url(meeting_slug, lightning_video_match.group(1))

    current_heading = "technical talks"
    talks: list[dict] = []
    token_re = re.compile(
        r"(?P<heading><h4[^>]*>.*?</h4>)|(?P<table><table[^>]*border=['\"]1['\"][^>]*>.*?</table>)",
        flags=re.IGNORECASE | re.DOTALL,
    )

    for token in token_re.finditer(section_html):
        heading_html = token.group("heading")
        if heading_html:
            current_heading = collapse_ws(strip_html(heading_html))
            continue

        table_html = token.group("table")
        if not table_html:
            continue

        heading_key = current_heading.lower()
        for row_html in re.findall(r"<tr\b[^>]*>(.*?)</tr>", table_html, flags=re.IGNORECASE | re.DOTALL):
            if "<th" in row_html.lower():
                continue
            cells = re.findall(r"<td\b[^>]*>(.*?)</td>", row_html, flags=re.IGNORECASE | re.DOTALL)
            if len(cells) < 3:
                continue

            speaker_html, title_html, links_html = cells[0], cells[1], cells[2]
            raw_title = clean_title(strip_html(title_html))
            if not raw_title:
                continue

            category = "technical-talk"
            title = raw_title
            if raw_title.lower().startswith("keynote:"):
                category = "keynote"
                title = collapse_ws(raw_title.split(":", 1)[1])
            elif "tutorial" in heading_key:
                category = "tutorial"
            elif "lightning" in heading_key and "poster" in heading_key:
                link_labels = [collapse_ws(str(link.get("label", ""))).lower() for link in parse_labeled_links(links_html, meeting_slug)]
                if any("slides" in label for label in link_labels):
                    category = "lightning-talk"
                elif any("poster" in label for label in link_labels):
                    category = "poster"
                else:
                    category = "lightning-talk"

            links = parse_labeled_links(links_html, meeting_slug)
            slides_url = ""
            poster_url = ""
            video_url = ""
            for link in links:
                label = collapse_ws(str(link.get("label", ""))).lower()
                url = collapse_ws(str(link.get("url", "")))
                if not url:
                    continue
                if "video" in label and not video_url:
                    video_url = url
                elif "slides" in label and not slides_url:
                    slides_url = url
                elif "poster" in label and not poster_url:
                    poster_url = url

            if category == "lightning-talk" and not video_url and shared_lightning_video:
                video_url = shared_lightning_video

            primary_doc_url = slides_url or poster_url
            talks.append(
                {
                    "title": title,
                    "category": category,
                    "speakers": parse_programme_speaker_cell(speaker_html),
                    "abstract": "",
                    "videoUrl": video_url or None,
                    "videoId": parse_video_id(video_url),
                    "slidesUrl": primary_doc_url or None,
                    "posterUrl": poster_url or None,
                }
            )

    return talks


def parse_legacy_section_entries(
    page_html: str,
    meeting_slug: str,
    *,
    section_id: str,
    default_category: str,
    anchor_prefix: str,
) -> list[dict]:
    section_match = re.search(
        rf"<div[^>]*id=['\"]{re.escape(section_id)}['\"][^>]*>",
        page_html,
        flags=re.IGNORECASE,
    )
    if not section_match:
        return []

    section_html = page_html[section_match.end() :]
    next_section = re.search(
        r"<div[^>]*class=['\"]www_sectiontitle['\"][^>]*id=['\"][^'\"]+['\"][^>]*>",
        section_html,
        flags=re.IGNORECASE,
    )
    if next_section:
        section_html = section_html[: next_section.start()]

    anchor_pattern = re.compile(
        rf"<a[^>]+id=['\"](?P<anchor>{re.escape(anchor_prefix)}\d+)['\"][^>]*>(?P<title>.*?)(?:</a>|</b>)",
        flags=re.IGNORECASE | re.DOTALL,
    )
    anchors = list(anchor_pattern.finditer(section_html))
    talks: list[dict] = []

    for index, match in enumerate(anchors):
        block_start = match.start()
        block_end = anchors[index + 1].start() if index + 1 < len(anchors) else len(section_html)
        block_html = section_html[block_start:block_end]

        title = clean_title(strip_html(match.group("title")))
        if not title:
            continue

        speaker_match = re.search(r"<i\b[^>]*>(.*?)</i>", block_html, flags=re.IGNORECASE | re.DOTALL)
        speaker_html = speaker_match.group(1) if speaker_match else ""
        speakers = parse_speakers(strip_html(speaker_html))

        abstract_html = block_html[speaker_match.end() :] if speaker_match else block_html
        abstract = clean_abstract_text(
            collapse_ws(strip_html(abstract_html)),
            title=title,
            speakers=speakers,
        )

        video_url, slides_url = parse_links_from_html(block_html, meeting_slug)
        talks.append(
            {
                "_anchorId": collapse_ws(match.group("anchor")),
                "title": title,
                "category": "keynote" if title.lower().startswith("keynote:") else default_category,
                "speakers": speakers,
                "abstract": abstract,
                "videoUrl": video_url,
                "videoId": parse_video_id(video_url),
                "slidesUrl": slides_url,
            }
        )

    return talks


def parse_legacy_abstract_sections(page_html: str, meeting_slug: str) -> list[dict]:
    return parse_legacy_section_entries(
        page_html,
        meeting_slug,
        section_id="abstracts",
        default_category="technical-talk",
        anchor_prefix="talk",
    )


def parse_legacy_poster_sections(page_html: str, meeting_slug: str) -> list[dict]:
    return parse_legacy_section_entries(
        page_html,
        meeting_slug,
        section_id="poster",
        default_category="poster",
        anchor_prefix="poster",
    )


def merge_parsed_talk_collections(primary: list[dict], secondary: list[dict]) -> list[dict]:
    merged: list[dict] = []
    by_anchor: dict[str, dict] = {}
    by_title: dict[str, dict] = {}

    def register(talk: dict) -> None:
        anchor_id = collapse_ws(str(talk.get("_anchorId", "")))
        title_key = normalize_talk_title_key(str(talk.get("title", "")))
        if anchor_id:
            by_anchor[anchor_id] = talk
        if title_key and title_key not in by_title:
            by_title[title_key] = talk

    for talk in primary:
        candidate = dict(talk)
        merged.append(candidate)
        register(candidate)

    for talk in secondary:
        anchor_id = collapse_ws(str(talk.get("_anchorId", "")))
        title_key = normalize_talk_title_key(str(talk.get("title", "")))
        match = by_anchor.get(anchor_id) if anchor_id else None
        if match is None and title_key:
            match = by_title.get(title_key)

        if match is None:
            candidate = dict(talk)
            merged.append(candidate)
            register(candidate)
            continue

        if talk.get("title") and not match.get("title"):
            match["title"] = talk.get("title")
        if talk.get("category") and (
            not match.get("category")
            or (match.get("category") == "technical-talk" and talk.get("category") != "technical-talk")
        ):
            match["category"] = talk.get("category")
        if talk.get("speakers"):
            match["speakers"] = talk.get("speakers")
        if has_meaningful_abstract(str(talk.get("abstract", ""))):
            match["abstract"] = talk.get("abstract")
        for field in ["videoUrl", "videoId", "slidesUrl"]:
            if not match.get(field) and talk.get(field):
                match[field] = talk.get(field)

    for talk in merged:
        talk.pop("_anchorId", None)
    return merged


AFFILIATIONISH_SPEAKER_TERMS = (
    "apple",
    "cnrs",
    "consultant",
    "deepbluecapital",
    "freebsd",
    "google",
    "innovation center",
    "intel",
    "inria",
    "mozilla",
    "project",
    "qualcomm",
    "quic",
    "university",
)


def normalize_speaker_records(speakers: list[dict] | None) -> list[dict]:
    out: list[dict] = []
    for speaker in speakers or []:
        if not isinstance(speaker, dict):
            continue
        name = collapse_ws(str(speaker.get("name", "")))
        if not name:
            continue
        out.append(
            {
                "name": name,
                "affiliation": collapse_ws(str(speaker.get("affiliation", ""))),
                "github": collapse_ws(str(speaker.get("github", ""))),
                "linkedin": collapse_ws(str(speaker.get("linkedin", ""))),
                "twitter": collapse_ws(str(speaker.get("twitter", ""))),
            }
        )
    return out


def speaker_name_looks_like_affiliation(name: str) -> bool:
    text = collapse_ws(name).lower()
    if not text:
        return False
    if text.startswith("the "):
        return True
    return any(term in text for term in AFFILIATIONISH_SPEAKER_TERMS)


def merge_speaker_records(existing_speakers: list[dict] | None, source_speakers: list[dict]) -> list[dict]:
    existing_by_name = {
        normalize_speaker_name(str(speaker.get("name", ""))): speaker
        for speaker in normalize_speaker_records(existing_speakers)
    }
    out: list[dict] = []
    for source in normalize_speaker_records(source_speakers):
        merged = dict(source)
        existing = existing_by_name.get(normalize_speaker_name(str(source.get("name", ""))))
        if existing:
            for field in ["github", "linkedin", "twitter"]:
                if not merged.get(field) and existing.get(field):
                    merged[field] = existing.get(field)
        out.append(merged)
    return out


def should_refresh_speakers(existing_speakers: list[dict] | None, source_speakers: list[dict] | None) -> bool:
    current = normalize_speaker_records(existing_speakers)
    remote = normalize_speaker_records(source_speakers)
    if not remote:
        return False
    if not current:
        return True

    current_affiliations = sum(1 for speaker in current if has_meaningful_meta_value(str(speaker.get("affiliation", ""))))
    remote_affiliations = sum(1 for speaker in remote if has_meaningful_meta_value(str(speaker.get("affiliation", ""))))
    current_org_like = sum(1 for speaker in current if speaker_name_looks_like_affiliation(str(speaker.get("name", ""))))
    remote_org_like = sum(1 for speaker in remote if speaker_name_looks_like_affiliation(str(speaker.get("name", ""))))
    current_name_keys = {
        normalize_key(str(speaker.get("name", "")))
        for speaker in current
        if normalize_key(str(speaker.get("name", "")))
    }
    remote_affiliation_keys = {
        normalize_key(str(speaker.get("affiliation", "")))
        for speaker in remote
        if normalize_key(str(speaker.get("affiliation", "")))
    }
    affiliation_matches_current_name = any(
        current_key.startswith(aff_key) or aff_key.startswith(current_key)
        for current_key in current_name_keys
        for aff_key in remote_affiliation_keys
    )

    if len(remote) > len(current):
        return True
    if remote_affiliations > current_affiliations:
        return True
    if affiliation_matches_current_name and remote_affiliations > current_affiliations:
        return True
    if current_org_like > remote_org_like:
        return True
    return False


def category_from_heading(heading: str) -> str | None:
    clean = collapse_ws(heading).lower()
    clean = clean.rstrip(":")
    if clean in CATEGORY_MAP:
        return CATEGORY_MAP[clean]
    for label, category in CATEGORY_MAP.items():
        if label in clean:
            return category
    return None


def clean_title(raw: str) -> str:
    title = collapse_ws(raw)
    title = re.sub(r"\s*▲\s*back to schedule.*$", "", title, flags=re.IGNORECASE)
    title = title.replace("&#9650;", "")
    title = collapse_ws(title)
    return title


def parse_video_id(video_url: str | None) -> str | None:
    if not video_url:
        return None
    try:
        parsed = urllib.parse.urlparse(video_url)
    except Exception:
        return None

    host = (parsed.hostname or "").lower().replace("www.", "")
    if host == "youtu.be":
        candidate = parsed.path.lstrip("/").split("/", 1)[0]
        return candidate or None
    if host.endswith("youtube.com"):
        query = urllib.parse.parse_qs(parsed.query or "")
        value = query.get("v", [""])[0].strip()
        return value or None
    return None


def abs_devmtg_url(slug: str, href: str) -> str:
    base = f"https://llvm.org/devmtg/{slug}/"
    resolved = urllib.parse.urljoin(base, href)
    return sanitize_http_url(resolved)


def configure_ssl_context(ca_bundle: str = "", no_verify_ssl: bool = False) -> None:
    global URLLIB_SSL_CONTEXT
    if no_verify_ssl:
        URLLIB_SSL_CONTEXT = ssl._create_unverified_context()
        return

    bundle = collapse_ws(ca_bundle)
    if not bundle:
        try:
            import certifi  # type: ignore

            bundle = collapse_ws(str(certifi.where()))
        except Exception:
            bundle = ""

    if not bundle:
        URLLIB_SSL_CONTEXT = None
        return

    bundle_path = Path(bundle).expanduser().resolve()
    if not bundle_path.exists():
        raise SystemExit(f"CA bundle does not exist: {bundle_path}")
    URLLIB_SSL_CONTEXT = ssl.create_default_context(cafile=str(bundle_path))


def is_certificate_verify_error(exc: urllib.error.URLError) -> bool:
    reason = getattr(exc, "reason", exc)
    text = str(reason or exc).lower()
    return "certificate verify failed" in text


def ssl_help_hint() -> str:
    return (
        "SSL certificate verification failed. "
        "Try one of: "
        "1) python3 -m pip install --user certifi, then rerun with "
        "--ca-bundle \"$(python3 -c 'import certifi; print(certifi.where())')\" "
        "2) pass a local trust store path via --ca-bundle "
        "3) as last resort only, use --no-verify-ssl."
    )


def _http_get(url: str, github_token: str = "") -> str:
    api_url = is_github_api_url(url)
    headers = {
        "User-Agent": "llvm-library-devmtg-sync/1.0",
        "Accept": "application/json" if api_url else "text/html,application/xhtml+xml",
    }
    token = collapse_ws(github_token)
    if token and api_url:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, headers=headers, method="GET")
    open_kwargs = {"timeout": 40}
    if URLLIB_SSL_CONTEXT is not None:
        open_kwargs["context"] = URLLIB_SSL_CONTEXT
    with urllib.request.urlopen(req, **open_kwargs) as resp:
        return resp.read().decode("utf-8", errors="replace")


def list_remote_slugs(
    github_api_base: str,
    repo: str,
    ref: str,
    github_token: str = "",
) -> list[str]:
    url = (
        f"{github_api_base.rstrip('/')}/repos/{repo}/contents/devmtg"
        f"?ref={urllib.parse.quote(ref)}"
    )
    payload = json.loads(_http_get(url, github_token=github_token))
    out: list[str] = []
    for entry in payload:
        if str(entry.get("type", "")) != "dir":
            continue
        name = collapse_ws(str(entry.get("name", "")))
        if re.match(r"^\d{4}-\d{2}(?:-\d{2})?$", name):
            out.append(name)
    return sorted(set(out), reverse=True)


def fetch_latest_path_revision(
    github_api_base: str,
    repo: str,
    ref: str,
    path: str,
    github_token: str = "",
) -> str:
    normalized_path = collapse_ws(path).lstrip("/")
    if not normalized_path:
        return ""
    url = (
        f"{github_api_base.rstrip('/')}/repos/{repo}/commits"
        f"?sha={urllib.parse.quote(ref)}"
        f"&path={urllib.parse.quote(normalized_path)}"
        "&per_page=1"
    )
    payload = json.loads(_http_get(url, github_token=github_token))

    entries: list[dict] = []
    if isinstance(payload, list):
        entries = [entry for entry in payload if isinstance(entry, dict)]
    elif isinstance(payload, dict):
        entries = [payload]

    for entry in entries:
        sha = collapse_ws(str(entry.get("sha", "")))
        if re.fullmatch(r"[0-9a-fA-F]{7,40}", sha):
            return sha
    return ""


def fetch_changed_paths_between_revisions(
    github_api_base: str,
    repo: str,
    base: str,
    head: str,
    github_token: str = "",
) -> list[str]:
    base_sha = collapse_ws(base)
    head_sha = collapse_ws(head)
    if not base_sha or not head_sha or base_sha == head_sha:
        return []

    url = (
        f"{github_api_base.rstrip('/')}/repos/{repo}/compare/"
        f"{urllib.parse.quote(base_sha)}...{urllib.parse.quote(head_sha)}"
    )
    payload = json.loads(_http_get(url, github_token=github_token))
    files = payload.get("files", []) if isinstance(payload, dict) else []

    out: list[str] = []
    for entry in files:
        if not isinstance(entry, dict):
            continue
        filename = collapse_ws(str(entry.get("filename", "")))
        if filename:
            out.append(filename)
    return out


def extract_devmtg_slug_from_path(path: str) -> str | None:
    match = re.match(r"^devmtg/(\d{4}-\d{2}(?:-\d{2})?)(?:/|$)", collapse_ws(path).lstrip("/"))
    if not match:
        return None
    return match.group(1)


def derive_changed_devmtg_slugs(paths: list[str]) -> set[str]:
    out: set[str] = set()
    for path in paths:
        slug = extract_devmtg_slug_from_path(path)
        if slug:
            out.add(slug)
    return out


def list_existing_event_slugs(events_dir: Path) -> set[str]:
    out: set[str] = set()
    for path in events_dir.glob("*.json"):
        if path.stem == "index":
            continue
        if re.fullmatch(r"\d{4}-\d{2}(?:-\d{2})?", path.stem):
            out.add(path.stem)
    return out


def select_remote_slugs_for_sync(
    remote_slugs: list[str],
    existing_event_slugs: set[str],
    changed_upstream_slugs: set[str],
    *,
    force: bool = False,
) -> list[str]:
    if force:
        return list(remote_slugs)
    return [
        slug
        for slug in remote_slugs
        if slug not in existing_event_slugs or slug in changed_upstream_slugs
    ]


def extract_meeting_name(page_html: str, slug: str) -> str:
    h1_match = re.search(r"<h1[^>]*>(.*?)</h1>", page_html, flags=re.IGNORECASE | re.DOTALL)
    if h1_match:
        value = clean_title(strip_html(h1_match.group(1)))
        if value:
            return value

    section_match = re.search(
        r'<div[^>]*class="www_sectiontitle"[^>]*>(.*?)</div>',
        page_html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if section_match:
        value = clean_title(strip_html(section_match.group(1)))
        if value:
            return value

    return slug


def extract_labeled_value(page_html: str, labels: list[str]) -> str:
    for label in labels:
        pattern = re.compile(
            rf"<li[^>]*>\s*<b[^>]*>\s*{re.escape(label)}\s*:?\s*</b>\s*:?\s*(.*?)</li>",
            flags=re.IGNORECASE | re.DOTALL,
        )
        match = pattern.search(page_html)
        if not match:
            continue
        value = collapse_ws(strip_html(match.group(1)))
        if value:
            return value
    return ""


def load_index_meeting_hints(repo: str, ref: str, github_token: str = "") -> dict[str, dict[str, str]]:
    """Parse canonical date/location hints from llvm-www/devmtg/index.html."""
    raw_url = f"https://raw.githubusercontent.com/{repo}/{ref}/devmtg/index.html"
    page_html = _http_get(raw_url, github_token=github_token)

    hints: dict[str, dict[str, str]] = {}
    li_pattern = re.compile(r"<li[^>]*>(.*?)</li>", flags=re.IGNORECASE | re.DOTALL)
    link_pattern = re.compile(
        r"<a[^>]+href=['\"](?P<href>\d{4}-\d{2}(?:-\d{2})?/?)['\"][^>]*>(?P<date>.*?)</a>(?P<rest>.*)",
        flags=re.IGNORECASE | re.DOTALL,
    )

    for li_html in li_pattern.findall(page_html):
        match = link_pattern.search(li_html)
        if not match:
            continue

        slug = collapse_ws(match.group("href")).rstrip("/")
        date_text = collapse_ws(strip_html(match.group("date")))
        rest_text = collapse_ws(strip_html(match.group("rest")))
        if not slug:
            continue

        location = ""
        if "-" in rest_text:
            location = collapse_ws(rest_text.split("-", 1)[1])
        elif rest_text:
            location = rest_text
        location = re.sub(r"\s*-\s*Canceled\s*$", "", location, flags=re.IGNORECASE).strip()

        hints[slug] = {
            "date": date_text,
            "location": location,
        }

    return hints


def parse_links_from_html(fragment: str, meeting_slug: str) -> tuple[str | None, str | None]:
    video_url: str | None = None
    slides_url: str | None = None

    for href, label in extract_anchor_links(fragment):
        text = collapse_ws(strip_html(label)).lower()
        url = abs_devmtg_url(meeting_slug, href)
        if not url:
            continue

        if "video" in text and not video_url:
            video_url = url
        if "slide" in text and not slides_url:
            slides_url = url

    return video_url, slides_url


def parse_session_entries(page_html: str, meeting_slug: str) -> list[dict]:
    current_category = "technical-talk"
    talks: list[dict] = []

    token_re = re.compile(
        r"(?P<heading><p>\s*<b>[^<]+</b>\s*</p>)|"
        r"(?P<section><div[^>]*class=\"www_sectiontitle\"[^>]*>.*?</div>)|"
        r"(?P<session><div\s+class=\"session-entry\">.*?</div>)",
        flags=re.IGNORECASE | re.DOTALL,
    )

    for token in token_re.finditer(page_html):
        heading_html = token.group("heading") or token.group("section")
        if heading_html:
            maybe_category = category_from_heading(strip_html(heading_html))
            if maybe_category:
                current_category = maybe_category
            continue

        block = token.group("session")
        if not block:
            continue

        title_match = re.search(r"<i>(.*?)</i>", block, flags=re.IGNORECASE | re.DOTALL)
        if not title_match:
            continue
        title = clean_title(strip_html(title_match.group(1)))
        if not title:
            continue

        category = current_category
        if title.lower().startswith("keynote:"):
            category = "keynote"
            title = collapse_ws(title.split(":", 1)[1])

        video_url, slides_url = parse_links_from_html(block, meeting_slug)
        video_id = parse_video_id(video_url)

        speaker_match = re.search(
            r"(?:Speakers?|Presenters?)\s*:\s*(.*?)<br",
            block,
            flags=re.IGNORECASE | re.DOTALL,
        )
        speakers = parse_speakers(strip_html(speaker_match.group(1)) if speaker_match else "")

        abstract = ""
        paragraph_candidates = re.findall(r"<p[^>]*>(.*?)</p>", block, flags=re.IGNORECASE | re.DOTALL)
        for paragraph in paragraph_candidates:
            text = clean_abstract_text(
                collapse_ws(strip_html(paragraph)),
                title=title,
                speakers=speakers,
            )
            if not text:
                continue
            if re.match(r"^(?:Speakers?|Presenters?)\s*:", text, flags=re.IGNORECASE):
                continue
            if normalize_key(text) == normalize_key(title):
                continue
            if len(text) > len(abstract):
                abstract = text

        talks.append(
            {
                "title": title,
                "category": category,
                "speakers": speakers,
                "abstract": abstract,
                "videoUrl": video_url,
                "videoId": video_id,
                "slidesUrl": slides_url,
            }
        )

    return talks


def parse_abstract_sections(page_html: str, meeting_slug: str) -> list[dict]:
    talks: list[dict] = []
    pattern = re.compile(
        r"<h3[^>]*id=['\"]([^'\"]+)['\"][^>]*>(.*?)</h3>\s*<h4[^>]*>(.*?)</h4>\s*<p[^>]*>(.*?)</p>",
        flags=re.IGNORECASE | re.DOTALL,
    )

    for _, title_html, speaker_html, abstract_html in pattern.findall(page_html):
        raw_title_text = clean_title(strip_html(title_html))
        if not raw_title_text:
            continue

        lower_title = raw_title_text.lower()
        if "call for speakers" in lower_title:
            continue
        if "program committee" in lower_title:
            continue

        category = "technical-talk"
        title_text = raw_title_text
        if lower_title.startswith("keynote:"):
            category = "keynote"
            title_text = collapse_ws(raw_title_text.split(":", 1)[1])

        video_url, slides_url = parse_links_from_html(title_html, meeting_slug)
        video_id = parse_video_id(video_url)
        speakers = parse_speakers(strip_html(speaker_html))
        abstract = clean_abstract_text(
            collapse_ws(strip_html(abstract_html)),
            title=title_text,
            speakers=speakers,
        )

        talks.append(
            {
                "title": title_text,
                "category": category,
                "speakers": speakers,
                "abstract": abstract,
                "videoUrl": video_url,
                "videoId": video_id,
                "slidesUrl": slides_url,
            }
        )

    return talks


def dedupe_parsed_talks(talks: list[dict]) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for talk in talks:
        title_key = normalize_talk_title_key(str(talk.get("title", "")))
        speaker_key = ",".join(
            normalize_speaker_name(str(s.get("name", "")))
            for s in (talk.get("speakers") or [])
            if normalize_speaker_name(str(s.get("name", "")))
        )
        key = f"{title_key}|{speaker_key}"
        if not title_key or key in seen:
            continue
        seen.add(key)
        out.append(talk)
    return out


def parse_meeting_page(page_html: str, slug: str) -> tuple[dict, list[dict]]:
    canceled = bool(re.search(r"\bcance(?:lled|led|llation|lation)\b", page_html, flags=re.IGNORECASE))
    meeting = {
        "slug": slug,
        "name": extract_meeting_name(page_html, slug),
        "date": extract_labeled_value(page_html, ["Conference Date", "When", "Date"]),
        "location": extract_labeled_value(page_html, ["Location", "Where"]),
        "canceled": canceled,
        "talkCount": 0,
    }

    talks = merge_parsed_talk_collections(
        parse_session_entries(page_html, slug),
        parse_abstract_sections(page_html, slug),
    )
    if not talks:
        talks = parse_programme_tables(page_html, slug)
    if not talks:
        talks = merge_parsed_talk_collections(
            parse_legacy_table_entries(page_html, slug),
            parse_legacy_abstract_sections(page_html, slug),
        )
        talks = merge_parsed_talk_collections(
            talks,
            parse_legacy_poster_sections(page_html, slug),
        )

    talks = dedupe_parsed_talks(talks)
    meeting["talkCount"] = len(talks)
    return meeting, talks


def extract_talk_match_key(talk: dict) -> tuple[str, str]:
    title_key = normalize_talk_title_key(str(talk.get("title", "")))
    speaker_key = ",".join(
        normalize_speaker_name(str(speaker.get("name", "")))
        for speaker in (talk.get("speakers") or [])
        if normalize_speaker_name(str(speaker.get("name", "")))
    )
    return title_key, speaker_key


def next_talk_id(existing_talks: list[dict], slug: str, used_ids: set[str]) -> str:
    pattern = re.compile(rf"^{re.escape(slug)}-(\d+)$")
    used_numbers: set[int] = set()
    for talk in existing_talks:
        talk_id = collapse_ws(str(talk.get("id", "")))
        match = pattern.match(talk_id)
        if match:
            used_numbers.add(int(match.group(1)))

    candidate_num = 1
    while True:
        while candidate_num in used_numbers:
            candidate_num += 1
        candidate = f"{slug}-{candidate_num:03d}"
        if candidate not in used_ids:
            used_ids.add(candidate)
            return candidate
        candidate_num += 1


def merge_meeting_talks(
    slug: str,
    meeting_meta: dict,
    remote_talks: list[dict],
    existing_payload: dict | None,
    index_hint: dict[str, str] | None = None,
) -> tuple[dict, bool, int]:
    existing_talks = list((existing_payload or {}).get("talks") or [])
    changed = False
    new_count = 0

    existing_meeting = dict((existing_payload or {}).get("meeting") or {})
    exemplar_talk = existing_talks[0] if existing_talks else {}

    preferred_meeting_name = pick_preferred_meta_value(
        existing_meeting.get("name", ""),
        exemplar_talk.get("meetingName", ""),
        meeting_meta.get("name", ""),
        slug,
    )
    preferred_meeting_location = pick_preferred_meta_value(
        existing_meeting.get("location", ""),
        exemplar_talk.get("meetingLocation", ""),
        (index_hint or {}).get("location", ""),
        meeting_meta.get("location", ""),
    )
    preferred_meeting_date = pick_preferred_meta_value(
        existing_meeting.get("date", ""),
        exemplar_talk.get("meetingDate", ""),
        (index_hint or {}).get("date", ""),
        meeting_meta.get("date", ""),
    )

    def _promote_index_hint_if_raw_overwrite(current_value: str, upstream_value: str, hint_value: str) -> str:
        current_norm = normalize_meta_value(current_value)
        upstream_norm = normalize_meta_value(upstream_value)
        hint_norm = normalize_meta_value(hint_value)
        if current_norm and upstream_norm and hint_norm:
            if current_norm == upstream_norm and current_norm != hint_norm:
                return hint_value
        return current_value

    if index_hint:
        preferred_meeting_date = _promote_index_hint_if_raw_overwrite(
            preferred_meeting_date,
            collapse_ws(str(meeting_meta.get("date", ""))),
            collapse_ws(str(index_hint.get("date", ""))),
        ) or preferred_meeting_date
        preferred_meeting_location = _promote_index_hint_if_raw_overwrite(
            preferred_meeting_location,
            collapse_ws(str(meeting_meta.get("location", ""))),
            collapse_ws(str(index_hint.get("location", ""))),
        ) or preferred_meeting_location

    by_composite: dict[tuple[str, str], list[dict]] = {}
    by_title: dict[str, list[dict]] = {}
    used_ids: set[str] = set()
    for talk in existing_talks:
        talk_id = collapse_ws(str(talk.get("id", "")))
        if talk_id:
            used_ids.add(talk_id)
        title_key, speaker_key = extract_talk_match_key(talk)
        if title_key:
            by_title.setdefault(title_key, []).append(talk)
            by_composite.setdefault((title_key, speaker_key), []).append(talk)

    for remote in remote_talks:
        title_key, speaker_key = extract_talk_match_key(remote)
        match: dict | None = None

        if title_key:
            composite_hits = by_composite.get((title_key, speaker_key), [])
            if len(composite_hits) == 1:
                match = composite_hits[0]
            elif len(composite_hits) > 1:
                match = composite_hits[0]
            else:
                title_hits = by_title.get(title_key, [])
                if len(title_hits) == 1:
                    match = title_hits[0]

        if match is None:
            talk_id = next_talk_id(existing_talks, slug, used_ids)
            match = {
                "id": talk_id,
                "meeting": slug,
                "meetingName": preferred_meeting_name,
                "meetingLocation": preferred_meeting_location,
                "meetingDate": preferred_meeting_date,
                "category": remote.get("category") or "technical-talk",
                "title": remote.get("title") or "",
                "speakers": remote.get("speakers") or [],
                "abstract": remote.get("abstract") or "",
                "videoUrl": remote.get("videoUrl"),
                "videoId": remote.get("videoId"),
                "slidesUrl": remote.get("slidesUrl"),
                "posterUrl": remote.get("posterUrl"),
                "projectGithub": "",
                "tags": [],
            }
            existing_talks.append(match)
            by_title.setdefault(title_key, []).append(match)
            by_composite.setdefault((title_key, speaker_key), []).append(match)
            changed = True
            new_count += 1
            continue

    if existing_meeting:
        meeting_payload = existing_meeting
    else:
        meeting_payload = {
            "slug": slug,
            "name": preferred_meeting_name,
            "date": preferred_meeting_date,
            "location": preferred_meeting_location,
            "canceled": bool(meeting_meta.get("canceled", False)),
            "talkCount": len(existing_talks),
        }
        changed = True

    if meeting_payload.get("talkCount") != len(existing_talks) and (new_count > 0 or not existing_meeting):
        meeting_payload["talkCount"] = len(existing_talks)
        changed = True

    payload = {
        "meeting": meeting_payload,
        "talks": existing_talks,
    }
    return payload, changed, new_count


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--events-dir", default=str(repo_root / "devmtg/events"))
    parser.add_argument("--manifest", default=str(repo_root / "devmtg/events/index.json"))
    parser.add_argument("--repo", default=LLVM_WWW_REPO, help="GitHub repo in owner/name form")
    parser.add_argument("--ref", default=LLVM_WWW_REF, help="Git ref for llvm-www")
    parser.add_argument("--github-api-base", default=GITHUB_API_BASE)
    parser.add_argument("--github-token", default=os.environ.get("GITHUB_TOKEN", ""))
    parser.add_argument("--ca-bundle", default=os.environ.get("SSL_CERT_FILE", ""))
    parser.add_argument("--no-verify-ssl", action="store_true", help="Disable TLS certificate verification")
    parser.add_argument("--only-slug", action="append", help="Optional meeting slug filter (repeatable)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    configure_ssl_context(ca_bundle=args.ca_bundle, no_verify_ssl=args.no_verify_ssl)

    events_dir = Path(args.events_dir).resolve()
    manifest_path = Path(args.manifest).resolve()
    events_dir.mkdir(parents=True, exist_ok=True)

    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        manifest = {"dataVersion": "", "eventFiles": []}

    manifest_files = [collapse_ws(str(item)) for item in manifest.get("eventFiles", []) if collapse_ws(str(item))]
    manifest_set = set(manifest_files)
    existing_source_repo = collapse_ws(str(manifest.get("sourceRepo", "")))
    existing_source_ref = collapse_ws(str(manifest.get("sourceRef", "")))
    existing_source_revision = collapse_ws(str(manifest.get("sourceRevision", "")))

    latest_source_revision = ""
    if not args.only_slug:
        try:
            latest_source_revision = fetch_latest_path_revision(
                github_api_base=args.github_api_base,
                repo=args.repo,
                ref=args.ref,
                path="devmtg",
                github_token=args.github_token,
            )
        except urllib.error.HTTPError as exc:
            if args.verbose:
                print(f"[warn] Could not resolve llvm-www/devmtg revision (HTTP {exc.code}); continuing.", flush=True)
        except urllib.error.URLError as exc:
            if args.verbose:
                print(f"[warn] Could not resolve llvm-www/devmtg revision ({exc}); continuing.", flush=True)

    source_meta_changed = False
    if existing_source_repo != args.repo:
        manifest["sourceRepo"] = args.repo
        source_meta_changed = True
    if existing_source_ref != args.ref:
        manifest["sourceRef"] = args.ref
        source_meta_changed = True

    if (
        not args.only_slug
        and latest_source_revision
        and existing_source_revision
        and latest_source_revision == existing_source_revision
    ):
        if source_meta_changed and not args.dry_run:
            manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"No devmtg updates detected (sourceRevision={latest_source_revision[:12]}).")
        return 0

    index_hints: dict[str, dict[str, str]] = {}
    try:
        index_hints = load_index_meeting_hints(
            repo=args.repo,
            ref=args.ref,
            github_token=args.github_token,
        )
    except urllib.error.HTTPError as exc:
        if args.verbose:
            print(f"[warn] Could not fetch devmtg index hints (HTTP {exc.code}); continuing.", flush=True)
    except urllib.error.URLError as exc:
        if args.verbose:
            print(f"[warn] Could not fetch devmtg index hints ({exc}); continuing.", flush=True)

    try:
        remote_slugs = list_remote_slugs(
            github_api_base=args.github_api_base,
            repo=args.repo,
            ref=args.ref,
            github_token=args.github_token,
        )
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"Failed to list llvm-www/devmtg directories: HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        if is_certificate_verify_error(exc):
            raise SystemExit(ssl_help_hint()) from exc
        raise SystemExit(f"Failed to list llvm-www/devmtg directories: {exc}") from exc

    if args.only_slug:
        allowed = {collapse_ws(slug) for slug in args.only_slug if collapse_ws(slug)}
        remote_slugs = [slug for slug in remote_slugs if slug in allowed]

    existing_event_slugs = list_existing_event_slugs(events_dir)
    changed_upstream_slugs: set[str] = set()
    compared_revisions = False
    if not args.only_slug and latest_source_revision and existing_source_revision and latest_source_revision != existing_source_revision:
        try:
            changed_paths = fetch_changed_paths_between_revisions(
                github_api_base=args.github_api_base,
                repo=args.repo,
                base=existing_source_revision,
                head=latest_source_revision,
                github_token=args.github_token,
            )
            changed_upstream_slugs = derive_changed_devmtg_slugs(changed_paths)
            compared_revisions = True
        except urllib.error.HTTPError as exc:
            if args.verbose:
                print(
                    f"[warn] Could not compare devmtg revisions (HTTP {exc.code}); "
                    "syncing only brand-new meeting files and keeping sourceRevision unchanged.",
                    flush=True,
                )
        except urllib.error.URLError as exc:
            if args.verbose:
                print(
                    f"[warn] Could not compare devmtg revisions ({exc}); "
                    "syncing only brand-new meeting files and keeping sourceRevision unchanged.",
                    flush=True,
                )

    remote_slugs = select_remote_slugs_for_sync(
        remote_slugs,
        existing_event_slugs,
        changed_upstream_slugs,
        force=bool(args.only_slug),
    )

    changed_slugs: list[str] = []
    created_slugs: list[str] = []
    discovered_new_talks = 0

    for slug in remote_slugs:
        raw_url = f"https://raw.githubusercontent.com/{args.repo}/{args.ref}/devmtg/{slug}/index.html"
        try:
            page_html = _http_get(raw_url, github_token=args.github_token)
        except urllib.error.HTTPError as exc:
            if args.verbose:
                print(f"[skip] {slug}: HTTP {exc.code} while fetching {raw_url}", flush=True)
            continue
        except urllib.error.URLError as exc:
            if args.verbose and is_certificate_verify_error(exc):
                print(f"[warn] {ssl_help_hint()}", flush=True)
            if args.verbose:
                print(f"[skip] {slug}: network error while fetching {raw_url}: {exc}", flush=True)
            continue

        event_filename = f"{slug}.json"
        event_path = events_dir / event_filename
        existing_payload = None
        if event_path.exists():
            existing_payload = json.loads(event_path.read_text(encoding="utf-8"))

        meeting_meta, remote_talks = parse_meeting_page(page_html, slug)
        if not remote_talks and not existing_payload:
            if args.verbose:
                print(f"[skip] {slug}: no parseable talks found", flush=True)
            continue

        merged_payload, changed, new_count = merge_meeting_talks(
            slug=slug,
            meeting_meta=meeting_meta,
            remote_talks=remote_talks,
            existing_payload=existing_payload,
            index_hint=index_hints.get(slug),
        )
        if not changed:
            continue

        changed_slugs.append(slug)
        discovered_new_talks += new_count
        if not event_path.exists():
            created_slugs.append(slug)

        if not args.dry_run:
            event_path.write_text(json.dumps(merged_payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

        manifest_set.add(event_filename)
        if args.verbose:
            if not remote_talks:
                print(f"[update-meta] {slug}: metadata refreshed using index hints", flush=True)
            print(
                f"[update] {slug}: talks={len(merged_payload.get('talks', []))} new={new_count}",
                flush=True,
            )

    if not changed_slugs:
        if (
            not args.only_slug
            and latest_source_revision
            and (
                latest_source_revision == existing_source_revision
                or compared_revisions
                or not existing_source_revision
            )
            and existing_source_revision != latest_source_revision
        ):
            manifest["sourceRevision"] = latest_source_revision
            source_meta_changed = True
        if source_meta_changed and not args.dry_run:
            manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"No devmtg content updates detected; refreshed source metadata ({manifest_path}).")
        else:
            print("No devmtg updates detected.")
        return 0

    next_event_files = sorted(manifest_set, reverse=True)
    next_data_version = _dt.date.today().isoformat() + "-auto-sync-devmtg"
    if (
        not args.only_slug
        and latest_source_revision
        and (
            latest_source_revision == existing_source_revision
            or compared_revisions
            or not existing_source_revision
        )
        and existing_source_revision != latest_source_revision
    ):
        manifest["sourceRevision"] = latest_source_revision
        source_meta_changed = True
    manifest_changed = (
        manifest.get("eventFiles", []) != next_event_files
        or collapse_ws(str(manifest.get("dataVersion", ""))) != next_data_version
        or source_meta_changed
    )
    manifest["eventFiles"] = next_event_files
    manifest["dataVersion"] = next_data_version

    if manifest_changed and not args.dry_run:
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(
        "Updated devmtg bundles: "
        f"{len(changed_slugs)} meetings, "
        f"{discovered_new_talks} newly discovered talks."
    )
    if created_slugs:
        print(f"Created new meeting files: {', '.join(created_slugs)}")
    print(f"Updated manifest: {manifest_path} (dataVersion={manifest['dataVersion']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
