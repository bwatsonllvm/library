#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE_ROOT="$ROOT"
EVENTS_ROOT="$ROOT/devmtg/events"
UPDATES_ROOT="$ROOT/updates"
PAPERS_ROOT="$ROOT/papers"

fail() { echo "ERROR: $*" >&2; exit 1; }

[ -d "$SITE_ROOT" ] || fail "Missing repository root: $SITE_ROOT"
[ -d "$EVENTS_ROOT" ] || fail "Missing events directory: devmtg/events"
[ -d "$UPDATES_ROOT" ] || fail "Missing updates directory: updates"
[ -d "$PAPERS_ROOT" ] || fail "Missing papers directory: papers"

for f in \
  index.html \
  work.html \
  talks/index.html \
  talks/events.html \
  talks/talk.html \
  papers/index.html \
  papers/add.html \
  papers/paper.html \
  blogs/index.html \
  people/index.html \
  mlir/index.html \
  mlir/talks/index.html \
  mlir/talks/talk.html \
  mlir/pubs/index.html \
  sub-projects/index.html \
  sub-projects/mlir/index.html \
  sub-projects/mlir/talks/index.html \
  sub-projects/mlir/talks/talk.html \
  sub-projects/mlir/pubs/index.html \
  about/index.html \
  updates/index.html \
  updates/index.json \
  css/style.css \
  js/app.js \
  js/events-data.js \
  js/meetings.js \
  js/talk.js \
  js/paper.js \
  js/paper-manual-add.js \
  js/papers-data.js \
  js/papers.js \
  js/updates.js \
  js/mlir-talks.js \
  js/mlir-pubs.js \
  js/subproject-home.js \
  js/shared/library-utils.js \
  js/data/autocomplete-index.json \
  js/data/paper-added-at.json \
  js/data/paper-related.json \
  js/data/papers-catalog.json \
  js/data/people-index.json \
  js/data/site-stats.json \
  js/data/talk-paper-links.json \
  js/data/talk-related.json \
  js/data/talks-catalog.json \
  js/data/viewer-artifacts.json \
  js/data/work-search-corpus.json \
  sub-projects/mlir/data/talks.json \
  sub-projects/mlir/data/publications.json \
  templates/site-header.html \
  scripts/build-viewer-artifacts.sh \
  scripts/build-viewer-artifacts.js \
  scripts/sync-site-header.py \
  scripts/generate-autocomplete-index.py \
  scripts/generate-talk-paper-links.py \
  scripts/sync-mlir-subproject.py \
  scripts/apply-asset-versions.py \
  images/llvm-logo.png \
  images/llvm-favicon.png \
  devmtg/events/index.json; do
  [ -f "$SITE_ROOT/$f" ] || fail "Missing required file: $f"
done
[ -f "$PAPERS_ROOT/index.json" ] || fail "Missing required file: papers/index.json"
[ -f "$PAPERS_ROOT/key-topic-canonical.json" ] || fail "Missing required file: papers/key-topic-canonical.json"
[ -f "$PAPERS_ROOT/manual-added-papers.json" ] || fail "Missing required file: papers/manual-added-papers.json"
[ -d "$SITE_ROOT/js/data/talk-details" ] || fail "Missing required directory: js/data/talk-details"
[ -d "$SITE_ROOT/js/data/paper-details" ] || fail "Missing required directory: js/data/paper-details"

# Validate generated viewer artifacts are synchronized.
scripts/build-viewer-artifacts.sh --check

# Ensure event bundles are JSON-native.
if find "$EVENTS_ROOT" -maxdepth 1 -name '*.md' | grep -q .; then
  fail "Found markdown event files in devmtg/events; expected JSON-only"
fi

# Validate event manifest points to existing JSON files.
ruby -rjson -ruri -e '
  events_root = ARGV.fetch(0)
  idx_path = File.join(events_root, "index.json")
  idx = JSON.parse(File.read(idx_path))
  files = Array(idx["eventFiles"])
  abort("devmtg/events/index.json has empty eventFiles") if files.empty?
  missing = []
  files.each do |f|
    missing << f unless File.exist?(File.join(events_root, f))
    abort("devmtg/events/index.json contains non-json entry: #{f}") unless f.end_with?(".json")
  end
  unless missing.empty?
    abort("Missing event files: #{missing.join(", ")}")
  end
' "$EVENTS_ROOT"

# Validate every devmtg/events/*.json parses.
ruby -rjson -ruri -e '
  events_root = ARGV.fetch(0)
  Dir[File.join(events_root, "*.json")].each do |f|
    JSON.parse(File.read(f))
  end
