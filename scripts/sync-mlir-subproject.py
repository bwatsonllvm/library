#!/usr/bin/env python3
"""Sync MLIR subproject talks and publications into local JSON artifacts."""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import logging
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path


USER_AGENT = "llvm-library-mlir-sync/1.0"
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/135.0.0.0 Safari/537.36"
)
MLIR_SITE_BASE = "https://mlir.llvm.org/"
TALKS_PAGE_URL = urllib.parse.urljoin(MLIR_SITE_BASE, "talks/")
PUBS_PAGE_URL = urllib.parse.urljoin(MLIR_SITE_BASE, "pubs/")
DEFAULT_TALKS_SOURCE = "https://raw.githubusercontent.com/llvm/mlir-www/main/website/content/talks/_index.md"
DEFAULT_PUBS_SOURCE = "https://raw.githubusercontent.com/llvm/mlir-www/main/website/content/pubs/_index.md"
DEFAULT_YOUTUBE_CACHE = "sub-projects/mlir/data/youtube-abstracts.json"
EXCLUDED_TALK_SECTION_IDS = {
    "upcoming-talks-or-presentations",
    "past-conferences-and-workshops",
}
RESOURCE_LINE_RE = re.compile(
    r"^(?:slides?|recordings?|recording|event|agenda|calendar|forums?|discussion|register|playlist|chapter|chapters|timestamps?)\s*:",
    re.IGNORECASE,
)
GENERIC_DESCRIPTION_RE = re.compile(
    r"\b(?:more tech talks on #mlir|subscribe|follow us|playlist|click here|watch more|coming soon|discuss on llvm forums|videos filmed|edited by|bash films|twitter|facebook|instagram|linkedin|join us|oreilly)\b",
    re.IGNORECASE,
)
RESOURCE_TOKEN_RE = re.compile(
    r"\b(?:slides?|recordings?|recording|transcript|event|events|talk|talks|part\s+\d+|additional slides?)\b",
    re.IGNORECASE,
)
SPEAKER_PREFIX_RE = re.compile(
    r"^(?:speakers?|speaker|presenter|presented by|guest(?: speaker)?|host|fullname)\s*[:;-]?\s*",
    re.IGNORECASE,
)
PERSON_TOKEN_RE = re.compile(r"^[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'.’\-]*$")
NON_PERSON_LINE_RE = re.compile(
    r"\b(?:mlir|llvm|tensor|dialect|meeting|openai|nvidia|google|workshop|conference|university|institute|agenda|overview|analysis|frontend|support|design|targeting|interaction|rewrite|rules|shaderpulse|xla|spir-v|gpu|webassembly|wasm|woven|toyota)\b",
    re.IGNORECASE,
)
PDF_INFO_CACHE: dict[str, tuple[str, str]] = {}
PDF_EXTRACTOR_CACHE: dict[str, object] = {}


def collapse_ws(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def slugify(value: str) -> str:
    return re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9]+", "-", collapse_ws(value).lower())).strip("-")


def normalize_url(value: str, base_url: str = MLIR_SITE_BASE) -> str:
    raw = collapse_ws(value)
    if not raw:
        return ""
    return urllib.parse.urljoin(base_url, raw)


def detect_local_mlir_www_root(repo_root: Path) -> Path | None:
    candidates = [
        repo_root.parent / "mlir-www",
        repo_root / "mlir-www",
    ]
    for candidate in candidates:
        talks_index = candidate / "website/content/talks/_index.md"
        pubs_index = candidate / "website/content/pubs/_index.md"
        if talks_index.exists() and pubs_index.exists():
            return candidate
    return None


def resolve_source_path(source: str, *, repo_root: Path, local_root: Path | None, relative_path: str, default_source: str) -> str:
    raw = collapse_ws(source)
    if raw and raw != default_source:
        return raw
    if local_root is not None:
        candidate = (local_root / relative_path).resolve()
        if candidate.exists():
            return str(candidate)
    return default_source


