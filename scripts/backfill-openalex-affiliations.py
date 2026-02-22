#!/usr/bin/env python3
"""Backfill paper author affiliations from OpenAlex works metadata.

Usage:
  ./scripts/backfill-openalex-affiliations.py \
    --bundle /Users/britton/Desktop/library/papers/combined-all-papers-deduped.json \
    --bundle /Users/britton/Desktop/library/papers/openalex-discovered.json \
    --manifest /Users/britton/Desktop/library/papers/index.json
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import subprocess
import time
import unicodedata
from pathlib import Path
from typing import Iterable
from urllib.parse import urlencode

OPENALEX_WORKS_API = "https://api.openalex.org/works"
MISSING_TOKENS = {
    "",
    "-",
    "--",
    "none",
    "null",
    "nan",
    "n/a",
    "na",
    "unknown",
    "no affiliation",
    "not available",
}


def _load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        payload = json.load(fh)
    if not isinstance(payload, dict):
        raise ValueError(f"{path}: expected JSON object")
    return payload


def _save_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _collapse_ws(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _normalize_affiliation(value: str) -> str:
    clean = _collapse_ws(value).strip(" ,;|")
    clean = re.sub(r"\s+,", ",", clean)
    clean = re.sub(r"\(\s+", "(", clean)
    clean = re.sub(r"\s+\)", ")", clean)
    if clean.casefold() in MISSING_TOKENS:
        return ""
    return clean


def _openalex_short_id(openalex_id: str) -> str:
    raw = (openalex_id or "").strip()
    if not raw:
        return ""
    suffix = raw.rstrip("/").rsplit("/", 1)[-1].strip().upper()
    if not re.fullmatch(r"W\d+", suffix):
        return ""
    return suffix


def _normalize_name_key(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value or "")
    folded = "".join(ch for ch in folded if unicodedata.category(ch) != "Mn")
    folded = _collapse_ws(folded).lower()
    folded = re.sub(r"[^a-z0-9 ]+", " ", folded)
    return _collapse_ws(folded)


def _name_signature(value: str) -> str:
    key = _normalize_name_key(value)
    tokens = key.split()
    if not tokens:
        return ""
    first = tokens[0][:1]
    last = tokens[-1]
    if not first or not last:
        return ""
    return f"{last}|{first}"


def _name_last_token(value: str) -> str:
    key = _normalize_name_key(value)
    if not key:
        return ""
    return key.split()[-1]


def _iter_works(payload: dict) -> Iterable[dict]:
    results = payload.get("results")
    if isinstance(results, list):
        for item in results:
            if isinstance(item, dict):
                yield item
    elif isinstance(payload.get("id"), str):
        yield payload


def _collect_short_ids_from_bundles(bundle_payloads: list[tuple[Path, dict]]) -> list[str]:
    out: set[str] = set()
    for path, payload in bundle_payloads:
        papers = payload.get("papers")
        if not isinstance(papers, list):
            raise ValueError(f"{path}: missing papers array")
        for paper in papers:
            if not isinstance(paper, dict):
                continue
            short_id = _openalex_short_id(str(paper.get("openalexId", "")))
            if short_id:
                out.add(short_id)
    return sorted(out)


def _load_works_from_cache(cache_dir: Path, wanted_ids: set[str]) -> dict[str, dict]:
    works: dict[str, dict] = {}
    if not cache_dir.exists():
        return works

    for path in sorted(cache_dir.glob("*.json")):
        try:
            payload = _load_json(path)
        except Exception:
            continue
        for work in _iter_works(payload):
            short_id = _openalex_short_id(str(work.get("id", "")))
            if not short_id or short_id not in wanted_ids or short_id in works:
                continue
            works[short_id] = work
    return works


def _chunks(items: list[str], size: int) -> Iterable[list[str]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _fetch_openalex_works(short_ids: list[str], batch_size: int, mailto: str = "") -> dict[str, dict]:
    if not short_ids:
        return {}

    works: dict[str, dict] = {}
    total_batches = len(list(_chunks(short_ids, batch_size)))

    for idx, batch in enumerate(_chunks(short_ids, batch_size), start=1):
        params = {
            "filter": f"openalex:{'|'.join(batch)}",
            "per-page": str(len(batch)),
            "select": "id,authorships",
        }
        if mailto:
            params["mailto"] = mailto
        url = f"{OPENALEX_WORKS_API}?{urlencode(params)}"
        cmd = [
            "curl",
            "-sS",
            "--retry",
            "5",
            "--retry-all-errors",
            "--connect-timeout",
            "20",
            "--max-time",
            "90",
            "-A",
            "library-openalex-affiliations-backfill/1.0",
            url,
        ]
        proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
        payload = json.loads(proc.stdout)
        for work in _iter_works(payload):
            short_id = _openalex_short_id(str(work.get("id", "")))
            if short_id:
                works[short_id] = work
        print(f"[openalex] fetched batch {idx}/{total_batches} ({len(batch)} ids)", flush=True)
        time.sleep(0.08)

    return works


def _extract_authorships(work: dict) -> list[dict]:
    out: list[dict] = []
    authorships = work.get("authorships")
    if not isinstance(authorships, list):
        return out

    for authorship in authorships:
        if not isinstance(authorship, dict):
            continue
        author = authorship.get("author")
        if not isinstance(author, dict):
            continue
        name = _collapse_ws(str(author.get("display_name", "")))
        if not name:
            continue

        affiliation = ""
        institutions = authorship.get("institutions")
        if isinstance(institutions, list):
            for institution in institutions:
                if not isinstance(institution, dict):
                    continue
                display_name = _normalize_affiliation(str(institution.get("display_name", "")))
                if display_name:
                    affiliation = display_name
                    break

        out.append(
            {
                "name": name,
                "name_key": _normalize_name_key(name),
                "signature": _name_signature(name),
                "last": _name_last_token(name),
                "affiliation": affiliation,
            }
        )
    return out


def _compatible_last_names(left: str, right: str) -> bool:
    if not left or not right:
        return False
    if left == right:
        return True
    return left.endswith(right) or right.endswith(left)


def _apply_affiliations_to_paper(paper: dict, work: dict) -> dict[str, int]:
    authors = paper.get("authors")
    if not isinstance(authors, list):
        return {
            "authors_total": 0,
            "authors_matched": 0,
            "authors_openalex_applied": 0,
            "authors_cleaned_only": 0,
            "fields_changed": 0,
        }

    authorships = _extract_authorships(work)
    if not authorships:
        return {
            "authors_total": len(authors),
            "authors_matched": 0,
            "authors_openalex_applied": 0,
            "authors_cleaned_only": 0,
            "fields_changed": 0,
        }

    locals_meta: list[dict] = []
    for idx, local in enumerate(authors):
        if not isinstance(local, dict):
            continue
        name = _collapse_ws(str(local.get("name", "")))
        locals_meta.append(
            {
                "index": idx,
                "name_key": _normalize_name_key(name),
                "signature": _name_signature(name),
                "last": _name_last_token(name),
            }
        )

    matched: dict[int, int] = {}
    used_authorship_idx: set[int] = set()

    # Pass 1: exact normalized-name match.
    for local in locals_meta:
        local_idx = int(local["index"])
        local_key = str(local["name_key"])
        if not local_key:
            continue
        candidates = [
            idx
            for idx, oa in enumerate(authorships)
            if idx not in used_authorship_idx and oa["name_key"] == local_key
        ]
        if len(candidates) == 1:
            chosen = candidates[0]
            matched[local_idx] = chosen
            used_authorship_idx.add(chosen)

    # Pass 2: last-name + first-initial signature.
    for local in locals_meta:
        local_idx = int(local["index"])
        if local_idx in matched:
            continue
        signature = str(local["signature"])
        if not signature:
            continue
        candidates = [
            idx
            for idx, oa in enumerate(authorships)
            if idx not in used_authorship_idx and oa["signature"] == signature
        ]
        if len(candidates) == 1:
            chosen = candidates[0]
            matched[local_idx] = chosen
            used_authorship_idx.add(chosen)

    # Pass 3: positional fallback when author counts align and last names are compatible.
    if len(locals_meta) == len(authorships):
        for local in locals_meta:
            local_idx = int(local["index"])
            if local_idx in matched:
                continue
            if local_idx >= len(authorships) or local_idx in used_authorship_idx:
                continue
            local_last = str(local["last"])
            oa_last = str(authorships[local_idx]["last"])
            if _compatible_last_names(local_last, oa_last):
                matched[local_idx] = local_idx
                used_authorship_idx.add(local_idx)

    authors_total = 0
    authors_matched = 0
    authors_openalex_applied = 0
    authors_cleaned_only = 0
    fields_changed = 0

    for idx, local in enumerate(authors):
        if not isinstance(local, dict):
            continue
        authors_total += 1
        before = str(local.get("affiliation", ""))
        cleaned_before = _normalize_affiliation(before)
        new_affiliation = cleaned_before
        changed_by_openalex = False

        if idx in matched:
            authors_matched += 1
            oa_affiliation = str(authorships[matched[idx]]["affiliation"])
            if oa_affiliation:
                new_affiliation = oa_affiliation
                changed_by_openalex = True

        if new_affiliation != before:
            local["affiliation"] = new_affiliation
            fields_changed += 1
            if changed_by_openalex:
                authors_openalex_applied += 1
            else:
                authors_cleaned_only += 1

    return {
        "authors_total": authors_total,
        "authors_matched": authors_matched,
        "authors_openalex_applied": authors_openalex_applied,
        "authors_cleaned_only": authors_cleaned_only,
        "fields_changed": fields_changed,
    }


def _apply_affiliations_to_bundle(payload: dict, works_by_id: dict[str, dict]) -> dict[str, int]:
    papers = payload.get("papers")
    if not isinstance(papers, list):
        raise ValueError("bundle missing papers array")

    stats = {
        "papers_total": len(papers),
        "papers_with_openalex_id": 0,
        "papers_with_work_loaded": 0,
        "authors_total": 0,
        "authors_matched": 0,
        "authors_openalex_applied": 0,
        "authors_cleaned_only": 0,
        "fields_changed": 0,
        "papers_changed": 0,
    }

    for paper in papers:
        if not isinstance(paper, dict):
            continue
        short_id = _openalex_short_id(str(paper.get("openalexId", "")))
        if not short_id:
            continue
        stats["papers_with_openalex_id"] += 1
        work = works_by_id.get(short_id)
        if not work:
            continue
        stats["papers_with_work_loaded"] += 1

        before_blob = json.dumps(paper.get("authors"), ensure_ascii=False, sort_keys=True)
        per_paper = _apply_affiliations_to_paper(paper, work)
        after_blob = json.dumps(paper.get("authors"), ensure_ascii=False, sort_keys=True)

        for key in ["authors_total", "authors_matched", "authors_openalex_applied", "authors_cleaned_only", "fields_changed"]:
            stats[key] += int(per_paper[key])
        if before_blob != after_blob:
            stats["papers_changed"] += 1

    return stats


def _update_manifest_version(manifest_path: Path) -> str:
    payload = _load_json(manifest_path)
    today = _dt.date.today().isoformat()
    data_version = f"{today}-papers-openalex-affiliations-v1"
    payload["dataVersion"] = data_version
    _save_json(manifest_path, payload)
    return data_version


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bundle",
        dest="bundles",
        action="append",
        required=True,
        help="Path to a papers JSON bundle (repeat for multiple files).",
    )
    parser.add_argument(
        "--cache-dir",
        default="/Users/britton/Desktop/library/papers/.cache/openalex",
        help="Directory of cached OpenAlex responses.",
    )
    parser.add_argument(
        "--manifest",
        default="",
        help="Optional papers/index.json path to update dataVersion.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=40,
        help="OpenAlex API batch size for missing work ids.",
    )
    parser.add_argument(
        "--mailto",
        default="",
        help="Optional contact email for OpenAlex polite pool.",
    )
    parser.add_argument(
        "--skip-network",
        action="store_true",
        help="Do not call OpenAlex API; only use local cache.",
    )
    args = parser.parse_args()

    if args.batch_size <= 0:
        raise SystemExit("--batch-size must be > 0")

    bundle_paths = [Path(p).resolve() for p in args.bundles]
    bundle_payloads: list[tuple[Path, dict]] = []
    for path in bundle_paths:
        if not path.exists():
            raise SystemExit(f"Missing bundle file: {path}")
        bundle_payloads.append((path, _load_json(path)))

    short_ids = _collect_short_ids_from_bundles(bundle_payloads)
    wanted_ids = set(short_ids)
    print(f"Unique OpenAlex ids in bundles: {len(short_ids)}")

    cache_dir = Path(args.cache_dir).resolve()
    works_by_id = _load_works_from_cache(cache_dir, wanted_ids)
    print(f"OpenAlex works resolved from cache: {len(works_by_id)}")

    missing = sorted(wanted_ids - set(works_by_id.keys()))
    print(f"OpenAlex ids missing after cache scan: {len(missing)}")

    fetched = {}
    if missing and not args.skip_network:
        fetched = _fetch_openalex_works(missing, batch_size=args.batch_size, mailto=args.mailto.strip())
        works_by_id.update(fetched)
        print(f"OpenAlex works fetched from API: {len(fetched)}")
    elif missing and args.skip_network:
        print("Skipping network fetch (--skip-network enabled)")

    print(f"OpenAlex works available total: {len(works_by_id)}")

    for path, payload in bundle_payloads:
        stats = _apply_affiliations_to_bundle(payload, works_by_id)
        _save_json(path, payload)
        print(
            "Updated bundle: "
            f"{path} | papers_total={stats['papers_total']} "
            f"papers_with_openalex_id={stats['papers_with_openalex_id']} "
            f"papers_with_work_loaded={stats['papers_with_work_loaded']} "
            f"papers_changed={stats['papers_changed']} "
            f"authors_total={stats['authors_total']} "
            f"authors_matched={stats['authors_matched']} "
            f"authors_openalex_applied={stats['authors_openalex_applied']} "
            f"authors_cleaned_only={stats['authors_cleaned_only']} "
            f"fields_changed={stats['fields_changed']}",
            flush=True,
        )

    if args.manifest:
        manifest_path = Path(args.manifest).resolve()
        if not manifest_path.exists():
            raise SystemExit(f"Missing manifest file: {manifest_path}")
        data_version = _update_manifest_version(manifest_path)
        print(f"Updated manifest dataVersion: {data_version}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
