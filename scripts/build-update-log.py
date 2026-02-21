#!/usr/bin/env python3
"""Build/update website update log entries for newly added talks/resources/papers.

Detection model:
  - compares current working tree JSON bundles against HEAD versions in git
  - records only newly added items:
      * talks
      * slides added to an existing talk
      * videos added to an existing talk
      * papers newly added to any papers/*.json bundle
  - collates talk + slides + video into one entry when they appear together
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import subprocess
import urllib.parse
from pathlib import Path


def collapse_ws(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def has_text(value: str | None) -> bool:
    return bool(collapse_ws(str(value or "")))


def load_json_file(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_json_text(raw: str) -> dict:
    return json.loads(raw)


def run_git(repo_root: Path, args: list[str]) -> str:
    proc = subprocess.run(
        ["git", *args],
        cwd=str(repo_root),
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        stderr = collapse_ws(proc.stderr)
        raise RuntimeError(f"git {' '.join(args)} failed: {stderr or 'unknown error'}")
    return proc.stdout


def git_show_head_file(repo_root: Path, rel_path: str) -> str | None:
    proc = subprocess.run(
        ["git", "show", f"HEAD:{rel_path}"],
        cwd=str(repo_root),
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode == 0:
        return proc.stdout
    stderr = collapse_ws(proc.stderr).lower()
    if "does not exist in 'head'" in stderr or "exists on disk, but not in 'head'" in stderr:
        return None
    raise RuntimeError(f"git show HEAD:{rel_path} failed: {collapse_ws(proc.stderr)}")


def list_changed_json_paths(repo_root: Path) -> set[str]:
    changed: set[str] = set()

    diff_text = run_git(repo_root, ["diff", "--name-only", "HEAD", "--", "devmtg/events", "papers"])
    for line in diff_text.splitlines():
        rel = collapse_ws(line)
        if rel:
            changed.add(rel)

    untracked_text = run_git(
        repo_root,
        ["ls-files", "--others", "--exclude-standard", "--", "devmtg/events", "papers"],
    )
    for line in untracked_text.splitlines():
        rel = collapse_ws(line)
        if rel:
            changed.add(rel)

    return {path for path in changed if path.endswith(".json")}


def talk_has_slides(talk: dict) -> bool:
    return has_text(str(talk.get("slidesUrl", "")))


def talk_has_video(talk: dict) -> bool:
    return has_text(str(talk.get("videoUrl", ""))) or has_text(str(talk.get("videoId", "")))


def talk_video_url(talk: dict) -> str:
    explicit = collapse_ws(str(talk.get("videoUrl", "")))
    if explicit:
        return explicit
    vid = collapse_ws(str(talk.get("videoId", "")))
    if vid:
        return f"https://www.youtube.com/watch?v={urllib.parse.quote(vid, safe='')}"
    return ""


def meeting_sort_hint(slug: str) -> str:
    match = re.match(r"^(\d{4})-(\d{2})(?:-(\d{2}))?$", collapse_ws(slug))
    if not match:
        return "0000-00-00"
    year, month, day = match.group(1), match.group(2), match.group(3) or "00"
    return f"{year}-{month}-{day}"


def paper_sort_hint(year: str) -> str:
    clean = collapse_ws(year)
    if re.fullmatch(r"\d{4}", clean):
        return f"{clean}-00-00"
    return "0000-00-00"


def talks_by_id(payload: dict | None) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not payload:
        return out
    talks = payload.get("talks") or []
    if not isinstance(talks, list):
        return out
    for talk in talks:
        if not isinstance(talk, dict):
            continue
        talk_id = collapse_ws(str(talk.get("id", "")))
        if talk_id:
            out[talk_id] = talk
    return out


def papers_by_id(payload: dict | None) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not payload:
        return out
    papers = payload.get("papers") or []
    if not isinstance(papers, list):
        return out
    for paper in papers:
        if not isinstance(paper, dict):
            continue
        paper_id = collapse_ws(str(paper.get("id", "")))
        if paper_id:
            out[paper_id] = paper
    return out


def talk_entry(
    talk: dict,
    parts: list[str],
    logged_at_iso: str,
    site_base: str,
) -> dict:
    talk_id = collapse_ws(str(talk.get("id", "")))
    title = collapse_ws(str(talk.get("title", ""))) or "(Untitled talk)"
    meeting_slug = collapse_ws(str(talk.get("meeting", "")))
    meeting_name = collapse_ws(str(talk.get("meetingName", "")))
    meeting_date = collapse_ws(str(talk.get("meetingDate", "")))
    slides_url = collapse_ws(str(talk.get("slidesUrl", "")))
    video_url = talk_video_url(talk)
    detail_url = f"{site_base}/talk.html?id={urllib.parse.quote(talk_id, safe='')}"

    fingerprint = f"talk:{talk_id}:{','.join(parts)}"
    entry = {
        "kind": "talk",
        "loggedAt": logged_at_iso,
        "sortHint": meeting_sort_hint(meeting_slug),
        "fingerprint": fingerprint,
        "parts": parts,
        "title": title,
        "url": detail_url,
        "talkId": talk_id,
        "meetingSlug": meeting_slug,
        "meetingName": meeting_name,
        "meetingDate": meeting_date,
    }
    if slides_url:
        entry["slidesUrl"] = slides_url
    if video_url:
        entry["videoUrl"] = video_url
    return entry


def paper_entry(paper: dict, logged_at_iso: str, site_base: str) -> dict:
    paper_id = collapse_ws(str(paper.get("id", "")))
    title = collapse_ws(str(paper.get("title", ""))) or "(Untitled paper)"
    year = collapse_ws(str(paper.get("year", "")))
    source = collapse_ws(str(paper.get("sourceName", ""))) or collapse_ws(str(paper.get("source", "")))
    paper_url = collapse_ws(str(paper.get("paperUrl", "")))
    source_url = collapse_ws(str(paper.get("sourceUrl", "")))
    detail_url = f"{site_base}/paper.html?id={urllib.parse.quote(paper_id, safe='')}"

    entry = {
        "kind": "paper",
        "loggedAt": logged_at_iso,
        "sortHint": paper_sort_hint(year),
        "fingerprint": f"paper:{paper_id}",
        "parts": ["paper"],
        "title": title,
        "url": detail_url,
        "paperId": paper_id,
        "year": year,
    }
    if source:
        entry["source"] = source
    if paper_url:
        entry["paperUrl"] = paper_url
    if source_url:
        entry["sourceUrl"] = source_url
    return entry


def sort_entries(entries: list[dict]) -> list[dict]:
    return sorted(
        entries,
        key=lambda entry: (
            collapse_ws(str(entry.get("loggedAt", ""))),
            collapse_ws(str(entry.get("sortHint", ""))),
            collapse_ws(str(entry.get("title", ""))),
        ),
        reverse=True,
    )


def load_existing_log(log_path: Path) -> dict:
    if not log_path.exists():
        return {"entries": []}
    payload = load_json_file(log_path)
    if not isinstance(payload, dict):
        return {"entries": []}
    entries = payload.get("entries")
    if not isinstance(entries, list):
        payload["entries"] = []
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default="/Users/britton/Desktop/library")
    parser.add_argument("--log-json", default="/Users/britton/Desktop/library/devmtg/updates/index.json")
    parser.add_argument("--site-base", default="/devmtg")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    log_json = Path(args.log_json).resolve()
    site_base = "/" + collapse_ws(str(args.site_base)).strip("/")

    changed_json_paths = list_changed_json_paths(repo_root)
    changed_event_paths = sorted(
        path
        for path in changed_json_paths
        if path.startswith("devmtg/events/") and path.endswith(".json") and not path.endswith("index.json")
    )
    changed_paper_paths = sorted(
        path
        for path in changed_json_paths
        if path.startswith("papers/") and path.endswith(".json") and path != "papers/index.json"
    )

    logged_at_iso = _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    new_entries: list[dict] = []

    for rel_path in changed_event_paths:
        abs_path = repo_root / rel_path
        if not abs_path.exists():
            continue

        current_payload = load_json_file(abs_path)
        current_talks = talks_by_id(current_payload)

        prev_raw = git_show_head_file(repo_root, rel_path)
        prev_payload = parse_json_text(prev_raw) if prev_raw else None
        prev_talks = talks_by_id(prev_payload)

        for talk_id, current_talk in current_talks.items():
            prev_talk = prev_talks.get(talk_id)
            parts: list[str] = []

            if prev_talk is None:
                parts.append("talk")
            if talk_has_slides(current_talk) and not talk_has_slides(prev_talk or {}):
                parts.append("slides")
            if talk_has_video(current_talk) and not talk_has_video(prev_talk or {}):
                parts.append("video")

            if parts:
                new_entries.append(talk_entry(current_talk, parts, logged_at_iso, site_base))

    for rel_path in changed_paper_paths:
        abs_path = repo_root / rel_path
        if not abs_path.exists():
            continue

        current_payload = load_json_file(abs_path)
        current_papers = papers_by_id(current_payload)

        prev_raw = git_show_head_file(repo_root, rel_path)
        prev_payload = parse_json_text(prev_raw) if prev_raw else None
        prev_papers = papers_by_id(prev_payload)

        for paper_id, current_paper in current_papers.items():
            if paper_id in prev_papers:
                continue
            new_entries.append(paper_entry(current_paper, logged_at_iso, site_base))

    log_payload = load_existing_log(log_json)
    existing_entries = [entry for entry in (log_payload.get("entries") or []) if isinstance(entry, dict)]
    existing_fingerprints = {
        collapse_ws(str(entry.get("fingerprint", ""))) for entry in existing_entries if collapse_ws(str(entry.get("fingerprint", "")))
    }

    appended = 0
    for entry in new_entries:
        fingerprint = collapse_ws(str(entry.get("fingerprint", "")))
        if not fingerprint or fingerprint in existing_fingerprints:
            continue
        existing_entries.append(entry)
        existing_fingerprints.add(fingerprint)
        appended += 1

    merged_entries = sort_entries(existing_entries)
    existing_data_version = collapse_ws(str(log_payload.get("dataVersion", "")))
    existing_generated_at = collapse_ws(str(log_payload.get("generatedAt", "")))
    should_refresh_metadata = appended > 0 or not log_json.exists()

    next_payload = {
        "dataVersion": (
            _dt.date.today().isoformat() + "-updates-log"
            if should_refresh_metadata
            else (existing_data_version or _dt.date.today().isoformat() + "-updates-log")
        ),
        "generatedAt": (
            logged_at_iso if should_refresh_metadata else (existing_generated_at or logged_at_iso)
        ),
        "entries": merged_entries,
    }

    existing_text = log_json.read_text(encoding="utf-8") if log_json.exists() else ""
    next_text = json.dumps(next_payload, indent=2, ensure_ascii=False) + "\n"
    if existing_text != next_text:
        log_json.parent.mkdir(parents=True, exist_ok=True)
        log_json.write_text(next_text, encoding="utf-8")

    if args.verbose:
        print(f"Changed event bundles considered: {len(changed_event_paths)}")
        print(f"Changed paper bundles considered: {len(changed_paper_paths)}")
        print(f"Raw newly detected entries: {len(new_entries)}")
    print(f"Update log entries appended: {appended}")
    print(f"Update log total entries: {len(merged_entries)}")
    print(f"Update log file: {log_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