' "$EVENTS_ROOT"

# Validate updates log JSON.
ruby -rjson -e '
  updates_root = ARGV.fetch(0)
  path = File.join(updates_root, "index.json")
  payload = JSON.parse(File.read(path))
  abort("updates/index.json must contain an object") unless payload.is_a?(Hash)
  abort("updates/index.json missing dataVersion") if String(payload["dataVersion"]).strip.empty?
  abort("updates/index.json missing generatedAt") if String(payload["generatedAt"]).strip.empty?
  entries = payload["entries"]
  abort("updates/index.json missing entries array") unless entries.is_a?(Array)
  entries.each_with_index do |entry, idx|
    abort("updates/index.json entry #{idx} must be object") unless entry.is_a?(Hash)
    abort("updates/index.json entry #{idx} missing kind") if String(entry["kind"]).strip.empty?
    abort("updates/index.json entry #{idx} missing title") if String(entry["title"]).strip.empty?
    abort("updates/index.json entry #{idx} missing url") if String(entry["url"]).strip.empty?
    topics = entry["keyTopics"]
    abort("updates/index.json entry #{idx} missing keyTopics array") unless topics.is_a?(Array)
    abort("updates/index.json entry #{idx} keyTopics must not be empty") if topics.empty?
    topics.each_with_index do |topic, tidx|
      label = String(topic).strip
      abort("updates/index.json entry #{idx} keyTopics[#{tidx}] must be non-empty string") if label.empty?
    end
  end
' "$UPDATES_ROOT"

# Validate papers manifest points to existing JSON files.
ruby -rjson -e '
  papers_root = ARGV.fetch(0)
  idx_path = File.join(papers_root, "index.json")
  idx = JSON.parse(File.read(idx_path))
  files = Array(idx["paperFiles"])
  abort("papers/index.json has empty paperFiles") if files.empty?
  missing = []
  files.each do |f|
    missing << f unless File.exist?(File.join(papers_root, f))
    abort("papers/index.json contains non-json entry: #{f}") unless f.end_with?(".json")
  end
  unless missing.empty?
    abort("Missing paper files: #{missing.join(", ")}")
  end
' "$PAPERS_ROOT"

# Validate every papers/*.json parses.
ruby -rjson -e '
  papers_root = ARGV.fetch(0)
  Dir[File.join(papers_root, "*.json")].each do |f|
    JSON.parse(File.read(f))
  end
' "$PAPERS_ROOT"

# Validate URL-bearing fields only use safe URL schemes.
ruby -rjson -ruri -e '
  events_root = ARGV.fetch(0)
  updates_root = ARGV.fetch(1)
  papers_root = ARGV.fetch(2)
  PLACEHOLDER_URL_VALUES = %w[none null nil nan n/a na undefined].freeze

  def valid_http_url?(value)
    uri = URI.parse(String(value))
    %w[http https].include?(String(uri.scheme).downcase) && !String(uri.host).strip.empty?
  rescue URI::InvalidURIError
    false
  end

  def valid_linkish_url?(value)
    text = String(value).strip
    return false if text.empty?
    return false if PLACEHOLDER_URL_VALUES.include?(text.downcase)
    return false if text.match?(/\s/)
    return true if text.start_with?("#")
    return valid_http_url?("https:#{text}") if text.start_with?("//")
    return valid_http_url?(text) if text =~ /\A[a-z][a-z0-9+.-]*:/i
    true
  end

  bad = []

  Dir[File.join(events_root, "*.json")].each do |event_path|
    payload = JSON.parse(File.read(event_path))
    talks = Array(payload["talks"])
    talks.each_with_index do |talk, idx|
      next unless talk.is_a?(Hash)
      {
        "videoUrl" => talk["videoUrl"],
        "slidesUrl" => talk["slidesUrl"],
        "projectGithub" => talk["projectGithub"],
      }.each do |field, value|
        text = String(value).strip
        next if text.empty?
        bad << "#{File.basename(event_path)} talks[#{idx}].#{field}=#{text}" unless valid_http_url?(text)
      end

      Array(talk["speakers"]).each_with_index do |speaker, sidx|
        next unless speaker.is_a?(Hash)
        {"github" => speaker["github"], "linkedin" => speaker["linkedin"], "twitter" => speaker["twitter"]}.each do |field, value|
          text = String(value).strip
          next if text.empty?
          bad << "#{File.basename(event_path)} talks[#{idx}].speakers[#{sidx}].#{field}=#{text}" unless valid_http_url?(text)
        end
      end
    end
  end

  Dir[File.join(papers_root, "*.json")].each do |paper_path|
    payload = JSON.parse(File.read(paper_path))
    papers = Array(payload["papers"])
    papers.each_with_index do |paper, idx|
      next unless paper.is_a?(Hash)
      {"paperUrl" => paper["paperUrl"], "sourceUrl" => paper["sourceUrl"], "openalexId" => paper["openalexId"]}.each do |field, value|
        text = String(value).strip
        next if text.empty?
        bad << "#{File.basename(paper_path)} papers[#{idx}].#{field}=#{text}" unless valid_http_url?(text)
      end
    end
  end

  updates_path = File.join(updates_root, "index.json")
  updates_payload = JSON.parse(File.read(updates_path))
  entries = Array(updates_payload["entries"])
  entries.each_with_index do |entry, idx|
    next unless entry.is_a?(Hash)
    url_text = String(entry["url"]).strip
    bad << "updates/index.json entries[#{idx}].url=#{url_text}" unless valid_linkish_url?(url_text)
    {"videoUrl" => entry["videoUrl"], "slidesUrl" => entry["slidesUrl"], "paperUrl" => entry["paperUrl"], "sourceUrl" => entry["sourceUrl"], "blogUrl" => entry["blogUrl"]}.each do |field, value|
      text = String(value).strip
      next if text.empty?
      bad << "updates/index.json entries[#{idx}].#{field}=#{text}" unless valid_http_url?(text)
    end
  end

  unless bad.empty?
    warn("Unsafe URL fields:\n" + bad.join("\n"))
    exit 1
  end