def fetch_text(url: str, timeout: float, *, user_agent: str = USER_AGENT) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": user_agent})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def fetch_text_with_curl(url: str, timeout: float, *, user_agent: str = USER_AGENT) -> str:
    result = subprocess.run(
        [
            "curl",
            "-L",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            str(int(max(timeout, 1))),
            "-A",
            user_agent,
            url,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def load_text(source: str, timeout: float) -> str:
    raw = collapse_ws(source)
    if not raw:
        return ""
    if raw.startswith(("http://", "https://")):
        try:
            return fetch_text(raw, timeout)
        except Exception:
            return fetch_text_with_curl(raw, timeout)
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


def extract_youtube_video_id(url: str) -> str:
    normalized = normalize_url(url)
    if not normalized:
        return ""
    parsed = urllib.parse.urlparse(normalized)
    host = parsed.netloc.lower()
    if host.endswith("youtu.be"):
        return collapse_ws(parsed.path.strip("/").split("/", 1)[0])
    if "youtube.com" not in host and "youtube-nocookie.com" not in host:
        return ""
    query = urllib.parse.parse_qs(parsed.query)
    if query.get("v"):
        return collapse_ws(query["v"][0])
    for prefix in ("/embed/", "/shorts/", "/live/"):
        if parsed.path.startswith(prefix):
            return collapse_ws(parsed.path[len(prefix) :].split("/", 1)[0])
    return ""


def load_json_file(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_speaker_name(value: str) -> str:
    text = collapse_ws(value)
    text = re.sub(r"\((?:filling in for|moderator|host|guest|speaker|presenter)[^)]+\)", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\(@[^)]*\)", "", text)
    text = text.strip(" ,;:-")
    return collapse_ws(text)


def looks_like_person_name(value: str) -> bool:
    text = normalize_speaker_name(value)
    if not text or re.search(r"\d", text):
        return False
    tokens = [token for token in re.split(r"\s+", text) if token]
    if len(tokens) < 2 or len(tokens) > 6:
        return False
    if any(token.lower() in {"by", "of", "for", "in", "to"} for token in tokens):
        return False
    if NON_PERSON_LINE_RE.search(text):
        return False
    return all(PERSON_TOKEN_RE.fullmatch(token.strip("()")) for token in tokens)


def split_paired_name_tokens(text: str) -> list[str]:
    tokens = [token for token in re.split(r"\s+", collapse_ws(text)) if token]
    if len(tokens) < 4 or len(tokens) % 2 != 0:
        return []
    if not all(PERSON_TOKEN_RE.fullmatch(token) for token in tokens):
        return []
    return [" ".join(tokens[index : index + 2]) for index in range(0, len(tokens), 2)]


def dedupe_speaker_names(values: list[str]) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for value in values:
        name = normalize_speaker_name(value)
        key = name.lower()
        if not looks_like_person_name(name) or key in seen:
            continue
        seen.add(key)
        out.append({"name": name, "affiliation": ""})
    return out


def extract_speaker_names_from_text(value: str) -> list[dict]:
    text = collapse_ws(value)
    if not text:
        return []

    candidates: list[str] = []
    working = SPEAKER_PREFIX_RE.sub("", text)
    working = working.replace(";", ",")
    for segment in re.split(r"\s+/\s+|\s+&\s+|\s+ and \s+", working, flags=re.IGNORECASE):
        cleaned = collapse_ws(segment)
        if not cleaned:
            continue
        if " - " in cleaned and not looks_like_person_name(cleaned):
            tail = collapse_ws(cleaned.rsplit(" - ", 1)[-1])
            if looks_like_person_name(tail):
                candidates.append(tail)
                continue
            cleaned = collapse_ws(cleaned.split(" - ", 1)[0])
        cleaned = re.sub(r",\s*\d{4}.*$", "", cleaned)
        cleaned = normalize_speaker_name(cleaned)
        if not cleaned:
            continue
        if "," in cleaned:
            for part in cleaned.split(","):
                candidates.append(part)
            continue
        paired = split_paired_name_tokens(cleaned)
        if paired:
            candidates.extend(paired)
            continue
        candidates.append(cleaned)

    return dedupe_speaker_names(candidates)


def infer_speakers_from_metadata(entry: dict) -> list[dict]:
    raw_candidates: list[str] = []
    for source in [entry.get("summary", ""), entry.get("text", "")]:
        candidate = collapse_ws(source)
        if not candidate:
            continue
        if " @ " in candidate:
            candidate = candidate.split(" @ ", 1)[0]
        if ";" in candidate:
            candidate = candidate.rsplit(";", 1)[-1]
        candidate = RESOURCE_TOKEN_RE.sub(" ", candidate)
        candidate = collapse_ws(candidate).strip(" ,;:-")
        if candidate:
            raw_candidates.append(candidate)
    for candidate in raw_candidates:
        speakers = extract_speaker_names_from_text(candidate)
        if speakers:
            return speakers
    return []


def infer_speakers_from_youtube_description(description: str, title: str) -> list[dict]:
    if not description:
        return []

    full_names = re.findall(r"\bfullname:\s*([^;]+);", description, flags=re.IGNORECASE)
    speakers = dedupe_speaker_names(full_names)
    if speakers:
        return speakers

    lines = [clean_description_line(line) for line in description.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    for index, line in enumerate(lines[:12]):
        if not line:
            continue
        prefixed = SPEAKER_PREFIX_RE.sub("", line)
        if prefixed != line:
            candidate = prefixed
            if not candidate and index + 1 < len(lines):
                candidate = lines[index + 1]
            speakers = extract_speaker_names_from_text(candidate)
            if speakers:
                return speakers
        if title and collapse_ws(title).lower() in line.lower() and " - " in line:
            speakers = extract_speaker_names_from_text(line.rsplit(" - ", 1)[-1])
            if speakers:
                return speakers
    return []


def load_pypdf_reader():
    cached = PDF_EXTRACTOR_CACHE.get("pypdf-reader")
    if cached is not None:
        return cached
    try:
        logging.getLogger("pypdf").setLevel(logging.ERROR)
        from pypdf import PdfReader  # type: ignore
    except Exception:
        PdfReader = None
    PDF_EXTRACTOR_CACHE["pypdf-reader"] = PdfReader
    return PdfReader


def load_fallback_pdf_page_extractor():
    cached = PDF_EXTRACTOR_CACHE.get("fallback-extractor")
    if cached is not None:
        return cached

    module_path = Path(__file__).with_name("generate-talk-paper-links.py")
    if not module_path.exists():
        PDF_EXTRACTOR_CACHE["fallback-extractor"] = None
        return None
    spec = importlib.util.spec_from_file_location("generate_talk_paper_links", module_path)
    if spec is None or spec.loader is None:
        PDF_EXTRACTOR_CACHE["fallback-extractor"] = None
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    extractor = getattr(module, "extract_pdf_pages", None)
    PDF_EXTRACTOR_CACHE["fallback-extractor"] = extractor
    return extractor


def extract_pdf_title_page_info(pdf_path: Path) -> tuple[str, str]:
    cache_key = str(pdf_path.resolve())
    cached = PDF_INFO_CACHE.get(cache_key)
    if cached is not None:
        return cached

    author = ""
    text = ""

    reader_cls = load_pypdf_reader()
    if reader_cls is not None:
        try:
            reader = reader_cls(str(pdf_path))
            metadata = reader.metadata or {}
            author = collapse_ws(str(metadata.get("/Author", "") or ""))
            if reader.pages:
                text = (reader.pages[0].extract_text() or "").replace("\x00", "")
        except Exception:
            author = ""
            text = ""

    if not text:
        extractor = load_fallback_pdf_page_extractor()
        if extractor is not None:
            try:
                pages = extractor(pdf_path.read_bytes())
                text = pages[0] if pages else ""
            except Exception:
                text = ""

    result = (author, text)
    PDF_INFO_CACHE[cache_key] = result
    return result


def resolve_local_mlir_slides_path(slides_url: str, local_mlir_root: Path | None) -> Path | None:
    if local_mlir_root is None:
        return None
    normalized = normalize_url(slides_url)
    if not normalized:
        return None
    parsed = urllib.parse.urlparse(normalized)
    rel_path = urllib.parse.unquote(parsed.path).lstrip("/")
    if not rel_path.startswith("OpenMeetings/"):
        return None
    candidate = (local_mlir_root / "website/static" / rel_path).resolve()
    return candidate if candidate.exists() else None


def infer_speakers_from_slide_page(text: str, title: str) -> list[dict]:
    lines = [collapse_ws(line) for line in str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    lines = [line for line in lines if line]
    if not lines:
        return []

    candidate_lines = lines[:8]
    found_names: list[str] = []
    capturing = False
    for line in candidate_lines:
        if looks_like_title_line(line, title):
            if capturing and found_names:
                break
            continue
        if re.search(r"mlir open design meeting|open mlir meeting|agenda|overview|university|meeting|july|august|september|october|november|december|january|february|march|april|may|june", line, flags=re.IGNORECASE):
            if capturing and found_names:
                break
            continue
        line_names: list[str] = []
        if "," in line and re.search(r",\s*\d{4}", line):
            speakers = extract_speaker_names_from_text(line.split(",", 1)[0])
            if speakers:
                line_names.extend(speaker["name"] for speaker in speakers)
        if not line_names and ("—" in line or "–" in line or " - " in line):
            for segment in re.split(r"\s*[—–]\s*|\s+-\s+", line):
                speakers = extract_speaker_names_from_text(segment)
                if speakers:
                    line_names.extend(speaker["name"] for speaker in speakers)
        if not line_names:
            speakers = extract_speaker_names_from_text(line)
            if speakers:
                line_names.extend(speaker["name"] for speaker in speakers)
        if line_names:
            capturing = True
            found_names.extend(line_names)
            continue
        if capturing and found_names:
            break
    return dedupe_speaker_names(found_names)


def infer_speakers_from_slide_deck(entry: dict, local_mlir_root: Path | None) -> list[dict]:
    for action in entry.get("actions", []):
        if collapse_ws(action.get("kind", "")).lower() != "slides":
            continue
        local_path = resolve_local_mlir_slides_path(action.get("url", ""), local_mlir_root)
        if local_path is None:
            continue
        author, page_text = extract_pdf_title_page_info(local_path)
        speakers = extract_speaker_names_from_text(author)
        if speakers:
            return speakers
        speakers = infer_speakers_from_slide_page(page_text, collapse_ws(entry.get("title", "")))
        if speakers:
            return speakers
    return []


def extract_json_string_field(text: str, marker: str) -> str:
    idx = text.find(marker)
    if idx == -1:
        return ""
    start = text.find('"', idx + len(marker))
    if start == -1:
        return ""
    try:
        value, _ = json.JSONDecoder().raw_decode(text[start:])
    except json.JSONDecodeError:
        return ""
    return value if isinstance(value, str) else ""


def fetch_youtube_short_description(video_id: str, timeout: float) -> str:
    watch_url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        html = fetch_text(watch_url, timeout, user_agent=BROWSER_USER_AGENT)
    except Exception:
        html = fetch_text_with_curl(watch_url, timeout, user_agent=BROWSER_USER_AGENT)
    return extract_json_string_field(html, '"shortDescription":')


def clean_description_line(line: str) -> str:
    text = collapse_ws(line.replace("\u00a0", " "))
    text = text.lstrip("•-–— \t")
    return collapse_ws(text)


def is_url_line(line: str) -> bool:
    return bool(re.fullmatch(r"https?://\S+", collapse_ws(line)))


def is_separator_line(line: str) -> bool:
    text = collapse_ws(line)
    return bool(text) and all(char in "-—_=~•·" for char in text)


def looks_like_title_line(line: str, title: str) -> bool:
    candidate = collapse_ws(line).lower()
    title_text = collapse_ws(title).lower()
    if not candidate or not title_text:
        return False
    if candidate == title_text:
        return True
    if title_text in candidate and len(candidate.split()) <= len(title_text.split()) + 8:
        return True
    if candidate in title_text and len(candidate.split()) >= max(4, len(title_text.split()) // 2):
        return True
    return False


def is_abstract_paragraph(paragraph: str, title: str) -> bool:
    text = collapse_ws(paragraph)
    if len(text) < 40:
        return False
    if len(text.split()) < 8:
        return False
    if text.startswith("[") and text.endswith("]"):
        return False
    if len(re.findall(r"https?://\S+", text)) >= 2:
        return False
    if is_url_line(text) or is_separator_line(text):
        return False
    if RESOURCE_LINE_RE.match(text):
        return False
    if GENERIC_DESCRIPTION_RE.search(text):
        return False
    if looks_like_title_line(text, title):
        return False
    return True


def extract_abstract_from_youtube_description(description: str, title: str) -> str:
    if not description:
        return ""

    lines = [clean_description_line(line) for line in description.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    paragraphs: list[str] = []
    current: list[str] = []

    def flush() -> None:
        nonlocal current
        paragraph = collapse_ws(" ".join(current))
        if paragraph:
            paragraphs.append(paragraph)
        current = []

    for line in lines:
        if not line:
            flush()
            continue
        if is_separator_line(line) or is_url_line(line):
            flush()
            continue
        if RESOURCE_LINE_RE.match(line):
            flush()
            continue
        if GENERIC_DESCRIPTION_RE.search(line):
            flush()
            continue
        if looks_like_title_line(line, title):
            flush()
            continue
        current.append(line)
    flush()

    selected: list[str] = []
    total_length = 0
    for paragraph in paragraphs:
        if not is_abstract_paragraph(paragraph, title):
            continue
        selected.append(paragraph)
        total_length += len(paragraph)
        if len(selected) >= 2 or total_length >= 1200:
            break

    return "\n\n".join(selected)


def enrich_talk_abstracts_with_youtube(
    sections: list[dict],
    *,
    timeout: float,
    cache_path: Path,
    refresh: bool,
    local_mlir_root: Path | None,
    enable_youtube: bool,
) -> None:
    cache = load_json_file(cache_path) if cache_path.exists() else {}
    cache_videos = cache.setdefault("videos", {})
    cache_dirty = False

    for section in sections:
        for group in section.get("groups", []):
            for entry in group.get("entries", []):
                speakers = infer_speakers_from_metadata(entry)
                actions = entry.get("actions", [])
                recording_url = ""
                for action in actions:
                    url = collapse_ws(action.get("url", ""))
                    if collapse_ws(action.get("kind", "")).lower() == "recording" and extract_youtube_video_id(url):
                        recording_url = url
                        break
                if not recording_url:
                    if not speakers:
                        speakers = infer_speakers_from_slide_deck(entry, local_mlir_root)
                    if speakers:
                        entry["speakers"] = speakers
                    continue

                video_id = extract_youtube_video_id(recording_url)
                if not video_id:
                    if not speakers:
                        speakers = infer_speakers_from_slide_deck(entry, local_mlir_root)
                    if speakers:
                        entry["speakers"] = speakers
                    continue

                if not enable_youtube:
                    if not speakers:
                        speakers = infer_speakers_from_slide_deck(entry, local_mlir_root)
                    if speakers:
                        entry["speakers"] = speakers
                    continue

                cached = cache_videos.get(video_id, {}) if isinstance(cache_videos, dict) else {}
                raw_description = str(cached.get("rawDescription", "") or "")

                if refresh or not raw_description:
                    raw_description = fetch_youtube_short_description(video_id, timeout)
                    cached = {
                        "videoId": video_id,
                        "videoUrl": recording_url,
                        "title": collapse_ws(entry.get("title", "")),
                        "rawDescription": raw_description,
                        "fetchedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                    }
                    cache_videos[video_id] = cached
                    cache_dirty = True

                abstract = extract_abstract_from_youtube_description(raw_description, collapse_ws(entry.get("title", "")))
                if abstract:
                    entry["abstract"] = abstract
                    entry["abstractSource"] = "youtube"

                if not speakers:
                    speakers = infer_speakers_from_youtube_description(raw_description, collapse_ws(entry.get("title", "")))
                if not speakers:
                    speakers = infer_speakers_from_slide_deck(entry, local_mlir_root)
                if speakers:
                    entry["speakers"] = speakers

    if cache_dirty:
        cache["schemaVersion"] = 1
        cache["generatedAt"] = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        write_json(cache_path, cache)


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


def filter_talk_sections(sections: list[dict]) -> list[dict]:
    return [
        section
        for section in sections
        if collapse_ws(section.get("id", "")) not in EXCLUDED_TALK_SECTION_IDS
    ]


def build_payload(*, title: str, source_url: str, source_path: str, sections: list[dict]) -> dict:
    timestamp = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return {
        "dataVersion": f"{dt.date.today().isoformat()}-{slugify(title)}",
        "generatedAt": timestamp,
        "title": title,
        "sourceUrl": source_url,
        "sourcePath": source_path,
        "sections": sections,
    }


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--mlir-www-root", default="")
    parser.add_argument("--talks-source", default=DEFAULT_TALKS_SOURCE)
    parser.add_argument("--pubs-source", default=DEFAULT_PUBS_SOURCE)
    parser.add_argument("--talks-output", default="sub-projects/mlir/data/talks.json")
    parser.add_argument("--pubs-output", default="sub-projects/mlir/data/publications.json")
    parser.add_argument("--youtube-cache", default=DEFAULT_YOUTUBE_CACHE)
    parser.add_argument("--skip-youtube-abstracts", action="store_true")
    parser.add_argument("--refresh-youtube-abstracts", action="store_true")
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    local_mlir_root = Path(args.mlir_www_root).resolve() if collapse_ws(args.mlir_www_root) else detect_local_mlir_www_root(repo_root)
    talks_source = resolve_source_path(
        args.talks_source,
        repo_root=repo_root,
        local_root=local_mlir_root,
        relative_path="website/content/talks/_index.md",
        default_source=DEFAULT_TALKS_SOURCE,
    )
    pubs_source = resolve_source_path(
        args.pubs_source,
        repo_root=repo_root,
        local_root=local_mlir_root,
        relative_path="website/content/pubs/_index.md",
        default_source=DEFAULT_PUBS_SOURCE,
    )

    talks_text = load_text(talks_source, args.timeout)
    pubs_text = load_text(pubs_source, args.timeout)

    talk_sections = filter_talk_sections(parse_markdown_page(talks_text, page_kind="talks"))
    pub_sections = parse_markdown_page(pubs_text, page_kind="publications")
    enrich_talk_abstracts_with_youtube(
        talk_sections,
        timeout=args.timeout,
        cache_path=(repo_root / args.youtube_cache).resolve(),
        refresh=args.refresh_youtube_abstracts,
        local_mlir_root=local_mlir_root,
        enable_youtube=not args.skip_youtube_abstracts,
    )
    assign_entry_ids(talk_sections, prefix="mlir-talk")
    assign_entry_ids(pub_sections, prefix="mlir-pub")

    talks_payload = build_payload(
        title="MLIR Talks",
        source_url=TALKS_PAGE_URL,
        source_path=talks_source,
        sections=talk_sections,
    )
    pubs_payload = build_payload(
        title="MLIR Related Publications",
        source_url=PUBS_PAGE_URL,
        source_path=pubs_source,
        sections=pub_sections,
    )

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
