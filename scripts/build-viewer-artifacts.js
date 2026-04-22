#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function parseArgs(argv) {
  const out = {
    repoRoot: path.resolve(__dirname, '..'),
    check: false,
    shardCount: 64,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = String(argv[index] || '');
    if (arg === '--check') {
      out.check = true;
      continue;
    }
    if (arg === '--repo-root' && index + 1 < argv.length) {
      out.repoRoot = path.resolve(String(argv[index + 1] || ''));
      index += 1;
      continue;
    }
    if (arg === '--shard-count' && index + 1 < argv.length) {
      const value = Number.parseInt(String(argv[index + 1] || ''), 10);
      if (Number.isFinite(value) && value > 0) out.shardCount = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return out;
}

const args = parseArgs(process.argv);
const repoRoot = args.repoRoot;
const HubUtils = require(path.join(repoRoot, 'js', 'shared', 'library-utils.js'));

const BLOG_SOURCE_SLUGS = new Set(['llvm-blog-www', 'llvm-www-blog']);
const CONTENT_FIELDS = ['content', 'body', 'markdown', 'html', 'bodyText', 'fullText', 'text'];
const SHARD_COUNT = Math.max(1, args.shardCount | 0);
const MAX_AUTOCOMPLETE_TOPICS = 800;
const MAX_AUTOCOMPLETE_PEOPLE = 6000;
const MAX_AUTOCOMPLETE_TALKS = 5000;
const MAX_AUTOCOMPLETE_PAPERS = 8000;

function readJson(pathname) {
  return JSON.parse(fs.readFileSync(pathname, 'utf8'));
}

function readText(pathname) {
  return fs.readFileSync(pathname, 'utf8');
}

function writeText(pathname, content) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, content, 'utf8');
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function hashFile(pathname) {
  return sha1(fs.readFileSync(pathname));
}

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeHttpUrl(value) {
  const raw = collapseWhitespace(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw, 'https://llvm.org/');
    const protocol = String(parsed.protocol || '').toLowerCase();
    if (protocol === 'http:' || protocol === 'https:') return parsed.toString();
  } catch {
    return '';
  }
  return '';
}

function sanitizeExternalUrl(value) {
  return normalizeHttpUrl(value);
}