' "$EVENTS_ROOT" "$UPDATES_ROOT" "$PAPERS_ROOT"

# Validate talk paper links JSON.
ruby -rjson -ruri -e '
  site_root = ARGV.fetch(0)
  path = File.join(site_root, "js", "data", "talk-paper-links.json")
  payload = JSON.parse(File.read(path))
  abort("talk-paper-links.json must contain an object") unless payload.is_a?(Hash)
  abort("talk-paper-links.json missing dataVersion") if String(payload["dataVersion"]).strip.empty?
  abort("talk-paper-links.json missing generatedAt") if String(payload["generatedAt"]).strip.empty?
  talks = payload["talks"]
  abort("talk-paper-links.json missing talks object") unless talks.is_a?(Hash)
  talks.each do |talk_id, entry|
    abort("talk-paper-links.json talk id must be non-empty") if String(talk_id).strip.empty?
    abort("talk-paper-links.json entry for #{talk_id} must be object") unless entry.is_a?(Hash)
    slide_ids = entry["slidePaperIds"]
    abort("talk-paper-links.json entry for #{talk_id} missing slidePaperIds array") unless slide_ids.is_a?(Array)
    slide_ids.each do |paper_id|
      abort("talk-paper-links.json entry for #{talk_id} contains empty paper id") if String(paper_id).strip.empty?
    end
    slide_github = entry["slideGithubRepoUrls"]
    abort("talk-paper-links.json entry for #{talk_id} missing slideGithubRepoUrls array") unless slide_github.is_a?(Array)
    slide_github.each do |url|
      begin
        uri = URI.parse(String(url))
        abort("talk-paper-links.json entry for #{talk_id} contains invalid slide GitHub URL #{url}") unless %w[http https].include?(String(uri.scheme).downcase) && !String(uri.host).strip.empty?
      rescue URI::InvalidURIError
        abort("talk-paper-links.json entry for #{talk_id} contains invalid slide GitHub URL #{url}")
      end
    end
    github_urls = entry["githubRepoUrls"]
    abort("talk-paper-links.json entry for #{talk_id} missing githubRepoUrls array") unless github_urls.is_a?(Array)
    github_urls.each do |url|
      begin
        uri = URI.parse(String(url))
        abort("talk-paper-links.json entry for #{talk_id} contains invalid GitHub URL #{url}") unless %w[http https].include?(String(uri.scheme).downcase) && !String(uri.host).strip.empty?
      rescue URI::InvalidURIError
        abort("talk-paper-links.json entry for #{talk_id} contains invalid GitHub URL #{url}")
      end
    end
    slide_talk_ids = entry["slideTalkIds"]
    abort("talk-paper-links.json entry for #{talk_id} missing slideTalkIds array") unless slide_talk_ids.is_a?(Array)
    slide_talk_ids.each do |ref_id|
      abort("talk-paper-links.json entry for #{talk_id} contains empty talk id") if String(ref_id).strip.empty?
    end
    slide_github_refs = entry["slideGithubReferences"]
    abort("talk-paper-links.json entry for #{talk_id} missing slideGithubReferences array") unless slide_github_refs.is_a?(Array)
    github_refs = entry["githubReferences"]
    abort("talk-paper-links.json entry for #{talk_id} missing githubReferences array") unless github_refs.is_a?(Array)
    [slide_github_refs, github_refs].each do |refs|
      refs.each do |item|
        abort("talk-paper-links.json entry for #{talk_id} GitHub reference must be object") unless item.is_a?(Hash)
        url = String(item["url"])
        begin
          uri = URI.parse(url)
          abort("talk-paper-links.json entry for #{talk_id} contains invalid GitHub reference URL #{url}") unless %w[http https].include?(String(uri.scheme).downcase) && !String(uri.host).strip.empty?
        rescue URI::InvalidURIError
          abort("talk-paper-links.json entry for #{talk_id} contains invalid GitHub reference URL #{url}")
        end
      end
    end
  end
