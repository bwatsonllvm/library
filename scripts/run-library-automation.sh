#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PYTHONDONTWRITEBYTECODE="${PYTHONDONTWRITEBYTECODE:-1}"

MODE="${1:-}"
BOT_MAILTO="${LIBRARY_BOT_MAILTO:-llvm-library-bot@users.noreply.github.com}"

usage() {
  cat <<'EOF'
Usage: scripts/run-library-automation.sh <mode>

Modes:
  talks-sync       Sync devmtg talks plus MLIR subproject data, then rebuild if changed.
  papers-sync      Sync blogs, OpenAlex papers, MLIR subproject data, then rebuild if changed.
  manual-paper     Add one manual paper from SOURCE_URL and/or PAPER_JSON, then rebuild.
  validate         Run local code-quality and bundle validation gates.
  prepare-pages    Build the _site directory used by GitHub Pages deploys.

Environment:
  GITHUB_TOKEN                    Optional token passed to GitHub-backed sync scripts.
  LLVM_WWW_REPO                   llvm-www source repo, default llvm/llvm-www.
  LLVM_WWW_REF                    llvm-www source ref, default main.
  DEVMTG_ONLY_SLUG                Optional single devmtg meeting slug for talks-sync.
  LLVM_BLOG_REPO                  blog source repo, default llvm/llvm-blog-www.
  LLVM_BLOG_REF                   blog source ref, default main.
  OPENALEX_MAX_PAGES_PER_KEYWORD  OpenAlex keyword page cap, default 5.
  OPENALEX_PER_PAGE               OpenAlex page size, default 200.
  SOURCE_URL                      Manual-paper source URL.
  PAPER_JSON                      Manual-paper JSON payload.
  PAPER_JSON_FILE                 Manual-paper JSON payload file.
  OVERRIDES_JSON                  Manual-paper JSON overrides.
EOF
}

