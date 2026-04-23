# LLVM Research Library

Public site: https://llvm.org/devmtg/

This repository contains the data and static web assets for the LLVM Research Library.

## What This Library Is

The library is a searchable index of:
- LLVM Developers' Meeting talks
- LLVM-related papers
- Combined people records (speakers + authors)
- A chronological update log of newly added content

It is designed as a public, online reference site.

## Architecture Contract (2 Parts)

This repository is intentionally split into two clean layers:

1. Viewer layer (`html/css/js`):
   - static pages and client-side rendering only
   - consumes prebuilt artifacts
   - avoids heavy runtime indexing/build work in the browser
2. Updater layer (`scripts/` + CI workflows):
   - fetches and normalizes upstream data
   - generates derived artifacts (updates log, docs search indexes, autocomplete index)
   - enforces consistency checks (shell sync + asset version stamps + bundle/schema checks)

Design goal: keep the viewer fast and simple, and keep all heavy/complex logic in updater scripts.

## Search And Discovery Experience (Updated February 24, 2026)

Search now uses a shared, relevance-first stack intended to work for both LLVM newcomers and advanced researchers.

### Search All autocomplete and query routing

- All `.global-search-form` inputs use a shared autocomplete index sourced from talks, papers/blogs, people, and key topics.
- Home, section pages (`talks/`, `papers/`, `blogs/`, `people/`), detail pages, `about/`, and `work.html` now all use the shared `js/shared/global-search.js` component for a unified search-bar UX.
- Advanced search is now available from every shared search bar (not only `work.html`):
  - fields: all words, exact phrase, any words, without words, where words occur, author, publication, year range
  - section pages default advanced scope to the active section (`talks`, `papers`, `blogs`, `people`) with a switch to `All`
  - when advanced fields are active, submit is forced to Search All so constraints are applied by the shared ranking model
- Search behavior is route-aware:
  - home/about/detail/work routes default to **Search All** (`work.html?mode=search&q=...`)
  - section index pages (`talks/`, `papers/`, `blogs/`, `people/`) default to contextual local filtering
  - section pages still expose explicit **Run Search All** action in the shared dropdown to jump to cross-library results
- Browsing remains available as secondary behavior through section filters/chips/card actions (for example, topic chips and sidebar facets).
- Suggestions are grouped into:
  - Key Topics
  - Speakers + Authors
  - Talk Titles
  - Paper + Blog Titles
  - A direct action to search the entire library
- Autocomplete ranking uses `rankAutocompleteEntries` (shared utility) with:
  - exact/prefix/contains boosts
  - popularity weighting
  - fuzzy tolerance
- Search placeholders and labels are standardized to global-library wording so behavior is consistent across routes.

### Relevance ranking model

Shared ranking helpers in `js/shared/library-utils.js` power core search behavior:

- Query normalization:
  - case/diacritics normalization
  - token aliasing and synonym expansion
  - stopword handling and lightweight stemming
  - quoted phrase parsing
  - advanced operators: `author:`, `topic:`, `venue:`, `year:`, `since:`, `before:`, and `-exclude`
- Fuzzy robustness:
  - subsequence matching
  - bounded Levenshtein distance for typo tolerance
- Weighted field scoring:
  - talks: title, speakers, tags, meeting metadata, abstract, category, year
  - papers/blogs: title, authors, topics, publication/venue, abstract, body/content text, year
- Coverage-aware gating:
  - broad tokens (like `llvm`, `paper`, `talk`) are de-emphasized as required matches when narrow terms exist
  - stricter required-clause thresholds for longer, specific queries
  - relaxed fallback only when strict matching returns nothing
- Lower-noise synonym handling:
  - low-signal expansions are filtered
  - beginner-intent expansions prioritize `intro/introduction/tutorial` over generic terms
- Tie-break and quality boosts for recency, citations (papers/blogs), and beginner-intent queries.
- Constraint-aware filtering:
  - positive/negative field constraints are enforced during scoring (not only soft-boosted)
  - year-range constraints can be expressed in-query and from UI controls
  - low-confidence tails are pruned so broad queries do not collapse to near-catalog results
