#!/usr/bin/env python3
"""Sync MLIR subproject talks and publications into local JSON artifacts."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path


USER_AGENT = "llvm-library-mlir-sync/1.0"
MLIR_SITE_BASE = "https://mlir.llvm.org/"
DEFAULT_TALKS_SOURCE = "https://raw.githubusercontent.com/llvm/mlir-www/main/website/content/talks/_index.md"
DEFAULT_PUBS_SOURCE = "https://raw.githubusercontent.com/llvm/mlir-www/main/website/content/pubs/_index.md"


def collapse_ws(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def slugify(value: str) -> str:
    return re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9]+", "-", collapse_ws(value).lower())).strip("-")


def normalize_url(value: str, base_url: str = MLIR_SITE_BASE) -> str:
    raw = collapse_ws(value)
    if not raw:
        return ""
    return urllib.parse.urljoin(base_url, raw)


def fetch_text(url: str, timeout: float) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8")


def load_text(source: str, timeout: float) -> str:
    raw = collapse_ws(source)
    if not raw:
        return ""
    if raw.startswith(("http://", "https://")):
        return fetch_text(raw, timeout)
    return Path(raw).read_text(encoding="utf-8")


def strip_front_matter(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    if normalized.startswith("---\n"):
        end = normalized.find("\n---\n", 4)
        if end != -1:
            return normalized[end + 5 :]
    return normalized


def markdown_to_plain(value: str) -> str:
    text = value.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"[*_]{1,3}", "", text)
    text = text.replace("\\@", "@")
    return collapse_ws(text)


def extract_links(value: str) -> list[dict]:
    links: list[dict] = []
    for match in re.finditer(r"\[([^\]]+)\]\(([^)]+)\)", value):
        label = collapse_ws(match.group(1))
        url = normalize_url(match.group(2))
        if not label or not url:
            continue
        links.append({"label": label, "url": url})
    return links


def strip_title_prefix(text: str, title: str) -> str:
    plain = collapse_ws(text)
    head = collapse_ws(title)
    if not plain or not head:
        return plain
    if plain.startswith(head):
        return plain[len(head) :].lstrip(" ;,-:")
    return plain


def infer_talk_title(plain_text: str, links: list[dict]) -> str:
    working = plain_text
    if " @ " in working:
        working = working.rsplit(" @ ", 1)[0]
    split_match = re.search(r"\s(?:;|-)\s", working)
    title = working[: split_match.start()].strip() if split_match else working.strip()
    if len(title) >= 8:
        return title

    resourceish = {
        "slides",
        "recording",
        "recording 1",
        "recording 2",
        "slides 1",
        "slides 2",
        "transcript",
        "additional slides",
        "faq",
        "arxiv",
    }
    for link in links:
        label = collapse_ws(link.get("label", ""))
        if not label or collapse_ws(label).lower() in resourceish:
            continue
        if len(label) >= 8:
            return label
    return title or plain_text


def infer_publication_title(plain_text: str, links: list[dict]) -> str:
    if links:
        label = collapse_ws(links[0].get("label", ""))
        if label:
            return label
    split_match = re.search(r"\s-\s", plain_text)
    return (plain_text[: split_match.start()] if split_match else plain_text).strip()


def classify_talk_action(label: str, url: str, *, role_hint: str = "") -> tuple[str, str]:
    normalized = collapse_ws(label).lower()
    url_lower = collapse_ws(url).lower()

    if role_hint == "primary":
        return "primary", "Talk"
    if role_hint == "event":
        return "event", "Event"
    if "transcript" in normalized:
        return "transcript", "Transcript"
    if "recording" in normalized or "video" in normalized or "youtu" in url_lower:
        suffix = ""
        number_match = re.search(r"\b([12])\b", normalized)
        if number_match:
            suffix = f" {number_match.group(1)}"
        return "recording", f"Recording{suffix}"
    if "slide" in normalized or url_lower.endswith(".pdf"):
        number_match = re.search(r"\b([12])\b", normalized)
        if number_match:
            return "slides", f"Slides {number_match.group(1)}"
        if "additional" in normalized:
            return "slides", "Additional Slides"
        return "slides", "Slides"
    return "link", label or "Link"


def classify_publication_action(label: str, *, role_hint: str = "") -> tuple[str, str]:
    normalized = collapse_ws(label).lower()
    if role_hint == "primary":
        return "primary", "Paper"
    if normalized == "arxiv":
        return "preprint", "arXiv"
    if normalized == "faq":
        return "faq", "FAQ"
    if "doi" in normalized:
        return "doi", "DOI"
    return "link", label or "Link"


def dedupe_actions(actions: list[dict]) -> list[dict]:
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for action in actions:
        key = (collapse_ws(action.get("label", "")).lower(), collapse_ws(action.get("url", "")))
        if not key[0] or not key[1] or key in seen:
            continue
        seen.add(key)
        out.append(action)
    return out


def parse_talk_entry(raw_markdown: str) -> dict:
    plain = markdown_to_plain(raw_markdown)
    links = extract_links(raw_markdown)
    title = infer_talk_title(plain, links)
    summary = strip_title_prefix(plain, title)

    event_text = ""
    if " @ " in plain:
        event_text = collapse_ws(plain.rsplit(" @ ", 1)[1]).rstrip(".")

    actions: list[dict] = []
    primary_used = False
    event_used = False
    for link in links:
        label = link["label"]
        role_hint = ""
        normalized_label = collapse_ws(label)
        if not primary_used and normalized_label and title and collapse_ws(title).lower() == normalized_label.lower():
            role_hint = "primary"
            primary_used = True
        elif not event_used and event_text and normalized_label and (
            normalized_label.lower() in event_text.lower() or event_text.lower() in normalized_label.lower()
        ):
            role_hint = "event"
            event_used = True

        kind, action_label = classify_talk_action(label, link["url"], role_hint=role_hint)
        actions.append({"kind": kind, "label": action_label, "url": link["url"]})

    return {
        "title": title,
        "summary": summary or plain,
        "text": plain,
        "actions": dedupe_actions(actions),
    }


def parse_publication_entry(raw_markdown: str) -> dict:
    plain = markdown_to_plain(raw_markdown)
    links = extract_links(raw_markdown)
    title = infer_publication_title(plain, links)
    summary = strip_title_prefix(plain, title)

    actions: list[dict] = []
    primary_used = False
    for link in links:
        role_hint = ""
        label = collapse_ws(link["label"])
        if not primary_used and label and title and label.lower() == collapse_ws(title).lower():
            role_hint = "primary"
            primary_used = True
        kind, action_label = classify_publication_action(label, role_hint=role_hint)
        actions.append({"kind": kind, "label": action_label, "url": link["url"]})

    return {
        "title": title,
        "summary": summary or plain,
        "text": plain,
        "actions": dedupe_actions(actions),
    }


def ensure_group(section: dict, title: str) -> dict:
    group = {
        "id": slugify(title) or f"group-{len(section['groups']) + 1}",
        "title": title,
        "descriptions": [],
        "entries": [],
    }
    section["groups"].append(group)
    return group


def parse_markdown_page(text: str, *, page_kind: str) -> list[dict]:
    content = strip_front_matter(text)
    lines = content.split("\n")
    sections: list[dict] = []
    current_section: dict | None = None
    current_group: dict | None = None
    paragraph_buffer: list[str] = []
    item_buffer: list[str] = []

    def target_container() -> dict | None:
        nonlocal current_section, current_group
        if current_group is not None:
            return current_group
        if current_section is None:
            return None
        return ensure_group(current_section, "")

    def flush_paragraph() -> None:
        nonlocal paragraph_buffer
        paragraph = collapse_ws(" ".join(paragraph_buffer))
        if paragraph:
            target = current_group or current_section
            if target is not None:
                target.setdefault("descriptions", []).append(paragraph)
        paragraph_buffer = []

    def flush_item() -> None:
        nonlocal item_buffer
        raw = "\n".join(item_buffer).strip()
        if not raw:
            item_buffer = []
            return
        container = target_container()
        if container is None:
            item_buffer = []
            return
        entry = parse_talk_entry(raw) if page_kind == "talks" else parse_publication_entry(raw)
        container["entries"].append(entry)
        item_buffer = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            flush_item()
            flush_paragraph()
            continue

        if stripped.startswith("## "):
            flush_item()
            flush_paragraph()
            current_section = {
                "id": slugify(stripped[3:]),
                "title": collapse_ws(stripped[3:]),
                "descriptions": [],
                "groups": [],
            }
            sections.append(current_section)
            current_group = None
            continue

        if stripped.startswith("### "):
            flush_item()
            flush_paragraph()
            if current_section is None:
                continue
            current_group = ensure_group(current_section, collapse_ws(stripped[4:]))
            continue

        if stripped.startswith("* "):
            flush_item()
            flush_paragraph()
            item_buffer = [stripped[2:]]
            continue

        if item_buffer:
            item_buffer.append(stripped)
            continue

        paragraph_buffer.append(stripped)

    flush_item()
    flush_paragraph()
    return sections


def assign_entry_ids(sections: list[dict], *, prefix: str) -> None:
    seen: dict[str, int] = {}
    for section in sections:
        for group in section.get("groups", []):
            for entry in group.get("entries", []):
                base = slugify(entry.get("title", "")) or "entry"
                counter = seen.get(base, 0) + 1
                seen[base] = counter
                suffix = f"-{counter}" if counter > 1 else ""
                entry["id"] = f"{prefix}-{base}{suffix}"


def build_payload(*, title: str, source_url: str, sections: list[dict]) -> dict:
    timestamp = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return {
        "dataVersion": f"{dt.date.today().isoformat()}-{slugify(title)}",
        "generatedAt": timestamp,
        "title": title,
        "sourceUrl": source_url,
        "sections": sections,
    }


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--talks-source", default=DEFAULT_TALKS_SOURCE)
    parser.add_argument("--pubs-source", default=DEFAULT_PUBS_SOURCE)
    parser.add_argument("--talks-output", default="sub-projects/mlir/data/talks.json")
    parser.add_argument("--pubs-output", default="sub-projects/mlir/data/publications.json")
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    talks_source = collapse_ws(args.talks_source)
    pubs_source = collapse_ws(args.pubs_source)

    talks_text = load_text(talks_source, args.timeout)
    pubs_text = load_text(pubs_source, args.timeout)

    talk_sections = parse_markdown_page(talks_text, page_kind="talks")
    pub_sections = parse_markdown_page(pubs_text, page_kind="publications")
    assign_entry_ids(talk_sections, prefix="mlir-talk")
    assign_entry_ids(pub_sections, prefix="mlir-pub")

    talks_payload = build_payload(title="MLIR Talks", source_url=talks_source, sections=talk_sections)
    pubs_payload = build_payload(title="MLIR Related Publications", source_url=pubs_source, sections=pub_sections)

    talks_output = (repo_root / args.talks_output).resolve()
    pubs_output = (repo_root / args.pubs_output).resolve()
    write_json(talks_output, talks_payload)
    write_json(pubs_output, pubs_payload)

    talk_entry_count = sum(len(group.get("entries", [])) for section in talk_sections for group in section.get("groups", []))
    pub_entry_count = sum(len(group.get("entries", [])) for section in pub_sections for group in section.get("groups", []))
    print(f"wrote {talks_output} ({talk_entry_count} entries)", file=sys.stderr)
    print(f"wrote {pubs_output} ({pub_entry_count} entries)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
