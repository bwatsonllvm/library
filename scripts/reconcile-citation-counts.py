#!/usr/bin/env python3
"""Reconcile ranking-sensitive citation counts across open providers.

The library keeps OpenAlex as the broad-coverage default, but OpenAlex can
occasionally attach aggregate citation histories to the wrong work. This script
audits high-impact records against OpenAlex temporal sanity checks, Crossref,
and optionally Semantic Scholar, then writes the selected count back to the
paper bundle used by the site.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import os
import re
import subprocess
import time
import urllib.parse
from pathlib import Path
from typing import Iterable

OPENALEX_WORKS_API = "https://api.openalex.org/works"
CROSSREF_WORKS_API = "https://api.crossref.org/works"
SEMANTIC_SCHOLAR_PAPER_API = "https://api.semanticscholar.org/graph/v1/paper"


def collapse_ws(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def parse_int(value) -> int | None:
    try:
        return int(value)
    except Exception:
        return None


def normalize_doi(value: str) -> str:
    raw = collapse_ws(value).lower()
    if not raw:
        return ""
    raw = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", raw)
    raw = re.sub(r"^doi:\s*", "", raw)
    match = re.search(r"(10\.\d{4,9}/\S+)", raw)
    if not match:
        return ""
    return match.group(1).rstrip(".,;)")


def normalize_openalex_short_id(value: str) -> str:
    raw = collapse_ws(value).rstrip("/")
    if not raw:
        return ""
    suffix = raw.rsplit("/", 1)[-1].upper()
    if re.fullmatch(r"W\d+", suffix):
        return suffix
    return ""


def chunks(values: list[str], size: int) -> Iterable[list[str]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        payload = json.load(fh)
    if not isinstance(payload, dict):
        raise ValueError(f"{path}: expected JSON object")
    return payload


def save_json(path: Path, payload: dict) -> bool:
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    if text == existing:
        return False
    path.write_text(text, encoding="utf-8")
    return True


def curl_json(url: str, user_agent: str, headers: list[str] | None = None) -> dict | None:
    cmd = [
        "curl",
        "-sS",
        "--retry",
        "3",
        "--retry-all-errors",
        "--connect-timeout",
        "20",
        "--max-time",
        "60",
        "-A",
        user_agent,
    ]
    for header in headers or []:
        cmd.extend(["-H", header])
    cmd.append(url)
    try:
        proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
        payload = json.loads(proc.stdout)
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def openalex_citation_rejection_reason(work: dict) -> str:
    citation_count = parse_int(work.get("cited_by_count"))
    publication_year = parse_int(work.get("publication_year"))
    if citation_count is None or citation_count <= 0 or publication_year is None:
        return ""
    counts_by_year = work.get("counts_by_year")
    if not isinstance(counts_by_year, list):
        return ""

    pre_publication_count = 0
    earliest_pre_publication_year: int | None = None
    for item in counts_by_year:
        if not isinstance(item, dict):
            continue
        year = parse_int(item.get("year"))
        count = parse_int(item.get("cited_by_count")) or 0
        if year is None or count <= 0 or year >= publication_year:
            continue
        pre_publication_count += count
        earliest_pre_publication_year = year if earliest_pre_publication_year is None else min(earliest_pre_publication_year, year)

    if earliest_pre_publication_year is None:
        return ""
    if earliest_pre_publication_year <= publication_year - 2:
        return "citations-before-publication-window"
    if pre_publication_count >= max(25, int(citation_count * 0.1)):
        return "citations-before-publication-volume"
    return ""


def fetch_openalex_works(short_ids: list[str], mailto: str, user_agent: str, batch_size: int) -> dict[str, dict]:
    works: dict[str, dict] = {}
    if not short_ids:
        return works
    total_batches = math.ceil(len(short_ids) / batch_size)
    for batch_index, batch in enumerate(chunks(short_ids, batch_size), start=1):
        params = {
            "filter": f"openalex:{'|'.join(batch)}",
            "per-page": str(len(batch)),
            "select": "id,display_name,publication_year,cited_by_count,counts_by_year,doi,type,primary_location",
        }
        if mailto:
            params["mailto"] = mailto
        url = f"{OPENALEX_WORKS_API}?{urllib.parse.urlencode(params)}"
        payload = curl_json(url, user_agent=user_agent)
        for work in (payload or {}).get("results", []) or []:
            if not isinstance(work, dict):
                continue
            short_id = normalize_openalex_short_id(str(work.get("id", "")))
            if short_id:
                works[short_id] = work
        print(f"[openalex] fetched batch {batch_index}/{total_batches} ({len(batch)} ids)", flush=True)
        time.sleep(0.06)
    return works


def fetch_crossref_counts(dois: list[str], mailto: str, user_agent: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for index, doi in enumerate(dois, start=1):
        params = {"mailto": mailto} if mailto else {}
        query = f"?{urllib.parse.urlencode(params)}" if params else ""
        url = f"{CROSSREF_WORKS_API}/{urllib.parse.quote(doi, safe='')}{query}"
        payload = curl_json(url, user_agent=user_agent)
        message = payload.get("message") if isinstance(payload, dict) else None
        count = parse_int(message.get("is-referenced-by-count")) if isinstance(message, dict) else None
        if count is not None:
            counts[doi] = max(0, count)
        if index % 25 == 0 or index == len(dois):
            print(f"[crossref] fetched {index}/{len(dois)} DOI counts", flush=True)
        time.sleep(0.05)
    return counts


def fetch_semantic_scholar_counts(dois: list[str], api_key: str, user_agent: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    headers = [f"x-api-key: {api_key}"] if api_key else []
    for index, doi in enumerate(dois, start=1):
        identifier = urllib.parse.quote(f"DOI:{doi}", safe=":")
        url = f"{SEMANTIC_SCHOLAR_PAPER_API}/{identifier}?fields=paperId,title,year,citationCount,externalIds"
        payload = curl_json(url, user_agent=user_agent, headers=headers)
        if isinstance(payload, dict) and parse_int(payload.get("code")) == 429:
            print("[semantic-scholar] rate limited; keeping provider optional for this run", flush=True)
            break
        count = parse_int((payload or {}).get("citationCount"))
        if count is not None:
            counts[doi] = max(0, count)
        if index % 25 == 0 or index == len(dois):
            print(f"[semantic-scholar] fetched {index}/{len(dois)} DOI counts", flush=True)
        time.sleep(0.12 if api_key else 1.2)
    return counts


def selected_records(papers: list[dict], max_records: int, min_existing_count: int, explicit_ids: set[str]) -> list[dict]:
    if explicit_ids:
        out = []
        for paper in papers:
            paper_id = collapse_ws(str(paper.get("id", ""))).lower()
            openalex_id = normalize_openalex_short_id(str(paper.get("openalexId", ""))).lower()
            doi = normalize_doi(str(paper.get("doi", ""))).lower()
            if paper_id in explicit_ids or openalex_id in explicit_ids or doi in explicit_ids:
                out.append(paper)
        return out

    candidates = []
    for paper in papers:
        count = parse_int(paper.get("citationCount")) or 0
        if count >= min_existing_count:
            candidates.append(paper)
    candidates.sort(
        key=lambda paper: (
            parse_int(paper.get("citationCount")) or 0,
            collapse_ws(str(paper.get("year", ""))),
            collapse_ws(str(paper.get("title", ""))).lower(),
        ),
        reverse=True,
    )
    return candidates[:max_records] if max_records > 0 else candidates


def choose_citation_count(record: dict, work: dict | None, crossref_count: int | None, semantic_count: int | None) -> tuple[int, str, str, dict[str, int]]:
    provider_counts: dict[str, int] = {}
    current_count = parse_int(record.get("citationCount")) or 0

    openalex_count = None
    rejection_reason = ""
    if isinstance(work, dict):
        openalex_raw = parse_int(work.get("cited_by_count"))
        if openalex_raw is not None:
            provider_counts["openalex"] = max(0, openalex_raw)
            rejection_reason = openalex_citation_rejection_reason(work)
            if not rejection_reason:
                openalex_count = max(0, openalex_raw)

    if crossref_count is not None:
        provider_counts["crossref"] = max(0, crossref_count)
    if semantic_count is not None:
        provider_counts["semanticScholar"] = max(0, semantic_count)

    if openalex_count is not None and semantic_count is not None:
        if semantic_count > openalex_count and semantic_count <= max(openalex_count * 3, openalex_count + 100):
            return semantic_count, "semantic-scholar", "", provider_counts
        return openalex_count, "openalex", "", provider_counts
    if openalex_count is not None:
        return openalex_count, "openalex", "", provider_counts
    if semantic_count is not None:
        status = f"openalex-rejected:{rejection_reason}" if rejection_reason else ""
        return semantic_count, "semantic-scholar", status, provider_counts
    if crossref_count is not None:
        status = f"openalex-rejected:{rejection_reason}" if rejection_reason else ""
        return crossref_count, "crossref", status, provider_counts
    if rejection_reason:
        return 0, "rejected-openalex", f"openalex-rejected:{rejection_reason}", provider_counts
    return current_count, collapse_ws(str(record.get("citationCountSource", ""))) or "existing", "", provider_counts


def update_manifest(manifest_path: Path, bundle_path: Path) -> bool:
    if not manifest_path.exists():
        return False
    payload = load_json(manifest_path)
    paper_files = payload.get("paperFiles")
    if isinstance(paper_files, list) and bundle_path.name not in paper_files:
        return False
    data_version = f"{_dt.date.today().isoformat()}-papers-citation-reconciled-v1"
    if payload.get("dataVersion") == data_version:
        return False
    payload["dataVersion"] = data_version
    return save_json(manifest_path, payload)


def write_report(path: Path, rows: list[dict]) -> bool:
    lines = [
        "# Citation Count Reconciliation",
        "",
        f"Generated: {_dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')}",
        "",
        "| Count | Source | Previous | Status | Title |",
        "| ---: | --- | ---: | --- | --- |",
    ]
    for row in rows[:100]:
        title = collapse_ws(str(row.get("title", ""))).replace("|", "\\|")
        lines.append(
            f"| {row['selected']} | {row['source']} | {row['previous']} | {row['status'] or ''} | {title} |"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    text = "\n".join(lines) + "\n"
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    if existing == text:
        return False
    path.write_text(text, encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", default="papers/combined-all-papers-deduped.json")
    parser.add_argument("--manifest", default="papers/index.json")
    parser.add_argument("--max-records", type=int, default=250)
    parser.add_argument("--min-existing-count", type=int, default=100)
    parser.add_argument("--paper-id", action="append", default=[], help="Specific paper id, OpenAlex work id, or DOI to audit.")
    parser.add_argument("--batch-size", type=int, default=40)
    parser.add_argument("--mailto", default="llvm-library-bot@users.noreply.github.com")
    parser.add_argument("--user-agent", default="library-citation-reconciliation/1.0")
    parser.add_argument("--semantic-scholar-api-key", default=os.environ.get("SEMANTIC_SCHOLAR_API_KEY", ""))
    parser.add_argument("--skip-crossref", action="store_true")
    parser.add_argument("--skip-semantic-scholar", action="store_true")
    parser.add_argument("--report", default="updates/citation-count-audit.md")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    bundle_path = Path(args.bundle).resolve()
    manifest_path = Path(args.manifest).resolve()
    payload = load_json(bundle_path)
    papers = payload.get("papers")
    if not isinstance(papers, list):
        raise SystemExit(f"{bundle_path}: missing papers array")

    explicit_ids = {collapse_ws(value).lower() for value in args.paper_id if collapse_ws(value)}
    targets = selected_records(
        papers,
        max_records=max(0, int(args.max_records)),
        min_existing_count=max(0, int(args.min_existing_count)),
        explicit_ids=explicit_ids,
    )
    print(f"Citation records selected for reconciliation: {len(targets)}", flush=True)

    openalex_ids = sorted(
        {
            normalize_openalex_short_id(str(paper.get("openalexId", "")))
            for paper in targets
            if normalize_openalex_short_id(str(paper.get("openalexId", "")))
        }
    )
    dois = sorted(
        {
            normalize_doi(str(paper.get("doi", "")))
            for paper in targets
            if normalize_doi(str(paper.get("doi", "")))
        }
    )

    openalex_works = fetch_openalex_works(
        openalex_ids,
        mailto=args.mailto.strip(),
        user_agent=args.user_agent,
        batch_size=max(1, int(args.batch_size)),
    )
    crossref_counts = {} if args.skip_crossref else fetch_crossref_counts(
        dois,
        mailto=args.mailto.strip(),
        user_agent=args.user_agent,
    )
    semantic_counts = {}
    if not args.skip_semantic_scholar and args.semantic_scholar_api_key:
        semantic_counts = fetch_semantic_scholar_counts(
            dois,
            api_key=args.semantic_scholar_api_key.strip(),
            user_agent=args.user_agent,
        )
    elif not args.skip_semantic_scholar:
        print("[semantic-scholar] skipped; set SEMANTIC_SCHOLAR_API_KEY to enable", flush=True)

    checked_at = _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    changed_rows: list[dict] = []
    rejected_openalex = 0
    for paper in targets:
        previous = parse_int(paper.get("citationCount")) or 0
        short_id = normalize_openalex_short_id(str(paper.get("openalexId", "")))
        doi = normalize_doi(str(paper.get("doi", "")))
        selected, source, status, provider_counts = choose_citation_count(
            paper,
            openalex_works.get(short_id),
            crossref_counts.get(doi),
            semantic_counts.get(doi),
        )
        if status.startswith("openalex-rejected:"):
            rejected_openalex += 1
        if selected == previous and source == collapse_ws(str(paper.get("citationCountSource", ""))) and status == collapse_ws(str(paper.get("citationCountStatus", ""))):
            continue

        paper["citationCount"] = selected
        paper["citationCountSource"] = source
        paper["citationCountCheckedAt"] = checked_at
        if status:
            paper["citationCountStatus"] = status
        else:
            paper.pop("citationCountStatus", None)
        if provider_counts and (status or selected != previous):
            paper["citationCountProviderCounts"] = provider_counts

        changed_rows.append(
            {
                "id": paper.get("id", ""),
                "title": paper.get("title", ""),
                "previous": previous,
                "selected": selected,
                "source": source,
                "status": status,
            }
        )

    print(f"OpenAlex counts rejected by sanity checks: {rejected_openalex}", flush=True)
    print(f"Citation records changed: {len(changed_rows)}", flush=True)
    for row in changed_rows[:20]:
        print(
            f"  {row['previous']} -> {row['selected']} [{row['source']}] {row['status'] or ''} :: {collapse_ws(str(row['title']))}",
            flush=True,
        )

    if args.dry_run:
        print("Dry run: no files written", flush=True)
        return 0

    bundle_changed = save_json(bundle_path, payload)
    manifest_changed = update_manifest(manifest_path, bundle_path) if bundle_changed else False
    report_changed = write_report(Path(args.report).resolve(), changed_rows) if changed_rows else False
    print(f"Bundle changed: {'yes' if bundle_changed else 'no'}", flush=True)
    print(f"Manifest changed: {'yes' if manifest_changed else 'no'}", flush=True)
    print(f"Report changed: {'yes' if report_changed else 'no'}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