- Shared rankers (`rankTalksByQuery`, `rankPaperRecordsByQuery`) are now used consistently across talks, papers/blogs, and global work search surfaces.

### Advanced query syntax

- Supported patterns:
  - exact phrase: `"MLIR-based code generation for GPU tensor cores"`
  - author constraint: `author:chris lattner`
  - topic constraint: `topic:mlir`
  - venue constraint: `venue:arxiv`
  - year filters: `since:2025`, `before:2022`, `year:2024`, `year:2022-2025`
  - exclusion: `mlir -cuda`, `topic:mlir -topic:openmp`
- These operators work in Search All (`work.html?mode=search`) for talks, papers, blogs, and cross-type `All` mode.
- `work.html` now also exposes a Google-style **Advanced** search panel with explicit fields:
  - Find articles with all of the words
  - With the exact phrase
  - With at least one of the words
  - Without the words
  - Where my words occur (`Anywhere`, `In title`, `In abstract/content`)
  - Return articles authored by
  - Return articles published in
  - Return articles dated between (`From year` / `To year`)
- Advanced panel values are translated into the shared ranking/filter model (not UI-only post-filters), so the same constraints drive talk, paper/blog, people, and universal relevance ordering.

### Context-aware result previews

- Result cards now show query-centered snippets instead of only leading text.
- Snippets are extracted from the full searchable body when available:
  - talks: abstracts
  - papers/blogs: abstract + on-repo body/content/markdown/html fields
- Matched terms remain highlighted in these snippets to make relevance transparent for both novice and advanced queries.

### Results controls across pages

- `talks/`: sort (`relevance`, `newest`, `oldest`, `title`) + `grid/list` view toggle.
- `papers/` and `blogs/`: sort (`relevance`, `year`, `citations`) + `grid/list` view toggle.
- `papers/` adds sidebar filters for:
  - citation buckets
  - publications
  - affiliations
  - all persisted in URL state
- `work.html` (global/entity combined results):
  - search scope toggle in Search All mode: `All`, `Talks`, `Papers`, `Blogs`, `Docs`, `People` (default `All`)
  - time filter in Search All mode: `Any time`, `Since 2026`, `Since 2025`, `Since 2022`, `Custom range`
  - `Advanced` panel for structured Google-style constraints (all/exact/any/without words, where words occur, author, publication, dated between)
  - advanced toggle always shows explicit state (`Advanced On` / `Advanced Off`)
  - sort (`relevance`, `newest`, `oldest`, `title`, `citations`)
  - in Search All mode (`mode=search`), results are interleaved across talks/papers/blogs/people by cross-type relevance (not fixed by content type)
  - exact/prefix title intent gets additional boost so precise queries surface the best matching item first, regardless of type
  - people ranking combines direct query-name matching with cross-reference context from matched talks/papers/blogs so relevant people surface for both name and topic queries
  - `expanded/compact` view toggle across talks, papers, blogs, and people sections
  - URL-state support for `sort`, `view`, `scope`, `time`, `yearFrom`, and `yearTo`, with mode-aware defaults
- `people/`:
  - sort (`works`, `citations`, `alpha`, `alpha-desc`)
  - `expanded/compact` view toggle

### URL/state behavior

- `work.html` supports:
  - `mode=search&q=...` for global query mode
  - optional `scope=all|talks|papers|blogs|docs|people` in search mode to focus results by content type
  - optional `time=any|since-2026|since-2025|since-2022|custom` in search mode
  - optional `yearFrom=YYYY&yearTo=YYYY` for custom ranges (`time=custom`)
  - optional advanced-search params in search mode:
    - `allWords=...`
    - `exactPhrase=...`
    - `anyWords=...`
    - `withoutWords=...`
    - `where=anywhere|title|abstract`
    - `author=...`
    - `publication=...`
  - `mode=entity&kind=speaker|topic&value=...` for entity mode (All Work)
  - `from=talks|papers|blogs|people|work` for back-link context
  - `sort=...` and `view=expanded|compact`