' "$SITE_ROOT"

# Validate viewer artifact manifest and sharded detail bundles.
ruby -rjson -e '
  site_root = ARGV.fetch(0)
  manifest_path = File.join(site_root, "js", "data", "viewer-artifacts.json")
  manifest = JSON.parse(File.read(manifest_path))
  abort("viewer-artifacts.json must contain an object") unless manifest.is_a?(Hash)
  abort("viewer-artifacts.json missing dataVersion") if String(manifest["dataVersion"]).strip.empty?
  abort("viewer-artifacts.json missing generatedAt") if String(manifest["generatedAt"]).strip.empty?

  files = manifest["files"]
  abort("viewer-artifacts.json missing files object") unless files.is_a?(Hash) && !files.empty?
  files.each do |key, ref|
    clean = String(ref).split("?", 2).first
    abort("viewer-artifacts.json file #{key} missing path") if clean.strip.empty?
    path = File.join(site_root, clean.sub(%r{\A/+}, ""))
    abort("viewer-artifacts.json file #{key} points to missing asset #{clean}") unless File.exist?(path)
    JSON.parse(File.read(path))
  end

  shards = manifest["shards"]
  abort("viewer-artifacts.json missing shards object") unless shards.is_a?(Hash) && !shards.empty?
  shards.each do |name, entry|
    abort("viewer-artifacts.json shard #{name} must be object") unless entry.is_a?(Hash)
    template = String(entry["template"]).split("?", 2).first
    abort("viewer-artifacts.json shard #{name} missing template") if template.strip.empty?
    abort("viewer-artifacts.json shard #{name} missing {shard} template marker") unless template.include?("{shard}")
    count = Integer(entry["shardCount"]) rescue 0
    abort("viewer-artifacts.json shard #{name} has invalid shardCount") unless count > 0
    root_key = String(entry["rootKey"]).strip
    item_key = String(entry["itemKey"]).strip
    abort("viewer-artifacts.json shard #{name} missing rootKey") if root_key.empty?
    abort("viewer-artifacts.json shard #{name} missing itemKey") if item_key.empty?

    count.times do |idx|
      shard = idx.to_s(16).rjust(2, "0")
      rel = template.sub("{shard}", shard)
      path = File.join(site_root, rel.sub(%r{\A/+}, ""))
      abort("viewer artifact shard missing: #{rel}") unless File.exist?(path)
      payload = JSON.parse(File.read(path))
      abort("#{rel} must contain an object") unless payload.is_a?(Hash)
      abort("#{rel} missing dataVersion") if String(payload["dataVersion"]).strip.empty?
      abort("#{rel} missing generatedAt") if String(payload["generatedAt"]).strip.empty?
      bucket = payload[root_key]
      abort("#{rel} missing #{root_key} object") unless bucket.is_a?(Hash)
      bucket.each do |record_id, detail|
        abort("#{rel} contains empty record id") if String(record_id).strip.empty?
        abort("#{rel} detail for #{record_id} must be object") unless detail.is_a?(Hash)
        item = detail[item_key]
        abort("#{rel} detail for #{record_id} missing #{item_key} object") unless item.is_a?(Hash)
      end
    end
  end
' "$SITE_ROOT"