function normalizeFilterValue(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeSearchField(value) {
  const text = normalizeSearchText(value);
  return {
    text,
    words: text ? text.split(/\s+/).filter((word) => word.length >= 2) : [],
  };
}

function parseYearNumber(value) {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  if (!match) return 0;
  const year = Number.parseInt(match[0], 10);
  return Number.isFinite(year) ? year : 0;
}

function formatIsoDateLabel(value) {
  const raw = collapseWhitespace(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const stamp = new Date(Date.UTC(
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10) - 1,
    Number.parseInt(match[3], 10)
  ));
  if (Number.isNaN(stamp.valueOf())) return '';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(stamp);
}

function normalizeIsoDate(value) {
  const raw = collapseWhitespace(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '';
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return '';
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function extractDoi(value) {
  const match = String(value || '').match(/10\.\d{4,9}\/[\w.()\-;/:%+]+/i);
  return match ? String(match[0]).trim() : '';
}

function normalizeOpenAlexId(value) {
  const raw = collapseWhitespace(value);
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return sanitizeExternalUrl(raw);
  const cleaned = raw
    .replace(/^https?:\/\/openalex\.org\//i, '')
    .replace(/^works\//i, '')
    .trim();
  if (!/^W\d+$/i.test(cleaned)) return '';
  return `https://openalex.org/${cleaned.toUpperCase()}`;
}

function stripSearchSourceText(value) {
  return String(value || '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_>#~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSpeakerRecord(rawSpeaker) {
  const normalized = HubUtils.normalizePersonRecord(rawSpeaker);
  if (!normalized || !normalized.name) return null;
  return {
    name: collapseWhitespace(normalized.name),
    affiliation: collapseWhitespace(normalized.affiliation),
    github: sanitizeExternalUrl(rawSpeaker && rawSpeaker.github),
    linkedin: sanitizeExternalUrl(rawSpeaker && rawSpeaker.linkedin),
    twitter: sanitizeExternalUrl(rawSpeaker && rawSpeaker.twitter),
  };
}

function normalizePaperAuthors(rawAuthors) {
  return Array.isArray(rawAuthors)
    ? rawAuthors
        .map((author) => normalizeSpeakerRecord(author))
        .filter(Boolean)
    : [];
}

function isBlogPaper(paper) {
  if (!paper || typeof paper !== 'object') return false;
  if (paper._isBlog === true) return true;
  const source = normalizeFilterValue(paper.source);
  const type = normalizeFilterValue(paper.type);
  const sourceUrl = String(paper.sourceUrl || '').trim();
  const paperUrl = String(paper.paperUrl || '').trim();
  return BLOG_SOURCE_SLUGS.has(source)
    || type === 'blog'
    || type === 'blog-post'
    || /^https?:\/\/(?:www\.)?blog\.llvm\.org\//i.test(sourceUrl)
    || /github\.com\/llvm\/(?:llvm-blog-www|llvm-www-blog)\b/i.test(paperUrl);
}

function normalizeGithubRepoUrls(entry) {
  const detailed = Array.isArray(entry && entry.githubReferences) ? entry.githubReferences : [];
  const detailedUrls = detailed
    .map((item) => normalizeHttpUrl(item && item.url))
    .filter(Boolean);
  if (detailedUrls.length) return [...new Set(detailedUrls)];
  return Array.isArray(entry && entry.githubRepoUrls)
    ? [...new Set(entry.githubRepoUrls.map((value) => normalizeHttpUrl(value)).filter(Boolean))]
    : [];
}

function normalizeGithubReferenceItems(entry) {
  const rawItems = Array.isArray(entry && entry.githubReferences) ? entry.githubReferences : [];
  if (rawItems.length) {
    return rawItems
      .map((item) => ({
        url: normalizeHttpUrl(item && item.url),
        source: collapseWhitespace(item && item.source),
        label: collapseWhitespace(item && item.label),
        context: collapseWhitespace(item && item.context),
        library: collapseWhitespace(item && item.library),
        repository: collapseWhitespace(item && item.repository),
        fileName: collapseWhitespace(item && item.fileName),
        filePath: collapseWhitespace(item && item.filePath),
        referencePath: collapseWhitespace(item && item.referencePath),
      }))
      .filter((item) => item.url);
  }

  return normalizeGithubRepoUrls(entry).map((url) => ({
    url,
    source: '',
    label: '',
    context: '',
    library: '',
    repository: '',
    fileName: '',
    filePath: '',
    referencePath: '',
  }));
}

function mergeGithubResourceActions(existingActions, githubUrls) {
  const base = Array.isArray(existingActions)
    ? existingActions
        .map((action) => ({
          kind: collapseWhitespace(action && action.kind).toLowerCase(),
          label: collapseWhitespace(action && action.label),
          url: normalizeHttpUrl(action && action.url),
        }))
        .filter((action) => action.url)
    : [];
  const seenUrls = new Set(base.map((action) => action.url));
  let githubCount = 0;
  for (const value of (Array.isArray(githubUrls) ? githubUrls : [])) {
    const url = normalizeHttpUrl(value);
    if (!url || seenUrls.has(url)) continue;
    githubCount += 1;
    seenUrls.add(url);
    base.push({
      kind: 'github',
      label: githubCount === 1 ? 'GitHub' : `GitHub ${githubCount}`,
      url,
    });
  }
  return base;
}

function applyReferenceMetadataToTalk(talk, referenceIndex) {
  if (!talk || typeof talk !== 'object') return talk;
  const talkId = collapseWhitespace(talk.id);
  if (!talkId || !referenceIndex || typeof referenceIndex !== 'object') return talk;
  const referenceEntry = referenceIndex[talkId];
  const githubReferenceItems = normalizeGithubReferenceItems(referenceEntry);
  const githubUrls = normalizeGithubRepoUrls(referenceEntry);
  if (!githubUrls.length && !githubReferenceItems.length) return talk;

  const enriched = { ...talk };
  if (!collapseWhitespace(enriched.projectGithub)) {
    enriched.projectGithub = githubUrls[0];
  }
  enriched.githubReferences = githubUrls;
  enriched.githubReferenceItems = githubReferenceItems;
  const mergedActions = mergeGithubResourceActions(enriched.resourceActions, githubUrls);
  if (mergedActions.length) enriched.resourceActions = mergedActions;
  return enriched;
}

function buildTalkSearchDocData(talk) {
  return {
    fields: {
      title: makeSearchField(talk._titleLower || talk.title || ''),
      speakers: makeSearchField(talk._speakerLower || ''),
      tags: makeSearchField(talk._tagsLower || ''),
      meeting: makeSearchField(talk._meetingLower || ''),
      abstract: makeSearchField(talk._abstractLower || talk.abstract || ''),
      category: makeSearchField(talk.category || ''),
      year: makeSearchField(talk._year || ''),
    },
    year: parseYearNumber(talk._year || talk.meeting || ''),
  };
}

function buildPaperSearchDocData(paper) {
  const typeField = [
    paper.type || '',
    paper._isBlog ? 'blog' : 'paper',
  ].filter(Boolean).join(' ');
  return {
    fields: {
      title: makeSearchField(paper._titleLower || paper.title || ''),
      authors: makeSearchField(paper._authorsLower || ''),
      topics: makeSearchField(paper._topicsLower || ''),
      type: makeSearchField(typeField),
      abstract: makeSearchField(paper._abstractLower || paper.abstract || ''),
      content: makeSearchField(paper._contentLower || paper.bodyText || ''),
      publication: makeSearchField(paper._publicationLower || paper.publication || ''),
      venue: makeSearchField(paper._venueLower || paper.venue || ''),
      year: makeSearchField(paper._yearLower || paper._year || paper.year || ''),
    },
    year: parseYearNumber(paper._year || paper.year || paper.publishedDate || ''),
    citationCount: Number.isFinite(Number(paper._citationCount || paper.citationCount))
      ? Math.max(0, Math.round(Number(paper._citationCount || paper.citationCount)))
      : 0,
  };
}

function normalizeTalkRecord(rawTalk) {
  const normalized = HubUtils.normalizeTalkRecord(rawTalk);
  const talk = JSON.parse(JSON.stringify(normalized));
  talk.speakers = Array.isArray(talk.speakers)
    ? talk.speakers.map((speaker) => normalizeSpeakerRecord(speaker)).filter(Boolean)
    : [];
  talk.tags = Array.isArray(talk.tags)
    ? talk.tags.map((tag) => collapseWhitespace(tag)).filter(Boolean)
    : [];
  talk.keywords = Array.isArray(talk.keywords)
    ? talk.keywords.map((value) => collapseWhitespace(value)).filter(Boolean)
    : [];
  talk.resourceActions = Array.isArray(talk.resourceActions)
    ? talk.resourceActions
        .map((action) => ({
          kind: collapseWhitespace(action && action.kind).toLowerCase(),
          label: collapseWhitespace(action && action.label),
          url: sanitizeExternalUrl(action && action.url),
        }))
        .filter((action) => action.url)
    : [];
  talk.projectGithub = sanitizeExternalUrl(talk.projectGithub);
  talk.githubReferences = Array.isArray(talk.githubReferences)
    ? [...new Set(talk.githubReferences.map((value) => sanitizeExternalUrl(value)).filter(Boolean))]
    : [];
  talk.githubReferenceItems = Array.isArray(talk.githubReferenceItems)
    ? talk.githubReferenceItems
        .map((item) => ({
          url: sanitizeExternalUrl(item && item.url),
          source: collapseWhitespace(item && item.source),
          label: collapseWhitespace(item && item.label),
          context: collapseWhitespace(item && item.context),
          library: collapseWhitespace(item && item.library),
          repository: collapseWhitespace(item && item.repository),
          fileName: collapseWhitespace(item && item.fileName),
          filePath: collapseWhitespace(item && item.filePath),
          referencePath: collapseWhitespace(item && item.referencePath),
        }))
        .filter((item) => item.url)
    : [];
  talk.videoUrl = sanitizeExternalUrl(talk.videoUrl);
  talk.slidesUrl = sanitizeExternalUrl(talk.slidesUrl);
  talk.posterUrl = sanitizeExternalUrl(talk.posterUrl);
  talk.sourceUrl = sanitizeExternalUrl(talk.sourceUrl);
  talk._titleLower = String(talk.title || '').toLowerCase();
  talk._speakerLower = talk.speakers.map((speaker) => speaker.name).join(' ').toLowerCase();
  talk._abstractLower = String(talk.abstract || '').toLowerCase();
  talk._tagsLower = HubUtils.getTalkKeyTopics(talk, Infinity).join(' ').toLowerCase();
  talk._meetingLower = `${talk.meetingName || ''} ${talk.meetingLocation || ''} ${talk.meetingDate || ''}`.toLowerCase();
  talk._year = collapseWhitespace(String(talk.meeting || '')).slice(0, 4);
  talk._searchDoc = buildTalkSearchDocData(talk);
  talk._searchBlob = normalizeSearchText([
    talk.title,
    talk.abstract,
    talk.meetingName,
    talk.meetingLocation,
    talk.meetingDate,
    talk.meeting,
    talk.category,
    talk.speakers.map((speaker) => speaker.name).join(' '),
    HubUtils.getTalkKeyTopics(talk, Infinity).join(' '),
  ].join(' '));
  return talk;
}

function normalizePaperRecord(rawPaper) {
  const paper = JSON.parse(JSON.stringify(rawPaper || {}));
  paper.id = collapseWhitespace(paper.id);
  paper.title = collapseWhitespace(paper.title);
  paper.abstract = collapseWhitespace(paper.abstract);
  paper.year = collapseWhitespace(paper.year);
  paper.publishedDate = normalizeIsoDate(paper.publishedDate || paper.publishDate || paper.date);
  paper.publication = collapseWhitespace(paper.publication);
  paper.venue = collapseWhitespace(paper.venue);
  paper.source = collapseWhitespace(paper.source);
  paper.sourceName = collapseWhitespace(paper.sourceName);
  paper.type = collapseWhitespace(paper.type);
  paper.paperUrl = sanitizeExternalUrl(paper.paperUrl);
  paper.sourceUrl = sanitizeExternalUrl(paper.sourceUrl);
  paper.contentFormat = collapseWhitespace(paper.contentFormat || paper.bodyFormat).toLowerCase();
  paper.content = String(paper.content || paper.body || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  paper.citationCount = Number.isFinite(Number(paper.citationCount))
    ? Math.max(0, Math.round(Number(paper.citationCount)))
    : 0;
  paper.authors = normalizePaperAuthors(paper.authors);
  paper.tags = Array.isArray(paper.tags)
    ? paper.tags.map((value) => collapseWhitespace(value)).filter(Boolean)
    : [];
  paper.keywords = Array.isArray(paper.keywords)
    ? paper.keywords.map((value) => collapseWhitespace(value)).filter(Boolean)
    : [];
  if (!paper.keywords.length && paper.tags.length) paper.keywords = [...paper.tags];
  paper.matchedAuthors = Array.isArray(paper.matchedAuthors)
    ? paper.matchedAuthors.map((value) => collapseWhitespace(value)).filter(Boolean)
    : [];
  paper.matchedSubprojects = Array.isArray(paper.matchedSubprojects)
    ? paper.matchedSubprojects.map((value) => collapseWhitespace(value)).filter(Boolean)
    : [];
  paper.doi = extractDoi(paper.doi) || extractDoi(paper.paperUrl) || extractDoi(paper.sourceUrl);
  paper.openalexId = normalizeOpenAlexId(paper.openalexId || paper.openAlexId);
  paper.bodyText = stripSearchSourceText([
    paper.content,
    paper.bodyText,
    paper.fullText,
    paper.text,
    paper.markdown,
    paper.html,
  ].filter(Boolean).join('\n\n'));
  if (!paper.id || !paper.title) return null;
  paper._year = /^\d{4}$/.test(paper.year) ? paper.year : '';
  paper._publishedDate = paper.publishedDate;
  paper._publishedDateLabel = formatIsoDateLabel(paper._publishedDate);
  paper._citationCount = paper.citationCount;
  paper._titleLower = String(paper.title || '').toLowerCase();
  paper._authorLower = paper.authors.map((author) => `${author.name} ${author.affiliation || ''}`.trim()).join(' ').toLowerCase();
  paper._authorsLower = paper._authorLower;
  paper._abstractLower = String(paper.abstract || '').toLowerCase();
  paper._tagsLower = paper.tags.join(' ').toLowerCase();
  paper._keywordsLower = paper.keywords.join(' ').toLowerCase();
  paper._topicsLower = `${paper._tagsLower} ${paper._keywordsLower} ${paper.matchedSubprojects.join(' ')}`.trim().toLowerCase();
  paper._contentLower = String(paper.bodyText || '').toLowerCase();
  paper._publicationLower = String(paper.publication || '').toLowerCase();
  paper._venueLower = String(paper.venue || '').toLowerCase();
  paper._typeLower = String(paper.type || '').toLowerCase();
  paper._sourceLower = String(paper.source || '').toLowerCase();
  paper._yearLower = String(paper._year || '').toLowerCase();
  paper._isBlog = isBlogPaper(paper);
  paper._searchDoc = buildPaperSearchDocData(paper);
  paper._searchBlob = normalizeSearchText([
    paper.title,
    paper.abstract,
    paper.bodyText,
    paper.publication,
    paper.venue,
    paper.year,
    paper.type,
    paper.authors.map((author) => `${author.name} ${author.affiliation || ''}`.trim()).join(' '),
    [...paper.tags, ...paper.keywords, ...paper.matchedSubprojects].join(' '),
  ].join(' '));
  return paper;
}

function createPaperSummary(paper) {
  const summary = JSON.parse(JSON.stringify(paper));
  for (const field of CONTENT_FIELDS) {
    if (field !== 'bodyText') delete summary[field];
  }
  return summary;
}

function getPaperIdFromUpdateEntry(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const direct = collapseWhitespace(entry.paperId);
  if (direct) return direct;
  const rawUrl = collapseWhitespace(entry.url);
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl, 'https://llvm.org/');
    return collapseWhitespace(parsed.searchParams.get('id'));
  } catch {
    const match = rawUrl.match(/[?&]id=([^&]+)/);
    if (!match || !match[1]) return '';
    try {
      return collapseWhitespace(decodeURIComponent(match[1]));
    } catch {
      return collapseWhitespace(match[1]);
    }
  }
}

function normalizeIsoDateTime(value) {
  const raw = collapseWhitespace(value);
  if (!raw) return '';
  const stamp = new Date(raw);
  if (Number.isNaN(stamp.valueOf())) return '';
  return stamp.toISOString();
}

function buildAddedAtMap(entries) {
  const byId = new Map();
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    const kind = normalizeFilterValue(entry && entry.kind);
    if (kind !== 'paper' && kind !== 'blog') continue;
    const paperId = getPaperIdFromUpdateEntry(entry);
    if (!paperId) continue;
    const loggedAtIso = normalizeIsoDateTime(entry.loggedAt || entry.date || entry.publishedDate);
    if (!loggedAtIso) continue;
    const loggedAtTs = Date.parse(loggedAtIso);
    if (!Number.isFinite(loggedAtTs)) continue;
    const current = byId.get(paperId);
    if (!current || loggedAtTs < current.ts) {
      byId.set(paperId, { iso: loggedAtIso, ts: loggedAtTs });
    }
  }
  const out = {};
  for (const [paperId, meta] of byId.entries()) {
    out[paperId] = meta.iso;
  }
  return out;
}

function applyAddedAtMap(papers, addedAtById) {
  for (const paper of (Array.isArray(papers) ? papers : [])) {
    const paperId = collapseWhitespace(paper && paper.id);
    if (!paperId) continue;
    const addedAt = collapseWhitespace(addedAtById && addedAtById[paperId]);
    if (!addedAt) continue;
    paper.addedAt = addedAt;
    paper._addedAt = addedAt;
    const addedAtTs = Date.parse(addedAt);
    paper._addedAtTs = Number.isFinite(addedAtTs) ? addedAtTs : 0;
  }
}

function mapToSortedEntries(map) {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function mapToAlphaEntries(map) {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function addCountToMap(map, label) {
  const value = collapseWhitespace(label);
  if (!value) return;
  map.set(value, (map.get(value) || 0) + 1);
}

function buildPeopleEntriesFromBuckets(buckets) {
  return [...buckets.values()]
    .map((bucket) => {
      const label = [...bucket.labels.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
      const talkCount = bucket.talkCount || 0;
      const paperCount = bucket.paperCount || 0;
      return {
        label,
        talkCount,
        paperCount,
        count: talkCount + paperCount,
      };
    })
    .filter((entry) => entry.label)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function buildTopicEntries(talkCounts, paperCounts) {
  const labels = new Set([...talkCounts.keys(), ...paperCounts.keys()]);
  return [...labels]
    .map((label) => {
      const talkCount = talkCounts.get(label) || 0;
      const paperCount = paperCounts.get(label) || 0;
      return {
        label,
        talkCount,
        paperCount,
        count: talkCount + paperCount,
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function ensurePersonBucket(buckets, name) {
  const label = collapseWhitespace(name);
  const key = HubUtils.normalizePersonKey(label);
  if (!label || !key) return null;
  if (!buckets.has(key)) {
    buckets.set(key, {
      talkCount: 0,
      paperCount: 0,
      labels: new Map(),
    });
  }
  return buckets.get(key);
}

function buildGlobalAutocomplete(talks, papers, people) {
  const talkTopicCounts = new Map();
  const paperTopicCounts = new Map();
  const peopleBuckets = new Map();
  const talkTitleCounts = new Map();
  const paperTitleCounts = new Map();

  for (const talk of talks) {
    for (const topic of HubUtils.getTalkKeyTopics(talk, 12)) addCountToMap(talkTopicCounts, topic);
    addCountToMap(talkTitleCounts, talk.title);
    for (const speaker of (talk.speakers || [])) {
      const bucket = ensurePersonBucket(peopleBuckets, speaker && speaker.name);
      if (!bucket) continue;
      bucket.talkCount += 1;
      bucket.labels.set(speaker.name, (bucket.labels.get(speaker.name) || 0) + 1);
    }
  }

  for (const paper of papers) {
    for (const topic of HubUtils.getPaperKeyTopics(paper, 12)) addCountToMap(paperTopicCounts, topic);
    addCountToMap(paperTitleCounts, paper.title);
    for (const author of (paper.authors || [])) {
      const bucket = ensurePersonBucket(peopleBuckets, author && author.name);
      if (!bucket) continue;
      bucket.paperCount += 1;
      bucket.labels.set(author.name, (bucket.labels.get(author.name) || 0) + 1);
    }
  }

  for (const person of people) {
    const bucket = ensurePersonBucket(peopleBuckets, person.name);
    if (!bucket) continue;
    bucket.labels.set(person.name, (bucket.labels.get(person.name) || 0));
    for (const variant of (person.variantNames || [])) {
      if (!collapseWhitespace(variant)) continue;
      bucket.labels.set(variant, (bucket.labels.get(variant) || 0));
    }
  }

  const peopleEntries = [...peopleBuckets.values()]
    .map((bucket) => {
      const label = [...bucket.labels.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
      return {
        label,
        count: (bucket.talkCount || 0) + (bucket.paperCount || 0),
      };
    })
    .filter((entry) => entry.label)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, MAX_AUTOCOMPLETE_PEOPLE);

  return {
    topics: buildTopicEntries(talkTopicCounts, paperTopicCounts).slice(0, MAX_AUTOCOMPLETE_TOPICS).map(({ label, count }) => ({ label, count })),
    people: peopleEntries,
    talks: mapToAlphaEntries(talkTitleCounts).slice(0, MAX_AUTOCOMPLETE_TALKS),
    papers: mapToAlphaEntries(paperTitleCounts).slice(0, MAX_AUTOCOMPLETE_PAPERS),
  };
}

function buildTalkCatalogAutocomplete(talks) {
  const talkTopicCounts = new Map();
  const peopleBuckets = new Map();
  const talkTitleCounts = new Map();

  for (const talk of talks) {
    for (const topic of HubUtils.getTalkKeyTopics(talk, 12)) addCountToMap(talkTopicCounts, topic);
    addCountToMap(talkTitleCounts, talk.title);
    for (const speaker of (talk.speakers || [])) {
      const bucket = ensurePersonBucket(peopleBuckets, speaker && speaker.name);
      if (!bucket) continue;
      bucket.talkCount += 1;
      bucket.labels.set(speaker.name, (bucket.labels.get(speaker.name) || 0) + 1);
    }
  }

  const people = buildPeopleEntriesFromBuckets(peopleBuckets);
  return {
    tags: mapToSortedEntries(talkTopicCounts),
    speakers: people
      .filter((entry) => entry.talkCount > 0)
      .map((entry) => ({ label: entry.label, count: entry.talkCount }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    talks: mapToAlphaEntries(talkTitleCounts),
  };
}

function buildPaperScopeMetadata(papers) {
  const topicCounts = new Map();
  const yearCounts = new Map();
  const citationCounts = new Map();
  const publicationCounts = new Map();
  const affiliationCounts = new Map();
  const personBuckets = new Map();
  const paperTitleCounts = new Map();

  for (const paper of papers) {
    for (const topic of HubUtils.getPaperKeyTopics(paper, Infinity)) addCountToMap(topicCounts, topic);
    if (paper._year) yearCounts.set(paper._year, (yearCounts.get(paper._year) || 0) + 1);
    addCountToMap(paperTitleCounts, paper.title);

    const citation = Number.isFinite(Number(paper.citationCount)) ? Number(paper.citationCount) : 0;
    const citationKey = citation >= 500 ? '500+'
      : citation >= 100 ? '100-499'
      : citation >= 50 ? '50-99'
      : citation >= 10 ? '10-49'
      : citation >= 1 ? '1-9'
      : '0';
    citationCounts.set(citationKey, (citationCounts.get(citationKey) || 0) + 1);

    const publicationLabel = collapseWhitespace(HubUtils.getPaperPrimaryPublication(paper) || paper.publication);
    if (publicationLabel) {
      const publicationKey = HubUtils.normalizePublicationKey(publicationLabel);
      if (!publicationCounts.has(publicationKey)) {
        publicationCounts.set(publicationKey, { key: publicationKey, label: publicationLabel, count: 0 });
      }
      const bucket = publicationCounts.get(publicationKey);
      bucket.count += 1;
      if (publicationLabel.length > bucket.label.length) bucket.label = publicationLabel;
    }

    const seenAffiliations = new Set();
    for (const author of (paper.authors || [])) {
      const personBucket = ensurePersonBucket(personBuckets, author && author.name);
      if (personBucket) {
        personBucket.paperCount += 1;
        personBucket.labels.set(author.name, (personBucket.labels.get(author.name) || 0) + 1);
      }
      const affiliationLabel = collapseWhitespace(HubUtils.normalizeAffiliation(author && author.affiliation));
      if (!affiliationLabel) continue;
      const affiliationKey = HubUtils.normalizeAffiliationKey(affiliationLabel);
      if (!affiliationKey || seenAffiliations.has(affiliationKey)) continue;
      seenAffiliations.add(affiliationKey);
      if (!affiliationCounts.has(affiliationKey)) {
        affiliationCounts.set(affiliationKey, { key: affiliationKey, label: affiliationLabel, count: 0 });
      }
      const bucket = affiliationCounts.get(affiliationKey);
      bucket.count += 1;
      if (affiliationLabel.length > bucket.label.length) bucket.label = affiliationLabel;
    }
  }

  const people = buildPeopleEntriesFromBuckets(personBuckets);
  return {
    autocomplete: {
      tags: mapToSortedEntries(topicCounts),
      speakers: people
        .filter((entry) => entry.paperCount > 0)
        .map((entry) => ({ label: entry.label, count: entry.paperCount }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      papers: mapToAlphaEntries(paperTitleCounts),
    },
    filters: {
      topics: mapToSortedEntries(topicCounts),
      years: [...yearCounts.entries()]
        .map(([year, count]) => ({ year, count }))
        .sort((a, b) => String(b.year).localeCompare(String(a.year))),
      citations: [...citationCounts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => String(a.key).localeCompare(String(b.key))),
      publications: [...publicationCounts.values()]
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      affiliations: [...affiliationCounts.values()]
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    },
  };
}

function buildPeopleMetadata(people) {
  const topicCounts = new Map();
  const affiliationCounts = new Map();
  const publicationCounts = new Map();

  for (const person of people) {
    const seenTopics = new Set();
    for (const topic of (Array.isArray(person.topics) ? person.topics : [])) {
      const topicKey = String(topic && topic.name ? normalizeFilterValue(topic.name).replace(/[^a-z0-9+]+/g, '') : '').trim();
      if (!topicKey) continue;
      if (!topicCounts.has(topicKey)) {
        topicCounts.set(topicKey, {
          key: topicKey,
          name: collapseWhitespace(topic && topic.name),
          mentionCount: 0,
          peopleCount: 0,
        });
      }
      const bucket = topicCounts.get(topicKey);
      const count = Math.max(1, Math.round(Number(topic && topic.count) || 0));
      bucket.mentionCount += count;
      if (!seenTopics.has(topicKey)) {
        bucket.peopleCount += 1;
        seenTopics.add(topicKey);
      }
      if (collapseWhitespace(topic && topic.name).length > bucket.name.length) bucket.name = collapseWhitespace(topic && topic.name);
    }

    const seenAffiliations = new Set();
    for (const affiliation of (Array.isArray(person.affiliations) ? person.affiliations : [])) {
      const key = HubUtils.normalizeAffiliationKey(affiliation && affiliation.name);
      if (!key) continue;
      if (!affiliationCounts.has(key)) {
        affiliationCounts.set(key, {
          key,
          name: collapseWhitespace(affiliation && affiliation.name),
          mentionCount: 0,
          peopleCount: 0,
        });
      }
      const bucket = affiliationCounts.get(key);
      const count = Math.max(1, Math.round(Number(affiliation && affiliation.count) || 0));
      bucket.mentionCount += count;
      if (!seenAffiliations.has(key)) {
        bucket.peopleCount += 1;
        seenAffiliations.add(key);
      }
      if (collapseWhitespace(affiliation && affiliation.name).length > bucket.name.length) bucket.name = collapseWhitespace(affiliation && affiliation.name);
    }

    const seenPublications = new Set();
    for (const publication of (Array.isArray(person.publications) ? person.publications : [])) {
      const key = HubUtils.normalizePublicationKey(publication && publication.name);
      if (!key) continue;
      if (!publicationCounts.has(key)) {
        publicationCounts.set(key, {
          key,
          name: collapseWhitespace(publication && publication.name),
          mentionCount: 0,
          peopleCount: 0,
        });
      }
      const bucket = publicationCounts.get(key);
      const count = Math.max(1, Math.round(Number(publication && publication.count) || 0));
      bucket.mentionCount += count;
      if (!seenPublications.has(key)) {
        bucket.peopleCount += 1;
        seenPublications.add(key);
      }
      const label = collapseWhitespace(publication && publication.name);
      if (label.length > bucket.name.length && label.toLowerCase() !== 'proceedings') bucket.name = label;
    }
  }

  return {
    topics: [...topicCounts.values()].sort((a, b) => b.peopleCount - a.peopleCount || b.mentionCount - a.mentionCount || a.name.localeCompare(b.name)),
    affiliations: [...affiliationCounts.values()].sort((a, b) => b.peopleCount - a.peopleCount || b.mentionCount - a.mentionCount || a.name.localeCompare(b.name)),
    publications: [...publicationCounts.values()].sort((a, b) => b.peopleCount - a.peopleCount || b.mentionCount - a.mentionCount || a.name.localeCompare(b.name)),
  };
}

function addYearStatsToPeople(people, talks, papers, blogs) {
  const statsByKey = new Map();
  const recordYear = (name, year) => {
    const key = HubUtils.normalizePersonKey(name);
    if (!key || !Number.isFinite(year) || year <= 0) return;
    if (!statsByKey.has(key)) statsByKey.set(key, { latestYear: 0, earliestYear: 0 });
    const stats = statsByKey.get(key);
    if (year > Number(stats.latestYear || 0)) stats.latestYear = year;
    if (!stats.earliestYear || year < Number(stats.earliestYear || 0)) stats.earliestYear = year;
  };

  for (const talk of talks) {
    const year = parseYearNumber(talk._year || talk.meeting || talk.meetingDate);
    for (const speaker of (talk.speakers || [])) recordYear(speaker && speaker.name, year);
  }
  for (const paper of papers) {
    const year = parseYearNumber(paper._year || paper.year || paper.publishedDate);
    for (const author of (paper.authors || [])) recordYear(author && author.name, year);
  }
  for (const blog of blogs) {
    const year = parseYearNumber(blog._year || blog.year || blog.publishedDate);
    for (const author of (blog.authors || [])) recordYear(author && author.name, year);
  }

  return people.map((person) => {
    let latestYear = 0;
    let earliestYear = 0;
    const variants = [person.name, ...(Array.isArray(person.variantNames) ? person.variantNames : [])];
    for (const variant of variants) {
      const stats = statsByKey.get(HubUtils.normalizePersonKey(variant));
      if (!stats) continue;
      if (Number(stats.latestYear || 0) > latestYear) latestYear = Number(stats.latestYear || 0);
      const candidateEarliest = Number(stats.earliestYear || 0);
      if (candidateEarliest > 0 && (!earliestYear || candidateEarliest < earliestYear)) earliestYear = candidateEarliest;
    }
    return {
      ...person,
      _latestYear: latestYear,
      _earliestYear: earliestYear,
      _searchBlob: normalizeSearchText([
        person.name,
        ...(person.variantNames || []),
        ...(person.topics || []).map((entry) => entry && entry.name),
        ...(person.affiliations || []).map((entry) => entry && entry.name),
        ...(person.publications || []).map((entry) => entry && entry.name),
      ].filter(Boolean).join(' ')),
    };
  });
}

function countTopicOverlap(values, topicKeys) {
  let total = 0;
  for (const value of (Array.isArray(values) ? values : [])) {
    const key = normalizeSearchText(value);
    if (key && topicKeys.has(key)) total += 1;
  }
  return total;
}

function buildTalkSummaryCardData(talk) {
  return {
    id: talk.id,
    title: talk.title,
    meeting: talk.meeting,
    meetingName: talk.meetingName,
    meetingDate: talk.meetingDate,
    meetingLocation: talk.meetingLocation,
    category: talk.category,
    speakers: talk.speakers,
    slidesUrl: talk.slidesUrl,
    videoUrl: talk.videoUrl,
    sourceUrl: talk.sourceUrl,
    projectGithub: talk.projectGithub,
    tags: talk.tags,
  };
}

function buildPaperSummaryCardData(paper) {
  return {
    id: paper.id,
    title: paper.title,
    year: paper._year || paper.year,
    _year: paper._year,
    _isBlog: paper._isBlog,
    _publishedDateLabel: paper._publishedDateLabel,
    authors: paper.authors,
    tags: paper.tags,
    keywords: paper.keywords,
    publication: paper.publication,
    venue: paper.venue,
    paperUrl: paper.paperUrl,
    sourceUrl: paper.sourceUrl,
    type: paper.type,
  };
}

function buildTalkRelatedMap(talks, paperSummaries, talkReferencePayload) {
  const byTalkId = {};
  const paperById = new Map(paperSummaries.map((paper) => [paper.id, paper]));
  const talkById = new Map(talks.map((talk) => [talk.id, talk]));

  for (const talk of talks) {
    const talkId = collapseWhitespace(talk.id);
    if (!talkId) continue;
    const referenceEntry = talkReferencePayload && talkReferencePayload.talks && talkReferencePayload.talks[talkId];
    const slidePaperIds = Array.isArray(referenceEntry && referenceEntry.slidePaperIds)
      ? referenceEntry.slidePaperIds.map((value) => collapseWhitespace(value)).filter(Boolean)
      : [];
    const slideTalkIds = Array.isArray(referenceEntry && referenceEntry.slideTalkIds)
      ? referenceEntry.slideTalkIds.map((value) => collapseWhitespace(value)).filter(Boolean)
      : [];

    const topicKeys = new Set(
      HubUtils.getTalkKeyTopics(talk, Infinity)
        .map((topic) => normalizeSearchText(topic))
        .filter(Boolean)
    );
    const scoredRelatedTalks = [];
    if (topicKeys.size) {
      for (const candidate of talks) {
        const candidateId = collapseWhitespace(candidate.id);
        if (!candidateId || candidateId === talkId) continue;
        const overlap = countTopicOverlap(HubUtils.getTalkKeyTopics(candidate, Infinity), topicKeys);
        if (!overlap) continue;
        scoredRelatedTalks.push({
          talk: candidate,
          overlap,
          sameMeeting: candidate.meeting && talk.meeting && candidate.meeting === talk.meeting ? 1 : 0,
        });
      }
    }

    scoredRelatedTalks.sort((a, b) =>
      b.overlap - a.overlap
      || b.sameMeeting - a.sameMeeting
      || String(b.talk && (b.talk.meetingDate || b.talk.meeting) || '').localeCompare(String(a.talk && (a.talk.meetingDate || a.talk.meeting) || ''))
      || String(a.talk && a.talk.title || '').localeCompare(String(b.talk && b.talk.title || ''))
    );

    const relatedTalks = scoredRelatedTalks.slice(0, 6).map((entry) => buildTalkSummaryCardData(entry.talk));

    byTalkId[talkId] = {
      slidePaperIds,
      slideTalkIds,
      relatedTalkIds: relatedTalks.map((entry) => entry.id),
      referencedPapers: slidePaperIds.map((paperId) => paperById.get(paperId)).filter(Boolean).map(buildPaperSummaryCardData),
      referencedTalks: slideTalkIds.map((refId) => talkById.get(refId)).filter(Boolean).map(buildTalkSummaryCardData),
      relatedTalks,
    };
  }

  return byTalkId;
}

function getRelatedPapersForRecord(paper, relatedPool) {
  const values = Array.isArray(relatedPool) ? relatedPool : [];
  const targetId = collapseWhitespace(paper && paper.id);
  if (!targetId || !values.length) return [];

  const targetYear = collapseWhitespace(paper && paper._year);
  const targetIsBlog = !!(paper && paper._isBlog);
  const tagSet = new Set(
    HubUtils.getPaperKeyTopics(paper, Infinity)
      .map((value) => normalizeSearchText(value))
      .filter(Boolean)
  );
  if (!tagSet.size && !targetYear) return [];

  const scored = [];
  for (const candidate of values) {
    if (!candidate || typeof candidate !== 'object') continue;
    const id = collapseWhitespace(candidate.id);
    if (!id || id === targetId) continue;
    const sameYear = !!(targetYear && collapseWhitespace(candidate._year) === targetYear);
    const overlap = countTopicOverlap(HubUtils.getPaperKeyTopics(candidate, Infinity), tagSet);
    if (!sameYear && overlap < 1) continue;
    let score = 0;
    if (sameYear) score += 120;
    score += overlap * 28;
    if (!!candidate._isBlog === targetIsBlog) score += 10;
    if (candidate._year) score += Number.parseInt(candidate._year, 10) * 0.001;
    scored.push({ paper: candidate, score, overlap });
  }

  scored.sort((a, b) =>
    b.score - a.score
    || b.overlap - a.overlap
    || String(a.paper && a.paper.title || '').localeCompare(String(b.paper && b.paper.title || ''))
  );
  return scored.slice(0, 6).map((entry) => entry.paper);
}

function buildPaperRelatedMap(papers, talks, talkReferencePayload) {
  const byPaperId = {};
  const talkIdsByPaper = new Map();
  const normalizedTalkEntries = talkReferencePayload && talkReferencePayload.talks && typeof talkReferencePayload.talks === 'object'
    ? talkReferencePayload.talks
    : {};

  for (const [talkId, entry] of Object.entries(normalizedTalkEntries)) {
    const slidePaperIds = Array.isArray(entry && entry.slidePaperIds)
      ? entry.slidePaperIds.map((value) => collapseWhitespace(value)).filter(Boolean)
      : [];
    for (const paperId of slidePaperIds) {
      if (!talkIdsByPaper.has(paperId)) talkIdsByPaper.set(paperId, []);
      talkIdsByPaper.get(paperId).push(collapseWhitespace(talkId));
    }
  }

  const talkById = new Map(talks.map((talk) => [talk.id, talk]));

  for (const paper of papers) {
    const paperId = collapseWhitespace(paper.id);
    if (!paperId) continue;
    const featuredTalkIds = [...new Set((talkIdsByPaper.get(paperId) || []).filter(Boolean))];
    const featuredTalks = featuredTalkIds
      .map((talkId) => talkById.get(talkId))
      .filter(Boolean)
      .sort((a, b) => String(b && b.id || '').localeCompare(String(a && a.id || '')) || String(a && a.title || '').localeCompare(String(b && b.title || '')))
      .map(buildTalkSummaryCardData);
    const relatedPapers = getRelatedPapersForRecord(paper, papers).map(buildPaperSummaryCardData);
    byPaperId[paperId] = {
      featuredTalkIds,
      relatedPaperIds: relatedPapers.map((entry) => entry.id),
      featuredTalks,
      relatedPapers,
    };
  }

  return byPaperId;
}

function buildSiteStats(talks, meetings, papers, people) {
  const activeMeetingIds = new Set(
    (Array.isArray(meetings) ? meetings : [])
      .filter((meeting) => meeting && meeting.name && !meeting.canceled)
      .map((meeting) => collapseWhitespace(meeting.slug || meeting.name))
      .filter(Boolean)
  );
  return {
    dataVersion: '',
    generatedAt: '',
    talks: talks.length,
    papers: papers.filter((paper) => !paper._isBlog).length,
    blogs: papers.filter((paper) => paper._isBlog).length,
    people: people.length,
    meetings: activeMeetingIds.size,
  };
}

function computeShardIndex(id, shardCount) {
  const source = String(id || '');
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash * 31) + source.charCodeAt(index)) >>> 0;
  }
  return hash % shardCount;
}

function formatShardKey(index) {
  return index.toString(16).padStart(2, '0');
}

function buildDetailShards(records, rootKey, itemKey, shardCount, extraFactory = () => ({})) {
  const shards = new Map();
  for (let index = 0; index < shardCount; index += 1) {
    shards.set(formatShardKey(index), {});
  }
  for (const record of records) {
    const id = collapseWhitespace(record && record.id);
    if (!id) continue;
    const shardKey = formatShardKey(computeShardIndex(id, shardCount));
    const shard = shards.get(shardKey);
    shard[id] = {
      [itemKey]: record,
      ...extraFactory(record),
    };
  }
  return [...shards.entries()].map(([shardKey, values]) => ({
    shardKey,
    payload: {
      [rootKey]: values,
    },
  }));
}

function collectPaperSources(sources) {
  return [...new Set((Array.isArray(sources) ? sources : []).map((value) => collapseWhitespace(value)).filter(Boolean))];
}

function loadEventManifestData() {
  const manifestPath = path.join(repoRoot, 'devmtg', 'events', 'index.json');
  const manifest = readJson(manifestPath);
  const referencePayload = readJson(path.join(repoRoot, 'js', 'data', 'talk-paper-links.json'));
  const referenceIndex = referencePayload && referencePayload.talks && typeof referencePayload.talks === 'object'
    ? referencePayload.talks
    : {};

  const talks = [];
  const meetings = [];
  const inputFiles = [manifestPath, path.join(repoRoot, 'js', 'data', 'talk-paper-links.json')];

  for (const rel of (Array.isArray(manifest.eventFiles) ? manifest.eventFiles : [])) {
    const bundlePath = path.join(repoRoot, 'devmtg', 'events', rel);
    inputFiles.push(bundlePath);
    const bundle = readJson(bundlePath);
    if (bundle && bundle.meeting) meetings.push(bundle.meeting);
    for (const rawTalk of (Array.isArray(bundle && bundle.talks) ? bundle.talks : [])) {
      const merged = applyReferenceMetadataToTalk(rawTalk, referenceIndex);
      talks.push(normalizeTalkRecord(merged));
    }
  }

  return { talks, meetings, referencePayload, inputFiles, dataVersion: collapseWhitespace(manifest.dataVersion) };
}

function loadPaperManifestData() {
  const manifestPath = path.join(repoRoot, 'papers', 'index.json');
  const manifest = readJson(manifestPath);
  const papers = [];
  const sources = [];
  const inputFiles = [manifestPath, path.join(repoRoot, 'updates', 'index.json')];

  for (const rel of (Array.isArray(manifest.paperFiles) ? manifest.paperFiles : [])) {
    const bundlePath = path.join(repoRoot, 'papers', rel);
    inputFiles.push(bundlePath);
    const bundle = readJson(bundlePath);
    if (bundle && bundle.source) sources.push(bundle.source);
    for (const rawPaper of (Array.isArray(bundle && bundle.papers) ? bundle.papers : [])) {
      const normalized = normalizePaperRecord(rawPaper);
      if (normalized) papers.push(normalized);
    }
  }

  const updatesPayload = readJson(path.join(repoRoot, 'updates', 'index.json'));
  const addedAtById = buildAddedAtMap(updatesPayload && updatesPayload.entries);
  applyAddedAtMap(papers, addedAtById);
  return {
    papers,
    sources: collectPaperSources(sources),
    addedAtById,
    inputFiles,
    dataVersion: collapseWhitespace(manifest.dataVersion),
  };
}

function buildOutputs() {
  const eventData = loadEventManifestData();
  const paperData = loadPaperManifestData();

  const allTalks = eventData.talks;
  const allPapersFull = paperData.papers;
  const allPaperSummaries = allPapersFull.map(createPaperSummary);
  const paperOnlySummaries = allPaperSummaries.filter((paper) => !paper._isBlog);
  const blogSummaries = allPaperSummaries.filter((paper) => paper._isBlog);

  const peopleBase = HubUtils.buildPeopleIndex(allTalks, allPaperSummaries);
  const people = addYearStatsToPeople(peopleBase, allTalks, paperOnlySummaries, blogSummaries);
  const peopleMeta = buildPeopleMetadata(people);

  const globalAutocomplete = buildGlobalAutocomplete(allTalks, allPaperSummaries, people);
  const talkAutocomplete = buildTalkCatalogAutocomplete(allTalks);
  const paperScopeMeta = buildPaperScopeMetadata(paperOnlySummaries);
  const blogScopeMeta = buildPaperScopeMetadata(blogSummaries);

  const talkRelatedById = buildTalkRelatedMap(allTalks, allPaperSummaries, eventData.referencePayload);
  const paperRelatedById = buildPaperRelatedMap(allPaperSummaries, allTalks, eventData.referencePayload);

  const latestInputMs = [...new Set([...eventData.inputFiles, ...paperData.inputFiles, __filename, path.join(repoRoot, 'js', 'shared', 'library-utils.js')])]
    .map((pathname) => fs.statSync(pathname).mtimeMs)
    .reduce((max, value) => Math.max(max, value), 0);
  const generatedAt = new Date(latestInputMs).toISOString();

  const versionHash = sha1(
    [...new Set([...eventData.inputFiles, ...paperData.inputFiles, __filename, path.join(repoRoot, 'js', 'shared', 'library-utils.js')])]
      .sort()
      .map((pathname) => `${path.relative(repoRoot, pathname)}:${hashFile(pathname)}`)
      .join('\n')
  ).slice(0, 12);
  const dataVersion = `viewer-precomputed-v1-${versionHash}`;

  const siteStats = buildSiteStats(allTalks, eventData.meetings, allPaperSummaries, people);
  siteStats.dataVersion = dataVersion;
  siteStats.generatedAt = generatedAt;

  const talksCatalog = {
    dataVersion,
    generatedAt,
    talks: allTalks,
    meetings: eventData.meetings,
    autocomplete: talkAutocomplete,
  };

  const papersCatalog = {
    dataVersion,
    generatedAt,
    papers: allPaperSummaries,
    sources: paperData.sources,
    filters: {
      paper: paperScopeMeta.filters,
      blog: blogScopeMeta.filters,
    },
    autocomplete: {
      paper: paperScopeMeta.autocomplete,
      blog: blogScopeMeta.autocomplete,
    },
  };

  const peopleIndex = {
    dataVersion,
    generatedAt,
    people,
    topics: peopleMeta.topics,
    affiliations: peopleMeta.affiliations,
    publications: peopleMeta.publications,
    autocomplete: {
      topics: globalAutocomplete.topics.map((entry) => ({ ...entry })),
      people: people.map((person) => ({
        label: person.name,
        count: Number(person.totalCount || 0),
        searchText: normalizeSearchText([person.name, ...(person.variantNames || [])].join(' ')),
      })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      talks: globalAutocomplete.talks.map((entry) => ({ ...entry })),
      papers: globalAutocomplete.papers.map((entry) => ({ ...entry })),
    },
  };

  const workSearchCorpus = {
    dataVersion,
    generatedAt,
    talks: allTalks,
    papers: paperOnlySummaries,
    blogs: blogSummaries,
    people,
  };

  const paperAddedAt = {
    dataVersion,
    generatedAt,
    byId: paperData.addedAtById,
  };

  const talkRelated = {
    dataVersion,
    generatedAt,
    byTalkId: talkRelatedById,
  };

  const paperRelated = {
    dataVersion,
    generatedAt,
    byPaperId: paperRelatedById,
  };

  const autocompleteIndex = {
    meta: {
      source: 'scripts/build-viewer-artifacts.js',
      talkCount: allTalks.length,
      paperCount: allPaperSummaries.length,
      entryCount: {
        topics: globalAutocomplete.topics.length,
        people: globalAutocomplete.people.length,
        talks: globalAutocomplete.talks.length,
        papers: globalAutocomplete.papers.length,
      },
      generatedAt,
    },
    topics: globalAutocomplete.topics,
    people: globalAutocomplete.people,
    talks: globalAutocomplete.talks,
    papers: globalAutocomplete.papers,
  };

  const outputs = new Map();
  const put = (relPath, payload) => {
    outputs.set(relPath, `${JSON.stringify(payload, null, 2)}\n`);
  };

  put('js/data/site-stats.json', siteStats);
  put('js/data/talks-catalog.json', talksCatalog);
  put('js/data/papers-catalog.json', papersCatalog);
  put('js/data/people-index.json', peopleIndex);
  put('js/data/work-search-corpus.json', workSearchCorpus);
  put('js/data/paper-added-at.json', paperAddedAt);
  put('js/data/talk-related.json', talkRelated);
  put('js/data/paper-related.json', paperRelated);
  put('js/data/autocomplete-index.json', autocompleteIndex);

  const talkDetailShards = buildDetailShards(
    allTalks,
    'talks',
    'talk',
    SHARD_COUNT,
    (record) => ({
      meeting: eventData.meetings.find((meeting) => collapseWhitespace(meeting && meeting.slug) === collapseWhitespace(record && record.meeting)) || null,
    })
  );
  for (const { shardKey, payload } of talkDetailShards) {
    put(`js/data/talk-details/${shardKey}.json`, { dataVersion, generatedAt, ...payload });
  }

  const paperDetailShards = buildDetailShards(
    allPapersFull,
    'papers',
    'paper',
    SHARD_COUNT,
    (record) => ({
      source: collapseWhitespace(record && record.source),
    })
  );
  for (const { shardKey, payload } of paperDetailShards) {
    put(`js/data/paper-details/${shardKey}.json`, { dataVersion, generatedAt, ...payload });
  }

  const fileRefs = {};
  for (const [relPath, content] of outputs.entries()) {
    if (relPath.endsWith('.json') && !relPath.includes('/talk-details/') && !relPath.includes('/paper-details/')) {
      fileRefs[path.basename(relPath, '.json').replace(/-([a-z])/g, (_, part) => part.toUpperCase())] = `${relPath}?v=${sha1(content).slice(0, 12)}`;
    }
  }

  fileRefs.talksCatalog = `js/data/talks-catalog.json?v=${sha1(outputs.get('js/data/talks-catalog.json')).slice(0, 12)}`;
  fileRefs.papersCatalog = `js/data/papers-catalog.json?v=${sha1(outputs.get('js/data/papers-catalog.json')).slice(0, 12)}`;
  fileRefs.peopleIndex = `js/data/people-index.json?v=${sha1(outputs.get('js/data/people-index.json')).slice(0, 12)}`;
  fileRefs.workSearchCorpus = `js/data/work-search-corpus.json?v=${sha1(outputs.get('js/data/work-search-corpus.json')).slice(0, 12)}`;
  fileRefs.paperAddedAt = `js/data/paper-added-at.json?v=${sha1(outputs.get('js/data/paper-added-at.json')).slice(0, 12)}`;
  fileRefs.talkRelated = `js/data/talk-related.json?v=${sha1(outputs.get('js/data/talk-related.json')).slice(0, 12)}`;
  fileRefs.paperRelated = `js/data/paper-related.json?v=${sha1(outputs.get('js/data/paper-related.json')).slice(0, 12)}`;
  fileRefs.siteStats = `js/data/site-stats.json?v=${sha1(outputs.get('js/data/site-stats.json')).slice(0, 12)}`;
  fileRefs.autocompleteIndex = `js/data/autocomplete-index.json?v=${sha1(outputs.get('js/data/autocomplete-index.json')).slice(0, 12)}`;

  const manifest = {
    dataVersion,
    generatedAt,
    files: fileRefs,
    shards: {
      talkDetails: {
        template: `js/data/talk-details/{shard}.json?v=${dataVersion}`,
        shardCount: SHARD_COUNT,
        rootKey: 'talks',
        itemKey: 'talk',
      },
      paperDetails: {
        template: `js/data/paper-details/{shard}.json?v=${dataVersion}`,
        shardCount: SHARD_COUNT,
        rootKey: 'papers',
        itemKey: 'paper',
      },
    },
  };
  outputs.set('js/data/viewer-artifacts.json', `${JSON.stringify(manifest, null, 2)}\n`);

  return outputs;
}

function run() {
  const outputs = buildOutputs();
  const stale = [];

  for (const [relPath, content] of outputs.entries()) {
    const absPath = path.join(repoRoot, relPath);
    if (!fs.existsSync(absPath)) {
      stale.push(relPath);
      if (!args.check) writeText(absPath, content);
      continue;
    }
    const existing = readText(absPath);
    if (existing !== content) {
      stale.push(relPath);
      if (!args.check) writeText(absPath, content);
    }
  }

  if (args.check) {
    if (stale.length) {
      console.error('ERROR: viewer artifacts are stale:');
      for (const relPath of stale) console.error(` - ${relPath}`);
      process.exitCode = 1;
      return;
    }
    console.log('OK: viewer artifacts are up to date');
    return;
  }

  console.log(`Built viewer artifacts (${outputs.size} files)`);
}

run();