- Default Work sort is:
  - `relevance` in search mode
  - `newest` in entity mode
- View preferences are persisted in local storage:
  - `llvm-hub-view` (talks/papers/blogs grid/list)
  - `llvm-hub-work-view` (work expanded/compact)
  - `llvm-hub-people-view` (people expanded/compact)
- `papers/` and `blogs/` additionally support:
  - `cite=<bucket,...>` citation filters (`500+`, `100-499`, `50-99`, `10-49`, `1-9`, `0`)
  - `pub=<normalized-publication-key,...>`
  - `aff=<normalized-affiliation-key,...>`

### Terminology: All Work vs Search All

- **Search All**: free-text, cross-library ranking mode (`work.html?mode=search&q=...`).
- Section pages search locally by default; Search All is invoked explicitly from the shared search-dropdown action.
- **All Work**: entity aggregation mode for a speaker or key topic (`work.html?mode=entity&kind=...&value=...`).

## How The Database Is Constructed

### 1) Talks dataset (`devmtg/events/*.json`)

Talk records are synchronized from public LLVM Developers' Meeting pages under `llvm-www/devmtg`.
The sync process preserves the current JSON schema and is intentionally conservative:
- existing matched talk records are left as-is so manual curation is not overwritten
- newly discovered talks are appended to existing meeting bundles
- brand-new or upstream-changed meeting folders are the only ones reprocessed automatically

When a meeting is synchronized, structured fields such as the following are populated for newly created records:
- talk id, meeting id, title, abstract
- speaker list
- slides URL and video URL/ID
- normalized category and tags

### 2) Papers dataset (`papers/combined-all-papers-deduped.json`)

The canonical papers database combines three public sources:
- LLVM publications content from `llvm.org/pubs` (canonical LLVM papers)
- OpenAlex discovery results for LLVM-related research
- LLVM Project Blog posts from `llvm/llvm-blog-www`

OpenAlex discovery is constrained by LLVM-focused keyword and subproject matching, then filtered against known library contributors derived from existing talk/paper records.

Subproject parsing and seed aliases now include deeper LLVM project coverage, including:
- `bolt`, `clang-tools-extra`, `clang`, `cmake`, `compiler-rt`, `cross-project-tests`
- `flang-rt`, `flang`, `libc`, `libclc`, `libcxx`, `libcxxabi`, `libsycl`, `libunwind`
- `lld`, `lldb`, `llvm-libgcc`, `llvm`, `mlir`, `offload`, `openmp`, `orc-rt`, `polly`, `runtimes`

The automated pipeline does not rely on a repository-maintained direct-name seed list.
During the final merge, OpenAlex metadata is refreshed for titles, abstracts, authors, affiliations, citation counts, and URLs. For non-English or missing text, the pipeline also probes deeper landing-page metadata layers to recover English title/abstract when available.
Blog entries are sourced directly from the blog repository and linked to their post files in GitHub, with the canonical blog URL also retained.
Discovery output is treated as an intermediate input; the final single-database build is the stage that updates `papers/index.json`.

### 3) People index (runtime derived)

People records are not a separate hand-curated database file. They are built from talk speakers and paper authors, with name normalization and merge rules to reduce duplicate variants.

### 4) Update log (`updates/index.json`)

The update log is generated from content deltas and records newly added:
- talks
- slides/video additions
- papers
- blog posts

Entries are sorted newest to oldest and linked to in-library detail pages.

## Data Scope And Limits

- All indexed source material is public.
- The site is a research index, not a replacement for official event pages.
- External links (slides, videos, papers, DOIs) can change or disappear over time.
- Name normalization reduces duplicates but cannot guarantee perfect entity resolution.

For canonical meeting schedules and announcements, use the official archive: https://llvm.org/devmtg/

