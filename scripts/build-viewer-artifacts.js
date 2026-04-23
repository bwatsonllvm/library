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
const MLIR_TOPIC_TAG = 'MLIR';
const MLIR_MONTH_LOOKUP = Object.freeze({
  jan: '01', january: '01',
  feb: '02', february: '02',
  mar: '03', march: '03',
  apr: '04', april: '04',
  may: '05',
  jun: '06', june: '06',
  jul: '07', july: '07',
  aug: '08', august: '08',
  sep: '09', sept: '09', september: '09',
  oct: '10', october: '10',
  nov: '11', november: '11',
  dec: '12', december: '12',
});
const MLIR_TALK_SECTION_CATEGORY_MAP = Object.freeze({
  tutorials: 'tutorial',
  'tech-talks': 'technical-talk',
  'open-design-meeting-presentations': 'open-design-meeting',
  'upcoming-talks-or-presentations': 'technical-talk',
  'past-conferences-and-workshops': 'workshop',
});
const MLIR_EXCLUDED_TALK_SECTION_KEYS = new Set([
  'upcoming-talks-or-presentations',
  'past-conferences-and-workshops',
]);
const MLIR_GENERIC_GROUP_KEYS = new Set([
  '',
  'past-editions',
  'past-editions:',
]);
const MLIR_RESOURCE_ONLY_RE = /\b(?:slides?|recordings?|recording|transcript|talk|talks|event|events|part\s+\d+|additional slides?)\b/gi;

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

