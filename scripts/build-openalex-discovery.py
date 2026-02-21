#!/usr/bin/env python3
"""Discover additional LLVM-related papers for known speakers/authors via OpenAlex.

This script:
  1) Builds a seed author set from:
     - devmtg talk speakers
     - existing papers authors
  2) Queries OpenAlex for LLVM-related keyword searches
  3) Keeps works where at least one listed author matches a seed author exactly
     after normalization.
  4) Emits papers/openalex-discovered.json and updates papers/index.json.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


OPENALEX_BASE = "https://api.openalex.org/works"
DEFAULT_KEYWORDS = [
    "llvm",
    "clang compiler",
    "mlir compiler",
    "lldb",
    "flang compiler",
    "circt",
    "libfuzzer",
    "addresssanitizer",
    "memorysanitizer",
    "undefinedbehaviorsanitizer",
]
FOCUS_TERMS = [
    "llvm",
    "clang",
    "mlir",
    "lldb",
    "lld",
    "flang",
    "circt",
    "libfuzzer",
    "addresssanitizer",
    "memorysanitizer",
    "undefinedbehaviorsanitizer",
]
ALLOWED_OPENALEX_TYPES = {
    "article",
    "book",
    "book-chapter",
    "dissertation",
    "preprint",
    "proceedings-article",
    "report",
}


def collapse_ws(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def strip_tags(value: str) -> str:
    if not value:
        return ""
    value = re.sub(r"<script\b[^>]*>.*?</script>", " ", value, flags=re.IGNORECASE | re.DOTALL)
    value = re.sub(r"<style\b[^>]*>.*?</style>", " ", value, flags=re.IGNORECASE | re.DOTALL)
    value = re.sub(r"<[^>]+>", " ", value)
    return collapse_ws(html.unescape(value))


def slugify(value: str) -> str:
    lowered = value.lower()
    lowered = re.sub(r"[^a-z0-9]+", "-", lowered)
    lowered = re.sub(r"-{2,}", "-", lowered)
    return lowered.strip("-")


def normalize_name(value: str) -> str:
    v = collapse_ws(value).lower()
    v = re.sub(r"[^a-z0-9 ]+", "", v)
    return collapse_ws(v)


def normalize_title_key(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def parse_all_tags(app_js_path: Path) -> list[str]:
    text = app_js_path.read_text(encoding="utf-8")
    match = re.search(r"const\s+ALL_TAGS\s*=\s*\[(.*?)\];", text, flags=re.DOTALL)
    if not match:
        raise RuntimeError(f"Could not find ALL_TAGS in {app_js_path}")

    tags_raw = match.group(1)
    tags: list[str] = []
    for single, double in re.findall(r"'([^']+)'|\"([^\"]+)\"", tags_raw):
        tag = collapse_ws(single or double)
        if tag:
            tags.append(tag)

    if not tags:
        raise RuntimeError("Parsed empty ALL_TAGS list")
    return tags


def extract_tags_from_text(tags: list[str], title: str, abstract: str) -> list[str]:
    text = f"{title} {abstract}".lower()
    found: list[str] = []

    for tag in tags:
        t = tag.lower()
        alnum_len = len(re.sub(r"[^a-z0-9]", "", t))
        if alnum_len <= 3:
            pattern = rf"(?<![a-z0-9]){re.escape(t)}(?![a-z0-9])"
            if re.search(pattern, text):
                found.append(tag)
        else:
            if t in text:
                found.append(tag)

    return found


def parse_manifest_paper_files(index_path: Path) -> list[str]:
    if not index_path.exists():
        return []
    payload = json.loads(index_path.read_text(encoding="utf-8"))
    files = payload.get("paperFiles") or payload.get("files") or []
    out = [collapse_ws(str(f)) for f in files if collapse_ws(str(f))]
    return out


def load_existing_title_keys(papers_dir: Path, manifest_files: list[str], output_bundle_name: str) -> set[tuple[str, str]]:
    keys: set[tuple[str, str]] = set()
    for rel in manifest_files:
        if rel == output_bundle_name:
            continue
        path = (papers_dir / rel).resolve()
        if not path.exists():
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        for paper in payload.get("papers", []):
            year = collapse_ws(str(paper.get("year", "")))
            title = strip_tags(str(paper.get("title", "")))
            if not title:
                continue
            keys.add((year, normalize_title_key(title)))
    return keys


def load_seed_authors(
    events_dir: Path,
    papers_dir: Path,
    manifest_files: list[str],
    output_bundle_name: str,
) -> dict[str, str]:
    normalized_to_display: dict[str, str] = {}

    # Talk speakers
    for path in sorted(events_dir.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        for talk in payload.get("talks", []):
            for speaker in talk.get("speakers", []):
                name = collapse_ws(str(speaker.get("name", "")))
                if not name:
                    continue
                key = normalize_name(name)
                if key and key not in normalized_to_display:
                    normalized_to_display[key] = name

    # Existing papers authors
    for rel in manifest_files:
        if rel == output_bundle_name:
            continue
        path = (papers_dir / rel).resolve()
        if not path.exists():
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        for paper in payload.get("papers", []):
            for author in paper.get("authors", []):
                name = collapse_ws(str(author.get("name", "")))
                if not name:
                    continue
                key = normalize_name(name)
                if key and key not in normalized_to_display:
                    normalized_to_display[key] = name

    return normalized_to_display


def _http_get_json(url: str, timeout_s: int = 40, retries: int = 4):
    headers = {
        "User-Agent": "library-openalex-discovery/1.0 (+https://github.com/llvm/library)",
        "Accept": "application/json",
    }
    req = urllib.request.Request(url, headers=headers, method="GET")

    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                body = resp.read()
            return json.loads(body)
        except urllib.error.HTTPError as err:
            if err.code in (429, 500, 502, 503, 504) and attempt < retries:
                retry_after = err.headers.get("Retry-After")
                delay = float(retry_after) if retry_after and retry_after.isdigit() else 1.5 * attempt
                time.sleep(delay)
                continue
            raise
        except Exception:
            if attempt < retries:
                time.sleep(1.2 * attempt)
                continue
            raise

    raise RuntimeError("Exhausted retries while fetching OpenAlex payload")


def fetch_openalex_page(
    keyword: str,
    page: int,
    per_page: int,
    start_year: int,
    cache_dir: Path,
    mailto: str,
    use_cache: bool,
):
    cache_dir.mkdir(parents=True, exist_ok=True)
    slug = slugify(keyword) or "keyword"
    cache_file = cache_dir / f"{slug}-y{start_year}-n{per_page}-p{page}.json"
    if use_cache and cache_file.exists():
        return json.loads(cache_file.read_text(encoding="utf-8"))

    params = {
        "search": keyword,
        "page": str(page),
        "per-page": str(per_page),
        "sort": "publication_date:desc",
        "filter": f"from_publication_date:{start_year}-01-01",
    }
    if mailto:
        params["mailto"] = mailto

    url = OPENALEX_BASE + "?" + urllib.parse.urlencode(params)
    payload = _http_get_json(url)
    if use_cache:
        cache_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return payload


def decode_abstract_inverted_index(index_obj) -> str:
    if not isinstance(index_obj, dict):
        return ""
    max_pos = -1
    for positions in index_obj.values():
        if not isinstance(positions, list):
            continue
        for pos in positions:
            if isinstance(pos, int) and pos > max_pos:
                max_pos = pos
    if max_pos < 0:
        return ""

    words = [""] * (max_pos + 1)
    for token, positions in index_obj.items():
        if not isinstance(positions, list):
            continue
        clean_token = collapse_ws(str(token))
        if not clean_token:
            continue
        for pos in positions:
            if isinstance(pos, int) and 0 <= pos < len(words):
                words[pos] = clean_token
    return collapse_ws(" ".join(words))


def extract_author_list(work: dict) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()

    for authorship in work.get("authorships", []) or []:
        author = authorship.get("author") or {}
        name = collapse_ws(str(author.get("display_name", "")))
        if not name:
            continue
        key = normalize_name(name)
        if not key or key in seen:
            continue
        seen.add(key)

        affiliation = ""
        institutions = authorship.get("institutions") or []
        if institutions and isinstance(institutions, list):
            first = institutions[0] or {}
            affiliation = collapse_ws(str(first.get("display_name", "")))

        out.append({"name": name, "affiliation": affiliation})

    return out


def pick_urls(work: dict) -> tuple[str, str]:
    candidates: list[str] = []

    primary = work.get("primary_location") or {}
    best_oa = work.get("best_oa_location") or {}
    open_access = work.get("open_access") or {}

    for value in [
        best_oa.get("pdf_url"),
        primary.get("pdf_url"),
        open_access.get("oa_url"),
        best_oa.get("landing_page_url"),
        primary.get("landing_page_url"),
        work.get("doi"),
    ]:
        url = collapse_ws(str(value or ""))
        if url:
            candidates.append(url)

    paper_url = ""
    for url in candidates:
        if re.search(r"\.pdf(?:$|[?#])", url, flags=re.IGNORECASE):
            paper_url = url
            break
    if not paper_url and candidates:
        paper_url = candidates[0]

    source_url = collapse_ws(str(work.get("doi") or ""))
    if not source_url:
        source_url = collapse_ws(str(primary.get("landing_page_url") or best_oa.get("landing_page_url") or ""))
    if not source_url:
        source_url = collapse_ws(str(work.get("id") or ""))

    if source_url == paper_url:
        source_url = ""

    return paper_url, source_url


def pick_venue(work: dict) -> str:
    primary = work.get("primary_location") or {}
    source = primary.get("source") or {}

    parts = []
    venue = collapse_ws(str(source.get("display_name", "")))
    if venue:
        parts.append(venue)

    biblio = work.get("biblio") or {}
    volume = collapse_ws(str(biblio.get("volume", "")))
    issue = collapse_ws(str(biblio.get("issue", "")))
    if volume:
        parts.append(f"Vol. {volume}" + (f" (Issue {issue})" if issue else ""))

    return " | ".join(parts)


def classify_type(openalex_type: str) -> str:
    t = collapse_ws(openalex_type).lower()
    if t == "dissertation":
        return "thesis"
    return "research-paper"


def match_focus_terms(text: str) -> bool:
    blob = text.lower()
    for term in FOCUS_TERMS:
        if len(term) <= 3:
            if re.search(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])", blob):
                return True
        else:
            if term in blob:
                return True
    return False


def update_manifest(index_path: Path, output_bundle_name: str, data_version: str):
    payload = {}
    if index_path.exists():
        payload = json.loads(index_path.read_text(encoding="utf-8"))

    files = payload.get("paperFiles") or payload.get("files") or []
    files = [collapse_ws(str(f)) for f in files if collapse_ws(str(f))]
    if output_bundle_name not in files:
        files.append(output_bundle_name)

    payload["paperFiles"] = files
    payload.pop("files", None)
    payload["dataVersion"] = data_version
    index_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--events-dir", default="/Users/britton/Desktop/library/devmtg/events")
    parser.add_argument("--papers-dir", default="/Users/britton/Desktop/library/papers")
    parser.add_argument("--app-js", default="/Users/britton/Desktop/library/devmtg/js/app.js")
    parser.add_argument("--index-json", default="/Users/britton/Desktop/library/papers/index.json")
    parser.add_argument("--output-bundle", default="openalex-discovered.json")
    parser.add_argument("--cache-dir", default="/Users/britton/Desktop/library/papers/.cache/openalex")
    parser.add_argument("--start-year", type=int, default=2000)
    parser.add_argument("--max-pages-per-keyword", type=int, default=25)
    parser.add_argument("--per-page", type=int, default=200)
    parser.add_argument("--mailto", default="")
    parser.add_argument("--keywords", nargs="*", default=DEFAULT_KEYWORDS)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--no-cache", action="store_true")
    args = parser.parse_args()

    events_dir = Path(args.events_dir).resolve()
    papers_dir = Path(args.papers_dir).resolve()
    app_js = Path(args.app_js).resolve()
    index_json = Path(args.index_json).resolve()
    output_bundle_name = args.output_bundle
    output_bundle_path = papers_dir / output_bundle_name
    cache_dir = Path(args.cache_dir).resolve()

    manifest_files = parse_manifest_paper_files(index_json)
    tags = parse_all_tags(app_js)
    seed_authors = load_seed_authors(events_dir, papers_dir, manifest_files, output_bundle_name)
    existing_title_keys = load_existing_title_keys(papers_dir, manifest_files, output_bundle_name)

    all_works: dict[str, dict] = {}
    total_requests = 0

    for keyword in args.keywords:
        kw = collapse_ws(keyword)
        if not kw:
            continue

        if args.verbose:
            print(f"[openalex] keyword={kw}", flush=True)

        for page in range(1, args.max_pages_per_keyword + 1):
            payload = fetch_openalex_page(
                keyword=kw,
                page=page,
                per_page=args.per_page,
                start_year=args.start_year,
                cache_dir=cache_dir,
                mailto=args.mailto,
                use_cache=not args.no_cache,
            )
            total_requests += 1

            results = payload.get("results", []) or []
            total_count = int((payload.get("meta") or {}).get("count") or 0)
            if args.verbose:
                print(
                    f"  page={page} results={len(results)} total={total_count}",
                    flush=True,
                )
            if not results:
                break

            for work in results:
                work_id = collapse_ws(str(work.get("id", "")))
                if work_id:
                    all_works[work_id] = work

            if page * args.per_page >= total_count:
                break

            time.sleep(0.08)

    used_ids: set[str] = set()
    out_papers: list[dict] = []
    kept_existing_keys: set[tuple[str, str]] = set()

    for work in all_works.values():
        openalex_type = collapse_ws(str(work.get("type", ""))).lower()
        if openalex_type and openalex_type not in ALLOWED_OPENALEX_TYPES:
            continue

        title = strip_tags(str(work.get("title", "")))
        if not title:
            continue

        abstract = decode_abstract_inverted_index(work.get("abstract_inverted_index"))
        venue = pick_venue(work)
        focus_blob = f"{title} {abstract} {venue}"
        if not match_focus_terms(focus_blob):
            continue

        authors = extract_author_list(work)
        if not authors:
            continue

        matched = []
        for author in authors:
            key = normalize_name(author.get("name", ""))
            if key in seed_authors:
                matched.append(seed_authors[key])
        matched = sorted(set(matched))
        if not matched:
            continue

        year_val = work.get("publication_year")
        year = str(year_val) if isinstance(year_val, int) and year_val > 0 else ""

        title_key = (year, normalize_title_key(title))
        if title_key in existing_title_keys or title_key in kept_existing_keys:
            continue

        paper_url, source_url = pick_urls(work)
        tags_for_paper = extract_tags_from_text(tags, title, abstract)

        openalex_id = collapse_ws(str(work.get("id", "")))
        suffix = openalex_id.rsplit("/", 1)[-1].lower() if openalex_id else slugify(title)[:32]
        base_id = slugify(f"openalex-{suffix}") or "openalex-paper"
        paper_id = base_id
        idx = 2
        while paper_id in used_ids:
            paper_id = f"{base_id}-{idx}"
            idx += 1
        used_ids.add(paper_id)

        out_papers.append(
            {
                "id": paper_id,
                "source": "openalex-discovery",
                "title": title,
                "authors": authors,
                "year": year,
                "venue": venue,
                "type": classify_type(openalex_type),
                "abstract": abstract or "No abstract available in discovery metadata.",
                "paperUrl": paper_url,
                "sourceUrl": source_url,
                "tags": tags_for_paper,
                "matchedAuthors": matched,
            }
        )
        kept_existing_keys.add(title_key)

    out_papers.sort(
        key=lambda p: (p.get("year") or "0000", p.get("title") or "", p.get("id") or ""),
        reverse=True,
    )

    bundle = {
        "source": {
            "slug": "openalex-discovery",
            "name": "OpenAlex Discovery (seeded by LLVM speakers/authors)",
            "url": "https://api.openalex.org",
        },
        "papers": out_papers,
    }
    output_bundle_path.write_text(json.dumps(bundle, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    data_version = _dt.date.today().isoformat() + "-llvm-org-pubs-plus-openalex"
    update_manifest(index_json, output_bundle_name, data_version)

    print(f"Seed authors: {len(seed_authors)}")
    print(f"OpenAlex requests: {total_requests}")
    print(f"Unique works fetched: {len(all_works)}")
    print(f"Discovered papers written: {len(out_papers)} -> {output_bundle_path}")
    print(f"Updated manifest: {index_json} (dataVersion={data_version})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