## Automation

Workflow logic is centralized in `scripts/run-library-automation.sh` so GitHub Actions and local maintenance use the same program pipeline.

Automated PR workflows:

1. Talks sync (`.github/workflows/library-umbrella-sync.yml`)
   - runs on demand or via cross-repo `repository_dispatch`
   - expected dispatch type: `llvm-www-pr-approved`
   - intended source repo: `llvm/llvm-www`
   - syncs talks/slides/videos from `llvm-www/devmtg`
   - syncs MLIR subproject talk/publication data used by shared views
   - refreshes slide-derived talk/paper references for changed talk bundles
   - rebuilds the updates log and viewer artifacts when content changed

2. Papers sync (`.github/workflows/library-papers-sync.yml`)
   - runs nightly or on demand
   - syncs LLVM blog posts from `llvm-blog-www`
   - syncs MLIR subproject talk/publication data used by shared views
   - refreshes OpenAlex-discovered papers
   - rebuilds the canonical papers collation
   - backfills direct paper PDF links via OpenAlex + Unpaywall
   - rebuilds the updates log and viewer artifacts when content changed

Manual intake workflow:

1. Manual paper intake (`.github/workflows/manual-paper-pr.yml`)
   - accepts `source_url`, full `paper_json`, or both with `overrides_json`
   - appends one normalized record into `papers/manual-added-papers.json`
   - rebuilds the updates log and viewer artifacts

## Validation And Test Gates

CI now runs two validation layers before merge/deploy:

1. Code-quality checks (`scripts/validate-code-quality.sh`)
   - `python3 -m compileall -q scripts`
   - `ruff check scripts`
   - `bash -n scripts/*.sh`
   - `node --test tests`
2. Bundle/data checks (`scripts/validate-library-bundle.sh`)
   - validates generated viewer artifacts are synchronized (`scripts/build-viewer-artifacts.sh --check`)

Search relevance behavior is covered by deterministic regression tests in:
- `tests/search-ranking.test.cjs`

The full validation pair runs in:
- `.github/workflows/library-validate.yml` (PR validation)
- `.github/workflows/pages.yml` (deploy gate)

Automated PR workflows (`library-umbrella-sync.yml`, `library-papers-sync.yml`, and `manual-paper-pr.yml`) run bundle validation after regenerating content; the resulting PR then goes through the full PR validation workflow before merge.

The talks sync workflow is a receiver only. To trigger it automatically from `llvm/llvm-www`, that repository must send a `repository_dispatch` event with type `llvm-www-pr-approved` to this repository.

## Repository Layout

- `index.html`, `work.html`, and section folders (`talks/`, `papers/`, `blogs/`, `people/`, `mlir/`, `sub-projects/`, `about/`, `updates/`): static site pages/routes
- `css/`, `js/`, `images/`: shared site assets
- `js/data/autocomplete-index.json`: prebuilt lightweight autocomplete payload consumed by header/global search
- `devmtg/events/*.json`: talk/event records
- `devmtg/events/index.json`: event manifest + data version
- `updates/index.json`: update-log dataset
- `papers/*.json`: source and derived paper bundles (site serves the manifest-listed file)
- `papers/index.json`: paper manifest + data version
- `papers/manual-added-papers.json`: curated manual-paper bundle for records that should stay separate from upstream source feeds
- `papers/key-topic-canonical.json`: updater-owned canonical key-topic vocabulary used by paper/discovery scripts
- `scripts/`: ingestion, normalization, and validation tooling
- `templates/site-header.html`: canonical shared site header template for viewer pages

Key viewer-artifact generators:
- `scripts/build-viewer-artifacts.sh`: runs all viewer artifact generation/sync steps
- `scripts/sync-site-header.py`: enforces canonical shared header across viewer pages
- `scripts/generate-autocomplete-index.py`: builds lightweight autocomplete artifact
- `scripts/apply-asset-versions.py`: applies deterministic content-hash asset versions