function maxIsoDate(values) {
  let bestIso = '';
  let bestTs = 0;
  for (const value of (Array.isArray(values) ? values : [])) {
    const raw = collapseWhitespace(value);
    if (!raw) continue;
    const ts = Date.parse(raw);
    if (!Number.isFinite(ts)) continue;
    if (!bestIso || ts > bestTs) {
      bestIso = new Date(ts).toISOString();
      bestTs = ts;
    }
  }
  return bestIso;
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

function isGithubRepoRootUrl(value) {
  const href = normalizeHttpUrl(value);
  if (!href) return false;
  try {
    const parsed = new URL(href);
    const host = collapseWhitespace(parsed.hostname).toLowerCase().replace(/^www\./, '');
    if (host !== 'github.com') return false;
    const parts = parsed.pathname
      .split('/')
      .map((part) => collapseWhitespace(part))
      .filter(Boolean);
    return parts.length === 2;
  } catch {
    return false;
  }
}

function extractGithubActionUrls(actions) {
  return Array.isArray(actions)
    ? [...new Set(actions
        .map((action) => action && String(action.kind || '').trim().toLowerCase() === 'github'
          ? normalizeHttpUrl(action.url)
          : '')
        .filter(Boolean))]
    : [];
}

function selectPrimaryGithubUrl(existingProjectGithub, githubUrls, existingActions) {
  const preferred = normalizeHttpUrl(existingProjectGithub);
  if (preferred && !isGithubRepoRootUrl(preferred)) return preferred;

  const candidates = [];
  const seen = new Set();
  for (const value of [preferred, ...extractGithubActionUrls(existingActions), ...(Array.isArray(githubUrls) ? githubUrls : [])]) {
    const href = normalizeHttpUrl(value);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    candidates.push(href);
  }

  const specific = candidates.find((href) => !isGithubRepoRootUrl(href));
  if (specific) return specific;
  return preferred || candidates[0] || '';
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
  const primaryGithubUrl = selectPrimaryGithubUrl(enriched.projectGithub, githubUrls, enriched.resourceActions);
  if (primaryGithubUrl) enriched.projectGithub = primaryGithubUrl;
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

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of (Array.isArray(values) ? values : [])) {
    const text = collapseWhitespace(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function slugify(value) {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeTitleKey(value) {
  return collapseWhitespace(String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' '));
}

function choosePreferredText(primary, secondary) {
  const first = collapseWhitespace(primary);
  const second = collapseWhitespace(secondary);
  if (!first) return second;
  if (!second) return first;
  return first.length >= second.length ? first : second;
}

function mergeSpeakerLists(baseSpeakers, extraSpeakers) {
  const merged = [];
  const seen = new Map();
  for (const rawSpeaker of [...(Array.isArray(baseSpeakers) ? baseSpeakers : []), ...(Array.isArray(extraSpeakers) ? extraSpeakers : [])]) {
    const speaker = normalizeSpeakerRecord(rawSpeaker);
    const key = HubUtils.normalizePersonKey(speaker && speaker.name);
    if (!speaker || !key) continue;
    if (seen.has(key)) {
      const existing = seen.get(key);
      existing.affiliation = choosePreferredText(existing.affiliation, speaker.affiliation);
      existing.github = sanitizeExternalUrl(existing.github) || sanitizeExternalUrl(speaker.github);
      existing.linkedin = sanitizeExternalUrl(existing.linkedin) || sanitizeExternalUrl(speaker.linkedin);
      existing.twitter = sanitizeExternalUrl(existing.twitter) || sanitizeExternalUrl(speaker.twitter);
      continue;
    }
    const next = {
      name: speaker.name,
      affiliation: speaker.affiliation,
      github: sanitizeExternalUrl(speaker.github),
      linkedin: sanitizeExternalUrl(speaker.linkedin),
      twitter: sanitizeExternalUrl(speaker.twitter),
    };
    seen.set(key, next);
    merged.push(next);
  }
  return merged;
}

function mergeActionLists(actionsA, actionsB) {
  const merged = [];
  const byUrl = new Map();
  for (const rawAction of [...(Array.isArray(actionsA) ? actionsA : []), ...(Array.isArray(actionsB) ? actionsB : [])]) {
    const url = sanitizeExternalUrl(rawAction && rawAction.url);
    if (!url) continue;
    const kind = collapseWhitespace(rawAction && rawAction.kind).toLowerCase();
    const label = collapseWhitespace(rawAction && rawAction.label);
    const existing = byUrl.get(url);
    if (existing) {
      if (!existing.kind && kind) existing.kind = kind;
      if (!existing.label && label) existing.label = label;
      continue;
    }
    const action = { kind, label, url };
    byUrl.set(url, action);
    merged.push(action);
  }
  return merged;
}

function mergeUrlLists(valuesA, valuesB) {
  return [...new Set([
    ...(Array.isArray(valuesA) ? valuesA : []),
    ...(Array.isArray(valuesB) ? valuesB : []),
  ].map((value) => normalizeHttpUrl(value)).filter(Boolean))];
}

function mergeGithubReferenceItemLists(itemsA, itemsB) {
  const merged = [];
  const byUrl = new Map();
  for (const rawItem of [...(Array.isArray(itemsA) ? itemsA : []), ...(Array.isArray(itemsB) ? itemsB : [])]) {
    const url = normalizeHttpUrl(rawItem && rawItem.url);
    if (!url) continue;
    const existing = byUrl.get(url);
    if (existing) {
      existing.source = choosePreferredText(existing.source, rawItem && rawItem.source);
      existing.label = choosePreferredText(existing.label, rawItem && rawItem.label);
      existing.context = choosePreferredText(existing.context, rawItem && rawItem.context);
      existing.library = choosePreferredText(existing.library, rawItem && rawItem.library);
      existing.repository = choosePreferredText(existing.repository, rawItem && rawItem.repository);
      existing.fileName = choosePreferredText(existing.fileName, rawItem && rawItem.fileName);
      existing.filePath = choosePreferredText(existing.filePath, rawItem && rawItem.filePath);
      existing.referencePath = choosePreferredText(existing.referencePath, rawItem && rawItem.referencePath);
      continue;
    }
    const item = {
      url,
      source: collapseWhitespace(rawItem && rawItem.source),
      label: collapseWhitespace(rawItem && rawItem.label),
      context: collapseWhitespace(rawItem && rawItem.context),
      library: collapseWhitespace(rawItem && rawItem.library),
      repository: collapseWhitespace(rawItem && rawItem.repository),
      fileName: collapseWhitespace(rawItem && rawItem.fileName),
      filePath: collapseWhitespace(rawItem && rawItem.filePath),
      referencePath: collapseWhitespace(rawItem && rawItem.referencePath),
    };
    byUrl.set(url, item);
    merged.push(item);
  }
  return merged;
}

function cleanMlirTopicLabel(value) {
  const text = collapseWhitespace(value).replace(/:$/, '');
  const key = slugify(text);
  if (!text || MLIR_GENERIC_GROUP_KEYS.has(key)) return '';
  return text;
}

function cleanMlirTalkTitle(value) {
  let title = collapseWhitespace(value);
  if (!title) return '';

  title = title
    .replace(/^\d{4}-\d{2}(?:-\d{2}(?:\/\d{2})?)?(?:\s*&\s*\d{4}-\d{2}(?:-\d{2})?)?\s*:\s*/i, '')
    .trim();

  title = title
    .replace(/\s*\((?:slides?|recordings?|recording|transcript)\s*$/i, '')
    .replace(/\s*[-;:]\s*(?:slides?|recordings?|recording|transcript|additional slides?)\s*$/i, '')
    .replace(/\s+(?:slides?|recordings?|recording|transcript)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[(:;\-]+$/g, '')
    .trim();

  return title;
}

function pad2(value) {
  return String(value || '').padStart(2, '0');
}

function parseMlirDateFromTitle(title) {
  const match = collapseWhitespace(title).match(/^(\d{4})-(\d{2})-(\d{2})(?:\b|[:\s-])/);
  if (!match) return null;
  return {
    sortKey: `${match[1]}-${match[2]}-${match[3]}`,
    label: `${match[1]}-${match[2]}-${match[3]}`,
    year: match[1],
  };
}

function parseMlirDateFromText(text) {
  const match = collapseWhitespace(text).match(
    /\b(January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sept|Sep|October|Oct|November|Nov|December|Dec)\s+(\d{1,2})(?:\s*[-/]\s*(\d{1,2}))?,?\s+((?:19|20)\d{2})\b/i
  );
  if (!match) return null;
  const month = MLIR_MONTH_LOOKUP[String(match[1] || '').toLowerCase()];
  if (!month) return null;
  return {
    sortKey: `${match[4]}-${month}-${pad2(match[2])}`,
    label: collapseWhitespace(match[0]),
    year: String(match[4]),
  };
}

function parseMlirDateFromUrls(urls) {
  for (const url of (Array.isArray(urls) ? urls : [])) {
    const text = String(url || '');
    const exact = text.match(/\/((?:19|20)\d{2})-(\d{2})-(\d{2})(?:[^\d]|$)/);
    if (exact) {
      return {
        sortKey: `${exact[1]}-${exact[2]}-${exact[3]}`,
        label: `${exact[1]}-${exact[2]}-${exact[3]}`,
        year: exact[1],
      };
    }
    const monthMatch = text.match(/\/((?:19|20)\d{2})-(\d{2})(?:[^\d]|$)/);
    if (monthMatch) {
      return {
        sortKey: `${monthMatch[1]}-${monthMatch[2]}-00`,
        label: `${monthMatch[1]}-${monthMatch[2]}`,
        year: monthMatch[1],
      };
    }
    const yearMatch = text.match(/\/((?:19|20)\d{2})(?:[^\d]|$)/);
    if (yearMatch) {
      return {
        sortKey: `${yearMatch[1]}-00-00`,
        label: yearMatch[1],
        year: yearMatch[1],
      };
    }
  }
  return null;
}

function parseMlirTalkDateInfo(entry, actions) {
  const fromTitle = parseMlirDateFromTitle(entry && entry.title);
  if (fromTitle) return fromTitle;

  const fromText = parseMlirDateFromText(entry && (entry.summary || entry.text));
  if (fromText) return fromText;

  const fromUrls = parseMlirDateFromUrls((actions || []).map((action) => action && action.url));
  if (fromUrls) return fromUrls;

  const fallbackYearMatch = collapseWhitespace(entry && (entry.summary || entry.text || entry.title)).match(/\b((?:19|20)\d{2})\b/);
  if (fallbackYearMatch) {
    return {
      sortKey: `${fallbackYearMatch[1]}-00-00`,
      label: fallbackYearMatch[1],
      year: fallbackYearMatch[1],
    };
  }

  return {
    sortKey: '0000-00-00',
    label: '',
    year: '',
  };
}

function cleanMlirEventName(value) {
  return collapseWhitespace(value)
    .replace(/\.$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function inferMlirMeetingName(entry, sectionTitle, groupTitle, actions) {
  const summary = collapseWhitespace(entry && entry.summary);
  const text = collapseWhitespace(entry && entry.text);
  const title = collapseWhitespace(entry && entry.title);

  if (summary.includes(' @ ')) {
    return cleanMlirEventName(summary.split(' @ ').pop());
  }
  if (text.includes(' @ ')) {
    return cleanMlirEventName(text.split(' @ ').pop());
  }

  const prefixMatch = title.match(/^([^:]+):/);
  if (prefixMatch && /\b((?:19|20)\d{2})\b/.test(prefixMatch[1])) {
    return cleanMlirEventName(
      prefixMatch[1]
        .replace(/\b(Keynote|Talk|Tutorial|Presentation|Workshop)\b/gi, '')
        .replace(/\s{2,}/g, ' ')
    );
  }

  if (slugify(sectionTitle) === 'open-design-meeting-presentations') {
    return 'MLIR Open Design Meeting';
  }

  const eventAction = (actions || []).find((action) => action && action.kind === 'event' && collapseWhitespace(action.label).toLowerCase() !== 'event');
  if (eventAction) return cleanMlirEventName(eventAction.label);

  return cleanMlirTopicLabel(groupTitle) || collapseWhitespace(sectionTitle) || 'MLIR Talk';
}

function normalizeMlirSpeakerName(value) {
  const normalized = HubUtils.normalizePersonRecord({ name: value });
  const name = collapseWhitespace(normalized && normalized.name ? normalized.name : value);
  return name
    .replace(/\((?:filling in for|moderator|host)[^)]+\)/gi, '')
    .replace(/\b(?:filling in for|moderator|host)\b.*$/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,;:]+|[,;:]+$/g, '')
    .trim();
}

function looksLikeMlirPersonName(value) {
  const text = normalizeMlirSpeakerName(value);
  if (!text || /\d/.test(text)) return false;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6) return false;
  if (tokens.some((token) => ['by', 'of', 'for', 'in', 'to'].includes(token.toLowerCase()))) return false;
  return tokens.every((token) => {
    const cleaned = token.replace(/^[.'’()-]+|[.'’()-]+$/g, '');
    if (!cleaned) return false;
    return /^[A-Za-zÀ-ÖØ-öø-ÿ]+(?:[.'’-][A-Za-zÀ-ÖØ-öø-ÿ]+)*$/.test(cleaned);
  });
}

function looksLikeMlirSpeakerList(value) {
  const text = collapseWhitespace(value);
  if (!text) return false;
  const parts = text.split(/\s*(?:,| and |\/|;)\s*/i).map((part) => normalizeMlirSpeakerName(part)).filter(Boolean);
  if (!parts.length || parts.length > 6) return false;
  return parts.every((part) => looksLikeMlirPersonName(part));
}

function extractMlirTalkSpeakers(entry, actions) {
  if (Array.isArray(entry && entry.speakers) && entry.speakers.length) {
    return entry.speakers
      .map((speaker) => ({
        name: normalizeMlirSpeakerName(speaker && speaker.name),
        affiliation: collapseWhitespace(speaker && speaker.affiliation),
      }))
      .filter((speaker) => looksLikeMlirPersonName(speaker.name));
  }

  const rawCandidates = [];
  for (const source of [entry && entry.summary, entry && entry.text]) {
    let candidate = collapseWhitespace(source);
    if (!candidate) continue;
    if (candidate.includes(' @ ')) candidate = candidate.split(' @ ')[0];
    if (candidate.includes(';')) candidate = candidate.split(';').pop();
    candidate = candidate
      .replace(/\b(?:slides?|recordings?|recording|transcript|event|talk|part\s+\d+|additional slides?)\b/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (candidate) rawCandidates.push(candidate);
  }
  for (const action of (Array.isArray(actions) ? actions : [])) {
    const label = normalizeMlirSpeakerName(action && action.label);
    if (looksLikeMlirPersonName(label)) rawCandidates.push(label);
  }

  const speakers = [];
  const seen = new Set();
  for (const candidate of rawCandidates) {
    const names = candidate.split(/\s*(?:,| and |\/)\s*/i);
    for (const rawName of names) {
      const name = normalizeMlirSpeakerName(rawName);
      const key = name.toLowerCase();
      if (!looksLikeMlirPersonName(name) || seen.has(key)) continue;
      seen.add(key);
      speakers.push({ name, affiliation: '' });
    }
    if (speakers.length) break;
  }

  return speakers;
}

function stripMlirTalkMetadata(value) {
  return collapseWhitespace(value)
    .replace(/\s+@\s+.+$/, '')
    .replace(MLIR_RESOURCE_ONLY_RE, ' ')
    .replace(/\s*[-;:,/]\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildMlirTalkAbstract(entry, speakers) {
  const explicit = collapseWhitespace(entry && entry.abstract);
  if (explicit) return explicit;

  const title = cleanMlirTalkTitle(entry && entry.title);
  const titleLower = title.toLowerCase();
  const rawCandidates = [
    collapseWhitespace(entry && entry.summary),
    collapseWhitespace(entry && entry.text),
  ];

  for (const raw of rawCandidates) {
    if (!raw) continue;
    let candidate = raw;
    if (title && candidate.toLowerCase().startsWith(titleLower)) {
      candidate = candidate.slice(title.length).trim();
    }
    candidate = stripMlirTalkMetadata(candidate);
    if (!candidate) continue;
    if (looksLikeMlirSpeakerList(candidate)) continue;
    if (Array.isArray(speakers) && speakers.length) {
      const speakerNames = speakers.map((speaker) => normalizeMlirSpeakerName(speaker && speaker.name).toLowerCase());
      if (speakerNames.includes(candidate.toLowerCase())) continue;
    }
    if (candidate.split(/\s+/).length < 4) continue;
    return candidate;
  }

  return '';
}

function pickAction(actions, predicate) {
  return (Array.isArray(actions) ? actions : []).find((action) => action && predicate(action)) || null;
}

function buildSharedTalkDetailUrl(talkId) {
  const id = collapseWhitespace(talkId);
  if (!id) return 'talks/talk.html';
  return `talks/talk.html?id=${encodeURIComponent(id)}`;
}

function pickMlirTalkSourceUrl(actions, fallbackUrl, blockedUrls) {
  const blocked = blockedUrls instanceof Set ? blockedUrls : new Set();
  const candidates = Array.isArray(actions)
    ? actions.filter((action) => action && ['primary', 'link', 'event'].includes(action.kind))
    : [];

  for (const action of candidates) {
    const url = collapseWhitespace(action && action.url);
    if (!url || blocked.has(url)) continue;
    return url;
  }

  const fallback = collapseWhitespace(fallbackUrl);
  if (fallback && !blocked.has(fallback)) return fallback;
  return '';
}

function buildMlirTalkRecord(entry, sectionTitle, groupTitle, fallbackUrl) {
  const actions = Array.isArray(entry && entry.actions)
    ? entry.actions
        .map((action) => ({
          kind: collapseWhitespace(action && action.kind).toLowerCase(),
          label: collapseWhitespace(action && action.label),
          url: sanitizeExternalUrl(action && action.url),
        }))
        .filter((action) => action.url)
    : [];

  const primaryAction = pickAction(actions, (action) => action.kind === 'primary')
    || pickAction(actions, (action) => action.kind === 'slides')
    || pickAction(actions, (action) => action.kind === 'recording')
    || pickAction(actions, (action) => action.kind === 'event')
    || pickAction(actions, (action) => action.kind === 'link')
    || actions[0]
    || null;

  const talkId = collapseWhitespace(entry && entry.id)
    || slugify(entry && entry.title)
    || slugify(collapseWhitespace(primaryAction && primaryAction.url) || fallbackUrl);
  const videoAction = pickAction(actions, (action) => action.kind === 'recording')
    || (primaryAction && (primaryAction.kind === 'recording' || (typeof HubUtils.extractYouTubeId === 'function' && HubUtils.extractYouTubeId(primaryAction.url)))
      ? primaryAction
      : null);
  const slidesAction = pickAction(actions, (action) => action.kind === 'slides');
  const posterAction = pickAction(actions, (action) => action.kind === 'poster');
  const githubAction = pickAction(actions, (action) => /github\.com/i.test(action.url));
  const videoUrl = collapseWhitespace(videoAction && videoAction.url);
  const slidesUrl = collapseWhitespace(slidesAction && slidesAction.url);
  const posterUrl = collapseWhitespace(posterAction && posterAction.url);
  const sourceUrl = pickMlirTalkSourceUrl(actions, fallbackUrl, new Set([videoUrl, slidesUrl, posterUrl].filter(Boolean)));
  const detailUrl = buildSharedTalkDetailUrl(talkId);

  const cleanedTitle = collapseWhitespace(entry && entry.displayTitle) || cleanMlirTalkTitle(entry && entry.title) || 'Untitled MLIR Talk';
  const speakers = extractMlirTalkSpeakers(entry, actions);
  const abstract = buildMlirTalkAbstract({ ...entry, title: cleanedTitle }, speakers);
  const meetingName = inferMlirMeetingName({ ...entry, title: cleanedTitle }, sectionTitle, groupTitle, actions);
  const dateInfo = parseMlirTalkDateInfo(entry, actions);
  const sortSuffix = slugify(meetingName || cleanedTitle || talkId).slice(0, 48);
  const meeting = sortSuffix
    ? `${dateInfo.sortKey}-${sortSuffix}`
    : dateInfo.sortKey;

  const tags = uniqueStrings([
    MLIR_TOPIC_TAG,
    cleanMlirTopicLabel(groupTitle),
    ...(slugify(sectionTitle) === 'open-design-meeting-presentations' ? ['Open Design Meeting'] : []),
  ]);

  return {
    id: talkId,
    title: cleanedTitle,
    abstract,
    speakers,
    resourceActions: actions,
    category: MLIR_TALK_SECTION_CATEGORY_MAP[slugify(sectionTitle)] || 'other',
    tags,
    meeting,
    meetingName,
    meetingDate: dateInfo.label,
    meetingLocation: '',
    videoUrl,
    slidesUrl,
    posterUrl,
    projectGithub: collapseWhitespace(githubAction && githubAction.url),
    sourceUrl,
    detailUrl,
    mlirSection: collapseWhitespace(sectionTitle),
    mlirGroup: cleanMlirTopicLabel(groupTitle),
    _mlirSourceUpstream: true,
  };
}

function extractMlirTalks(payload) {
  const fallbackUrl = sanitizeExternalUrl(payload && payload.sourceUrl);
  const talks = [];

  for (const section of (Array.isArray(payload && payload.sections) ? payload.sections : [])) {
    const sectionTitle = collapseWhitespace(section && section.title);
    const sectionKey = slugify(sectionTitle);
    if (MLIR_EXCLUDED_TALK_SECTION_KEYS.has(sectionKey)) continue;
    for (const group of (Array.isArray(section && section.groups) ? section.groups : [])) {
      const groupTitle = collapseWhitespace(group && group.title);
      for (const entry of (Array.isArray(group && group.entries) ? group.entries : [])) {
        if (!entry || typeof entry !== 'object') continue;
        talks.push(buildMlirTalkRecord(entry, sectionTitle, groupTitle, fallbackUrl));
      }
    }
  }

  return talks.filter((talk) => talk.id && talk.title);
}

function talkYear(talk) {
  return String(
    parseYearNumber(
      talk && (
        talk.meetingDate
        || talk.meeting
        || talk.meetingName
        || talk.title
      )
    ) || ''
  );
}

function buildTalkMatchIndex(talks) {
  const index = {
    byExact: new Map(),
    byTitle: new Map(),
  };
  for (const talk of (Array.isArray(talks) ? talks : [])) {
    addTalkToMatchIndex(index, talk);
  }
  return index;
}

function addTalkToMatchIndex(index, talk) {
  if (!index || !talk) return;
  const titleKey = normalizeTitleKey(talk && talk.title);
  const year = talkYear(talk);
  if (!titleKey) return;
  if (year) index.byExact.set(`${titleKey}|${year}`, talk);
  if (!index.byTitle.has(titleKey)) index.byTitle.set(titleKey, []);
  index.byTitle.get(titleKey).push(talk);
}

function findMatchingTalkRecord(candidateTalk, index) {
  const titleKey = normalizeTitleKey(candidateTalk && candidateTalk.title);
  if (!titleKey || !index) return null;

  const year = talkYear(candidateTalk);
  if (year) {
    const exact = index.byExact.get(`${titleKey}|${year}`);
    if (exact) return exact;
  }

  const candidates = index.byTitle.get(titleKey) || [];
  return candidates.length === 1 ? candidates[0] : null;
}

function mergeTalkRecords(baseTalk, extraTalk) {
  const merged = { ...baseTalk };
  merged.title = choosePreferredText(baseTalk && baseTalk.title, extraTalk && extraTalk.title);
  merged.abstract = choosePreferredText(baseTalk && baseTalk.abstract, extraTalk && extraTalk.abstract);
  merged.meeting = choosePreferredText(baseTalk && baseTalk.meeting, extraTalk && extraTalk.meeting);
  merged.meetingName = choosePreferredText(baseTalk && baseTalk.meetingName, extraTalk && extraTalk.meetingName);
  merged.meetingDate = choosePreferredText(baseTalk && baseTalk.meetingDate, extraTalk && extraTalk.meetingDate);
  merged.meetingLocation = choosePreferredText(baseTalk && baseTalk.meetingLocation, extraTalk && extraTalk.meetingLocation);
  merged.videoUrl = sanitizeExternalUrl(baseTalk && baseTalk.videoUrl) || sanitizeExternalUrl(extraTalk && extraTalk.videoUrl);
  merged.videoId = collapseWhitespace(baseTalk && baseTalk.videoId) || collapseWhitespace(extraTalk && extraTalk.videoId);
  merged.slidesUrl = sanitizeExternalUrl(baseTalk && baseTalk.slidesUrl) || sanitizeExternalUrl(extraTalk && extraTalk.slidesUrl);
  merged.posterUrl = sanitizeExternalUrl(baseTalk && baseTalk.posterUrl) || sanitizeExternalUrl(extraTalk && extraTalk.posterUrl);
  const mergedResourceActions = mergeActionLists(baseTalk && baseTalk.resourceActions, extraTalk && extraTalk.resourceActions);
  merged.resourceActions = mergedResourceActions;
  merged.projectGithub = selectPrimaryGithubUrl(
    sanitizeExternalUrl(baseTalk && baseTalk.projectGithub) || sanitizeExternalUrl(extraTalk && extraTalk.projectGithub),
    [
      baseTalk && baseTalk.projectGithub,
      extraTalk && extraTalk.projectGithub,
      ...(Array.isArray(baseTalk && baseTalk.githubReferences) ? baseTalk.githubReferences : []),
      ...(Array.isArray(extraTalk && extraTalk.githubReferences) ? extraTalk.githubReferences : []),
    ],
    mergedResourceActions
  );
  merged.sourceUrl = sanitizeExternalUrl(baseTalk && baseTalk.sourceUrl) || sanitizeExternalUrl(extraTalk && extraTalk.sourceUrl);
  merged.detailUrl = collapseWhitespace(baseTalk && baseTalk.detailUrl) || collapseWhitespace(extraTalk && extraTalk.detailUrl);
  merged.tags = uniqueStrings([...(Array.isArray(baseTalk && baseTalk.tags) ? baseTalk.tags : []), ...(Array.isArray(extraTalk && extraTalk.tags) ? extraTalk.tags : [])]);
  merged.keywords = uniqueStrings([...(Array.isArray(baseTalk && baseTalk.keywords) ? baseTalk.keywords : []), ...(Array.isArray(extraTalk && extraTalk.keywords) ? extraTalk.keywords : [])]);
  merged.speakers = mergeSpeakerLists(baseTalk && baseTalk.speakers, extraTalk && extraTalk.speakers);
  merged.githubReferences = mergeUrlLists(baseTalk && baseTalk.githubReferences, extraTalk && extraTalk.githubReferences);
  merged.githubReferenceItems = mergeGithubReferenceItemLists(baseTalk && baseTalk.githubReferenceItems, extraTalk && extraTalk.githubReferenceItems);
  merged._mlirSourceUpstream = !!(baseTalk && baseTalk._mlirSourceUpstream) || !!(extraTalk && extraTalk._mlirSourceUpstream);
  return merged;
}

function normalizeMlirPublicationActions(entry) {
  return Array.isArray(entry && entry.actions)
    ? entry.actions
        .map((action) => ({
          kind: collapseWhitespace(action && action.kind).toLowerCase(),
          label: collapseWhitespace(action && action.label),
          url: sanitizeExternalUrl(action && action.url),
        }))
        .filter((action) => action.label && action.url)
    : [];
}

function buildMlirPublicationPrimaryHref(actions, fallbackUrl) {
  const primaryAction = actions.find((action) => action.kind === 'primary')
    || actions.find((action) => action.kind === 'preprint')
    || actions[0]
    || null;
  return collapseWhitespace(primaryAction && primaryAction.url) || sanitizeExternalUrl(fallbackUrl);
}

function extractMlirPublicationYear(entry) {
  const match = collapseWhitespace([
    entry && entry.title,
    entry && entry.summary,
    entry && entry.text,
  ].join(' ')).match(/\b((?:19|20)\d{2})\b/);
  return match ? match[1] : '';
}

function extractMlirPublicationAuthors(entry) {
  const summary = collapseWhitespace(entry && entry.summary);
  const authorSegment = summary.split(' - ')[0] || summary;
  return uniqueStrings(
    authorSegment
      .split(/\s*,\s*|\s+and\s+/i)
      .map((value) => collapseWhitespace(value))
      .filter((value) => value && !/\bproceedings\b/i.test(value))
  );
}

function extractMlirPublicationVenue(entry) {
  const summary = collapseWhitespace(entry && entry.summary);
  const segments = summary.split(' - ').map((value) => collapseWhitespace(value)).filter(Boolean);
  if (segments.length <= 1) return '';
  return segments.slice(1).join(' - ');
}

function buildPaperLookupIndex(papers) {
  const index = {
    byTitle: new Map(),
    byDoi: new Map(),
    byUrl: new Map(),
  };
  for (const paper of (Array.isArray(papers) ? papers : [])) {
    addPaperToLookupIndex(index, paper);
  }
  return index;
}

function addPaperToLookupIndex(index, paper) {
  if (!index || !paper) return;
  const titleKey = normalizeTitleKey(paper && paper.title);
  if (titleKey && !index.byTitle.has(titleKey)) {
    index.byTitle.set(titleKey, paper);
  }
  const doi = extractDoi(paper && (paper.doi || paper.paperUrl || paper.sourceUrl)).toLowerCase();
  if (doi && !index.byDoi.has(doi)) {
    index.byDoi.set(doi, paper);
  }
  for (const url of [paper && paper.paperUrl, paper && paper.sourceUrl]) {
    const normalizedUrl = sanitizeExternalUrl(url);
    if (normalizedUrl && !index.byUrl.has(normalizedUrl)) {
      index.byUrl.set(normalizedUrl, paper);
    }
  }
}

function findMatchingPaperForMlirEntry(entry, paperIndex) {
  if (!paperIndex) return null;
  const actions = normalizeMlirPublicationActions(entry);

  for (const action of actions) {
    const doi = extractDoi(action.url).toLowerCase();
    if (doi && paperIndex.byDoi.has(doi)) return paperIndex.byDoi.get(doi) || null;
  }

  const titleKey = normalizeTitleKey(entry && entry.title);
  if (titleKey && paperIndex.byTitle.has(titleKey)) {
    return paperIndex.byTitle.get(titleKey) || null;
  }

  for (const action of actions) {
    const url = sanitizeExternalUrl(action.url);
    if (url && paperIndex.byUrl.has(url)) return paperIndex.byUrl.get(url) || null;
  }

  return null;
}

function mergePaperWithMlirEntry(paper, entry, fallbackUrl) {
  const actions = normalizeMlirPublicationActions(entry);
  const primaryUrl = buildMlirPublicationPrimaryHref(actions, fallbackUrl);
  const merged = {
    ...paper,
    abstract: choosePreferredText(paper && paper.abstract, entry && entry.summary),
    year: collapseWhitespace(paper && paper.year) || extractMlirPublicationYear(entry),
    publication: choosePreferredText(paper && paper.publication, extractMlirPublicationVenue(entry)),
    paperUrl: sanitizeExternalUrl(paper && paper.paperUrl) || primaryUrl,
    sourceUrl: sanitizeExternalUrl(paper && paper.sourceUrl) || sanitizeExternalUrl(fallbackUrl),
    type: collapseWhitespace(paper && paper.type) || 'paper',
    tags: uniqueStrings([...(Array.isArray(paper && paper.tags) ? paper.tags : []), MLIR_TOPIC_TAG]),
    keywords: uniqueStrings([...(Array.isArray(paper && paper.keywords) ? paper.keywords : []), MLIR_TOPIC_TAG]),
    matchedSubprojects: uniqueStrings([...(Array.isArray(paper && paper.matchedSubprojects) ? paper.matchedSubprojects : []), MLIR_TOPIC_TAG]),
    authors: (Array.isArray(paper && paper.authors) && paper.authors.length)
      ? paper.authors
      : extractMlirPublicationAuthors(entry).map((name) => ({ name })),
    _mlirSourceUpstream: true,
  };
  return normalizePaperRecord(merged);
}

function buildSyntheticPaperFromMlirEntry(entry, fallbackUrl) {
  const actions = normalizeMlirPublicationActions(entry);
  const title = collapseWhitespace(entry && entry.title) || 'Untitled MLIR Publication';
  const year = extractMlirPublicationYear(entry);
  const venue = extractMlirPublicationVenue(entry);
  return normalizePaperRecord({
    id: collapseWhitespace(entry && entry.id) || `mlir-pub-${slugify(title)}`,
    title,
    abstract: collapseWhitespace(entry && entry.summary),
    year,
    publication: venue,
    type: 'paper',
    source: 'mlir-publications',
    sourceName: 'MLIR Publications',
    authors: extractMlirPublicationAuthors(entry).map((name) => ({ name })),
    paperUrl: buildMlirPublicationPrimaryHref(actions, fallbackUrl),
    sourceUrl: sanitizeExternalUrl(fallbackUrl),
    tags: [MLIR_TOPIC_TAG],
    keywords: [MLIR_TOPIC_TAG],
    matchedSubprojects: [MLIR_TOPIC_TAG],
    citationCount: 0,
    _mlirSourceUpstream: true,
  });
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

function buildTalkSummaryCardData(talk) {
  return {
    id: talk.id,
    title: talk.title,
    abstract: talk.abstract,
    meeting: talk.meeting,
    meetingName: talk.meetingName,
    meetingDate: talk.meetingDate,
    meetingLocation: talk.meetingLocation,
    category: talk.category,
    speakers: talk.speakers,
    slidesUrl: talk.slidesUrl,
    posterUrl: talk.posterUrl,
    videoUrl: talk.videoUrl,
    sourceUrl: talk.sourceUrl,
    detailUrl: talk.detailUrl,
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

    const relatedTalks = HubUtils.getRelatedTalkCandidates(talk, talks, { limit: 6 }).map(buildTalkSummaryCardData);

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
    const relatedPapers = HubUtils.getRelatedPaperCandidates(paper, papers, { limit: 6 }).map(buildPaperSummaryCardData);
    byPaperId[paperId] = {
      featuredTalkIds,
      relatedPaperIds: relatedPapers.map((entry) => entry.id),
      featuredTalks,
      relatedPapers,
    };
  }

  return byPaperId;
}

function isCanceledMeeting(meeting) {
  if (!meeting || typeof meeting !== 'object') return false;
  if (meeting.canceled === true) return true;
  const location = String(meeting.location || '').toLowerCase();
  return location.includes('canceled') || location.includes('cancelled');
}

function isDevelopersMeeting(meeting) {
  if (!meeting || typeof meeting !== 'object') return false;
  if (isCanceledMeeting(meeting)) return false;
  const name = String(meeting.name || '').toLowerCase();
  return name.includes("llvm developers' meeting");
}

function buildSiteStats(talks, meetings, papers, people) {
  const activeMeetingIds = new Set(
    (Array.isArray(meetings) ? meetings : [])
      .filter((meeting) => meeting && meeting.name && isDevelopersMeeting(meeting))
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
  const referencePath = path.join(repoRoot, 'js', 'data', 'talk-paper-links.json');
  const referencePayload = readJson(referencePath);
  const mlirTalksPath = path.join(repoRoot, 'sub-projects', 'mlir', 'data', 'talks.json');
  const referenceIndex = referencePayload && referencePayload.talks && typeof referencePayload.talks === 'object'
    ? referencePayload.talks
    : {};

  const talks = [];
  const meetings = [];
  const inputFiles = [manifestPath, referencePath, mlirTalksPath];

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

  const mergedTalks = talks.map((talk) => ({ ...talk }));
  const talkMatchIndex = buildTalkMatchIndex(mergedTalks);
  const mlirTalksPayload = readJson(mlirTalksPath);
  for (const upstreamTalk of extractMlirTalks(mlirTalksPayload)) {
    const match = findMatchingTalkRecord(upstreamTalk, talkMatchIndex);
    if (match) {
      Object.assign(match, mergeTalkRecords(match, upstreamTalk));
      continue;
    }
    const syntheticTalk = { ...upstreamTalk };
    mergedTalks.push(syntheticTalk);
    addTalkToMatchIndex(talkMatchIndex, syntheticTalk);
  }
  const normalizedTalks = mergedTalks.map((talk) => normalizeTalkRecord(applyReferenceMetadataToTalk(talk, referenceIndex)));

  return {
    talks: normalizedTalks,
    meetings,
    referencePayload,
    inputFiles,
    dataVersion: collapseWhitespace(manifest.dataVersion),
    generatedAt: maxIsoDate([referencePayload && referencePayload.generatedAt, mlirTalksPayload && mlirTalksPayload.generatedAt]),
  };
}

function loadPaperManifestData() {
  const manifestPath = path.join(repoRoot, 'papers', 'index.json');
  const manifest = readJson(manifestPath);
  const papers = [];
  const sources = [];
  const updatesPath = path.join(repoRoot, 'updates', 'index.json');
  const mlirPublicationsPath = path.join(repoRoot, 'sub-projects', 'mlir', 'data', 'publications.json');
  const inputFiles = [manifestPath, updatesPath, mlirPublicationsPath];

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

  const mlirPublicationsPayload = readJson(mlirPublicationsPath);
  const fallbackMlirPublicationsUrl = sanitizeExternalUrl(mlirPublicationsPayload && mlirPublicationsPayload.sourceUrl);
  const mergedPapers = papers.map((paper) => ({ ...paper }));
  const paperLookupIndex = buildPaperLookupIndex(mergedPapers);
  let addedSyntheticMlirPaper = false;

  for (const section of (Array.isArray(mlirPublicationsPayload && mlirPublicationsPayload.sections) ? mlirPublicationsPayload.sections : [])) {
    for (const group of (Array.isArray(section && section.groups) ? section.groups : [])) {
      for (const entry of (Array.isArray(group && group.entries) ? group.entries : [])) {
        if (!entry || typeof entry !== 'object') continue;
        const linkedPaper = findMatchingPaperForMlirEntry(entry, paperLookupIndex);
        if (linkedPaper) {
          const mergedPaper = mergePaperWithMlirEntry(linkedPaper, entry, fallbackMlirPublicationsUrl);
          Object.assign(linkedPaper, mergedPaper);
          addPaperToLookupIndex(paperLookupIndex, linkedPaper);
          continue;
        }
        const syntheticPaper = buildSyntheticPaperFromMlirEntry(entry, fallbackMlirPublicationsUrl);
        if (!syntheticPaper) continue;
        mergedPapers.push(syntheticPaper);
        addPaperToLookupIndex(paperLookupIndex, syntheticPaper);
        addedSyntheticMlirPaper = true;
      }
    }
  }

  if (addedSyntheticMlirPaper) sources.push('mlir-publications');

  const updatesPayload = readJson(updatesPath);
  const addedAtById = buildAddedAtMap(updatesPayload && updatesPayload.entries);
  applyAddedAtMap(mergedPapers, addedAtById);
  return {
    papers: mergedPapers,
    sources: collectPaperSources(sources),
    addedAtById,
    inputFiles,
    dataVersion: collapseWhitespace(manifest.dataVersion),
    generatedAt: maxIsoDate([updatesPayload && updatesPayload.generatedAt, mlirPublicationsPayload && mlirPublicationsPayload.generatedAt]),
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

  const generationInputs = [...new Set([
    ...eventData.inputFiles,
    ...paperData.inputFiles,
    __filename,
    path.join(repoRoot, 'js', 'shared', 'library-utils.js'),
  ])];
  const generatedAt = maxIsoDate([
    eventData.generatedAt,
    paperData.generatedAt,
  ]) || '1970-01-01T00:00:00.000Z';

  const versionHash = sha1(
    generationInputs
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