# Validate MLIR subproject artifacts.
ruby -rjson -e '
  site_root = ARGV.fetch(0)
  {
    "sub-projects/mlir/data/talks.json" => "MLIR Talks",
    "sub-projects/mlir/data/publications.json" => "MLIR Publications",
  }.each do |rel, label|
    path = File.join(site_root, rel)
    payload = JSON.parse(File.read(path))
    abort("#{rel} must contain an object") unless payload.is_a?(Hash)
    abort("#{rel} missing dataVersion") if String(payload["dataVersion"]).strip.empty?
    abort("#{rel} missing generatedAt") if String(payload["generatedAt"]).strip.empty?
    abort("#{rel} missing title") if String(payload["title"]).strip.empty?
    abort("#{rel} missing sourceUrl") if String(payload["sourceUrl"]).strip.empty?
    sections = payload["sections"]
    abort("#{rel} missing sections array") unless sections.is_a?(Array)
    sections.each_with_index do |section, sidx|
      abort("#{rel} section #{sidx} must be object") unless section.is_a?(Hash)
      abort("#{rel} section #{sidx} missing title") if String(section["title"]).strip.empty?
      groups = section["groups"]
      abort("#{rel} section #{sidx} missing groups array") unless groups.is_a?(Array)
      groups.each_with_index do |group, gidx|
        abort("#{rel} section #{sidx} group #{gidx} must be object") unless group.is_a?(Hash)
        entries = group["entries"]
        abort("#{rel} section #{sidx} group #{gidx} missing entries array") unless entries.is_a?(Array)
        entries.each_with_index do |entry, eidx|
          abort("#{rel} section #{sidx} group #{gidx} entry #{eidx} must be object") unless entry.is_a?(Hash)
          abort("#{rel} section #{sidx} group #{gidx} entry #{eidx} missing id") if String(entry["id"]).strip.empty?
          abort("#{rel} section #{sidx} group #{gidx} entry #{eidx} missing title") if String(entry["title"]).strip.empty?
          actions = entry["actions"]
          abort("#{rel} section #{sidx} group #{gidx} entry #{eidx} missing actions array") unless actions.is_a?(Array)
          actions.each_with_index do |action, aidx|
            abort("#{rel} section #{sidx} group #{gidx} entry #{eidx} action #{aidx} must be object") unless action.is_a?(Hash)
            abort("#{rel} section #{sidx} group #{gidx} entry #{eidx} action #{aidx} missing label") if String(action["label"]).strip.empty?
            abort("#{rel} section #{sidx} group #{gidx} entry #{eidx} action #{aidx} missing url") if String(action["url"]).strip.empty?
          end
        end
      end
    end
  end
' "$SITE_ROOT"

# Validate local asset references in HTML files.
ruby -e '
  site_root = ARGV.fetch(0)
  html_files = %w[
    index.html
    work.html
    talks/index.html
    talks/events.html
    talks/talk.html
    papers/index.html
    papers/add.html
    papers/paper.html
    blogs/index.html
    people/index.html
    mlir/index.html
    mlir/talks/index.html
    mlir/talks/talk.html
    mlir/pubs/index.html
    sub-projects/index.html
    sub-projects/mlir/index.html
    sub-projects/mlir/talks/index.html
    sub-projects/mlir/talks/talk.html
    sub-projects/mlir/pubs/index.html
    about/index.html
    updates/index.html
  ].map { |f| File.join(site_root, f) }

  bad = []
  html_files.each do |html|
    text = File.read(html)
    base_href = text[/<base\s+href="([^"]+)"/i, 1]
    base_dir = File.dirname(html)
    if base_href && base_href !~ /\A[a-z][a-z0-9+.-]*:/i && !base_href.start_with?("//")
      base_dir = File.expand_path(base_href, File.dirname(html))
    end
    refs = text.scan(/(?:src|href)=\"([^\"]+)\"/).flatten
    refs.each do |ref|
      if ref.start_with?("javascript:", "data:")
        bad << "#{File.basename(html)} -> unsafe scheme #{ref}"
        next
      end
      next if ref.start_with?("http://", "https://", "#", "mailto:")
      next if ref.start_with?("?")
      clean = ref.split("#", 2).first.split("?", 2).first
      next if clean.empty?
      if clean.start_with?("/library/")
        clean = clean.sub(%r{\A/library/}, "")
        path = File.expand_path(clean, site_root)
      elsif clean.start_with?("/")
        clean = clean.sub(%r{\A/}, "")
        path = File.expand_path(clean, site_root)
      else
        path = File.expand_path(clean, base_dir)
      end
      bad << "#{File.basename(html)} -> #{ref}" unless File.exist?(path)
    end
  end
  unless bad.empty?
    warn("Broken local references:\n" + bad.join("\n"))
    exit 1
  end
' "$SITE_ROOT"

echo "OK: library bundle validation passed"