log() {
  printf '\n==> %s\n' "$*"
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

run() {
  local label="$1"
  if [[ "$#" -ge 2 ]]; then
    label+=" $2"
  fi
  log "$label"
  "$@"
}

set_has_changes_output() {
  local value="$1"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "has_changes=${value}" >> "$GITHUB_OUTPUT"
  fi
}

has_worktree_changes() {
  [[ -n "$(git status --porcelain)" ]]
}

sync_mlir_subproject() {
  run python3 scripts/sync-mlir-subproject.py --repo-root .
}

refresh_talk_reference_links() {
  local changed_paths=()
  local meetings=()
  local mlir_changed="false"

  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    changed_paths+=("$path")
    if [[ "$path" == "sub-projects/mlir/data/talks.json" ]]; then
      mlir_changed="true"
      continue
    fi
    if [[ "$path" =~ ^devmtg/events/([0-9]{4}-[0-9]{2}(-[0-9]{2})?)\.json$ ]]; then
      meetings+=("${BASH_REMATCH[1]}")
    fi
  done < <(
    {
      git diff --name-only -- 'devmtg/events/*.json' 'sub-projects/mlir/data/talks.json'
      git ls-files --others --exclude-standard -- 'devmtg/events/*.json' 'sub-projects/mlir/data/talks.json'
    } | sort -u
  )

  if [[ "${#changed_paths[@]}" -eq 0 ]]; then
    log "No changed talk bundles; keeping existing talk-paper links"
    return 0
  fi

  local args=(
    --repo-root .
    --output js/data/talk-paper-links.json
    --fetch-pdf-references
    --include-mlir
  )

  if [[ "$mlir_changed" != "true" && "${#meetings[@]}" -gt 0 ]]; then
    local seen=" "
    local meeting
    for meeting in "${meetings[@]}"; do
      if [[ "$seen" == *" ${meeting} "* ]]; then
        continue
      fi
      seen+="${meeting} "
      args+=(--meeting "$meeting")
    done
  fi

  run python3 scripts/generate-talk-paper-links.py "${args[@]}"
}

rebuild_generated_if_changed() {
  if ! has_worktree_changes; then
    log "No content changes detected"
    set_has_changes_output "false"
    return 0
  fi

  run python3 scripts/build-update-log.py --repo-root . --log-json updates/index.json
  run scripts/build-viewer-artifacts.sh
  run scripts/validate-library-bundle.sh

  if has_worktree_changes; then
    set_has_changes_output "true"
  else
    set_has_changes_output "false"
  fi
}

run_talks_sync() {
  local token_args=()
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    token_args=(--github-token "$GITHUB_TOKEN")
  fi

  local sync_args=(
    --events-dir devmtg/events
    --manifest devmtg/events/index.json
    --repo "${LLVM_WWW_REPO:-llvm/llvm-www}"
    --ref "${LLVM_WWW_REF:-main}"
  )
  if [[ -n "${DEVMTG_ONLY_SLUG:-}" ]]; then
    sync_args+=(--only-slug "$DEVMTG_ONLY_SLUG")
  fi
  sync_args+=("${token_args[@]}")

  run python3 scripts/sync-devmtg-from-llvm-www.py "${sync_args[@]}"
  sync_mlir_subproject
  run python3 scripts/sanitize-library-urls.py --repo-root .
  refresh_talk_reference_links
  rebuild_generated_if_changed
}

run_papers_sync() {
  local token_args=()
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    token_args=(--github-token "$GITHUB_TOKEN")
  fi

  run python3 scripts/sync-blog-from-llvm-www-blog.py \
    --repo "${LLVM_BLOG_REPO:-llvm/llvm-blog-www}" \
    --ref "${LLVM_BLOG_REF:-main}" \
    --output papers/llvm-blog-posts.json \
    --cache-dir papers/.cache/llvm-blog \
    --blog-base-url "https://blog.llvm.org/" \
    --preserve-existing-metadata \
    "${token_args[@]}"

  sync_mlir_subproject

  run python3 scripts/build-openalex-discovery.py \
    --events-dir devmtg/events \
    --papers-dir papers \
    --index-json papers/index.json \
    --app-js js/app.js \
    --subprojects-file papers/subproject-seeds.txt \
    --skip-author-queries \
    --max-pages-per-keyword "${OPENALEX_MAX_PAGES_PER_KEYWORD:-5}" \
    --per-page "${OPENALEX_PER_PAGE:-200}" \
    --preserve-existing-metadata \
    --mailto "$BOT_MAILTO"

  run python3 scripts/generate-openalex-update-summary.py \
    --repo-root . \
    --bundle papers/openalex-llvm-query.json \
    --output updates/openalex-update-summary.md \
    --skip-when-unchanged

  run python3 scripts/build-single-papers-db.py \
    --output papers/combined-all-papers-deduped.json \
    --manifest papers/index.json \
    --cache-dir papers/.cache/openalex \
    --landing-cache papers/.cache/openalex-landing-enrichment.json \
    --batch-size 40 \
    --landing-timeout 5 \
    --landing-max-probes 120 \
    --landing-miss-recheck-days 30 \
    --mailto "$BOT_MAILTO"

  run python3 scripts/backfill-openalex-unpaywall-pdfs.py \
    --bundle papers/combined-all-papers-deduped.json \
    --manifest papers/index.json \
    --cache papers/.cache/unpaywall-pdf-links.json \
    --mailto "$BOT_MAILTO"

  run python3 scripts/sanitize-library-urls.py --repo-root .
  rebuild_generated_if_changed
}

run_manual_paper() {
  local add_args=()
  if [[ -n "${SOURCE_URL:-}" ]]; then
    add_args+=(--source-url "$SOURCE_URL")
  fi
  if [[ -n "${PAPER_JSON_FILE:-}" ]]; then
    add_args+=(--paper-json-file "$PAPER_JSON_FILE")
  fi
  if [[ -n "${PAPER_JSON:-}" ]]; then
    add_args+=(--paper-json "$PAPER_JSON")
  fi
  if [[ -n "${OVERRIDES_JSON:-}" ]]; then
    add_args+=(--overrides-json "$OVERRIDES_JSON")
  fi

  if [[ "${#add_args[@]}" -eq 0 ]]; then
    fail "manual-paper requires SOURCE_URL, PAPER_JSON, or PAPER_JSON_FILE"
  fi

  run python3 scripts/add-manual-paper.py "${add_args[@]}"
  run python3 scripts/sanitize-library-urls.py --repo-root .
  rebuild_generated_if_changed
}

run_validate() {
  run bash scripts/validate-code-quality.sh
  run scripts/validate-library-bundle.sh
}

run_prepare_pages() {
  run rm -rf _site
  run mkdir -p _site/papers _site/devmtg
  run cp index.html work.html _site/
  run cp -R talks blogs people mlir sub-projects about updates css js images _site/
  run rsync -a --exclude '.cache/' papers/ _site/papers/
  run cp -R devmtg/events _site/devmtg/
  run test -f _site/mlir/index.html
  run test -f _site/mlir/talks/index.html
  run test -f _site/mlir/talks/talk.html
  run test -f _site/mlir/pubs/index.html
  run test -f _site/sub-projects/index.html
  run test -f _site/sub-projects/mlir/index.html
}

case "$MODE" in
  talks-sync)
    run_talks_sync
    ;;
  papers-sync)
    run_papers_sync
    ;;
  manual-paper)
    run_manual_paper
    ;;
  validate)
    run_validate
    ;;
  prepare-pages)
    run_prepare_pages
    ;;
  -h|--help|help)
    usage
    ;;
  "")
    usage
    exit 1
    ;;
  *)
    usage
    fail "unknown automation mode: $MODE"
    ;;
esac
