/**
 * mlir-browser.js - combined MLIR talks + papers browser for the /mlir/ route.
 */

(function () {
  const HubUtils = window.LLVMHubUtils || {};
  const PageShell = typeof HubUtils.createPageShell === 'function'
    ? HubUtils.createPageShell()
    : null;

  const initTheme = PageShell ? () => PageShell.initTheme() : () => {};
  const initTextSize = PageShell ? () => PageShell.initTextSize() : () => {};
  const initCustomizationMenu = PageShell ? () => PageShell.initCustomizationMenu() : () => {};
  const initMobileNavMenu = PageShell ? () => PageShell.initMobileNavMenu() : () => {};
  const initShareMenu = PageShell ? () => PageShell.initShareMenu() : () => {};
  const safeSessionSet = PageShell ? PageShell.safeSessionSet : () => {};
  const safeSessionRemove = PageShell ? PageShell.safeSessionRemove : () => {};

  const getTalkKeyTopicsFromHub = typeof HubUtils.getTalkKeyTopics === 'function'
    ? HubUtils.getTalkKeyTopics.bind(HubUtils)
    : null;
  const getPaperKeyTopicsFromHub = typeof HubUtils.getPaperKeyTopics === 'function'
    ? HubUtils.getPaperKeyTopics.bind(HubUtils)
    : null;
  const normalizeTalksFromHub = typeof HubUtils.normalizeTalks === 'function'
    ? HubUtils.normalizeTalks.bind(HubUtils)
    : null;
  const normalizePersonKeyFromHub = typeof HubUtils.normalizePersonKey === 'function'
    ? HubUtils.normalizePersonKey.bind(HubUtils)
    : null;
  const normalizeTalkCategoryFromHub = typeof HubUtils.normalizeTalkCategory === 'function'
    ? HubUtils.normalizeTalkCategory.bind(HubUtils)
    : null;
  const categoryOrderFromHub = HubUtils && typeof HubUtils.CATEGORY_ORDER === 'object' && HubUtils.CATEGORY_ORDER
    ? HubUtils.CATEGORY_ORDER
    : null;

  const CURATED_PUBS_DATA_PATH = 'sub-projects/mlir/data/publications.json';
  const INTERNAL_PAPER_PAGE_PATH = 'papers/paper.html';
  const INITIAL_BATCH_SIZE = 60;
  const RENDER_BATCH_SIZE = 40;
  const LOAD_MORE_ROOT_MARGIN = '900px 0px';
  const DIRECT_PDF_URL_RE = /\.pdf(?:$|[?#])|\/pdf(?:$|[/?#])|[?&](?:format|type|output)=pdf(?:$|[&#])|[?&]filename=[^&#]*\.pdf(?:$|[&#])/i;
  const BLOG_SOURCE_SLUGS = new Set(['llvm-blog-www', 'llvm-www-blog']);
  const TALK_CATEGORY_LABELS = Object.freeze({
    keynote: 'Keynote',
    'technical-talk': 'Technical Talk',
    tutorial: 'Tutorial',
    panel: 'Panel',
    'quick-talk': 'Quick Talk',
    'lightning-talk': 'Lightning Talk',
    'student-talk': 'Student Technical Talk',
    'llvm-foundation': 'LLVM Foundation',
    'open-design-meeting': 'Open Design Meeting',
    bof: 'BoF',
    poster: 'Poster',
    workshop: 'Workshop',
    other: 'Other',
  });
  const TALK_CATEGORY_ORDER = Object.freeze({
    keynote: 0,
    'technical-talk': 1,
    tutorial: 2,
    panel: 3,
    'quick-talk': 4,
    'lightning-talk': 5,
    'student-talk': 6,
    'llvm-foundation': 7,
    'open-design-meeting': 8,
    bof: 9,
    poster: 10,
    workshop: 11,
    other: 12,
  });
  const SCOPE_LABELS = Object.freeze({
    all: 'Works',
    talks: 'Talks',
    papers: 'Papers',
  });
  const state = {
    query: '',
    source: 'all',
    scope: 'all',
    activeTopics: new Set(),
    years: new Set(),
    talkTypes: new Set(),
  };

  let allItems = [];
  let filteredItems = [];
  let renderedCount = 0;
  let loadMoreObserver = null;
  let loadMoreScrollHandler = null;
  let currentSourceCounts = {
    all: { works: 0, talks: 0, papers: 0 },
    official: { works: 0, talks: 0, papers: 0 },
  };
  let currentScopeCounts = { works: 0, talks: 0, papers: 0 };
  let currentSelectedCounts = { works: 0, talks: 0, papers: 0 };

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function collapseWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function sanitizeExternalUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw, document.baseURI);
      const protocol = parsed.protocol.toLowerCase();
      if (protocol === 'http:' || protocol === 'https:') return parsed.toString();
    } catch {
      return '';
    }
    return '';
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

  function normalizeKey(value) {
    return collapseWhitespace(value).toLowerCase();
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

  function normalizeTopicKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function normalizePersonKey(value) {
    if (normalizePersonKeyFromHub) return normalizePersonKeyFromHub(value);
    return normalizeKey(value);
  }

  function normalizeTalkCategory(value) {
    if (normalizeTalkCategoryFromHub) return normalizeTalkCategoryFromHub(value);
    const normalized = collapseWhitespace(value).toLowerCase();
    return TALK_CATEGORY_LABELS[normalized] ? normalized : 'other';
  }

  function truncateText(value, maxLength) {
    const text = collapseWhitespace(value);
    if (!text || text.length <= maxLength) return text;
    const slice = text.slice(0, maxLength);
    const boundary = slice.lastIndexOf(' ');
    return `${collapseWhitespace(boundary > 120 ? slice.slice(0, boundary) : slice)}…`;
  }

  function getTalkKeyTopics(talk, limit = Infinity) {
    return getTalkKeyTopicsFromHub ? getTalkKeyTopicsFromHub(talk, limit) : [];
  }

  function getPaperKeyTopics(paper, limit = Infinity) {
    if (getPaperKeyTopicsFromHub) return getPaperKeyTopicsFromHub(paper, limit);
    return uniqueStrings([
      ...(Array.isArray(paper && paper.tags) ? paper.tags : []),
      ...(Array.isArray(paper && paper.keywords) ? paper.keywords : []),
      ...(Array.isArray(paper && paper.matchedSubprojects) ? paper.matchedSubprojects : []),
    ]).slice(0, limit);
  }

  function normalizeTalks(rawTalks) {
    return normalizeTalksFromHub ? normalizeTalksFromHub(rawTalks) : (Array.isArray(rawTalks) ? rawTalks : []);
  }

  function isDirectPdfUrl(value) {
    return DIRECT_PDF_URL_RE.test(String(value || '').trim());
  }

  function extractDoi(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const match = raw.match(/10\.\d{4,9}\/[\w.()\-;/:%+]+/i);
    return match ? String(match[0]).trim().toLowerCase() : '';
  }

  function isBlogPaper(paper) {
    if (!paper || typeof paper !== 'object') return false;
    if (paper._isBlog === true) return true;
    const source = String(paper.source || '').trim().toLowerCase();
    const type = String(paper.type || '').trim().toLowerCase();
    const sourceUrl = String(paper.sourceUrl || '').trim();
    const paperUrl = String(paper.paperUrl || '').trim();
    return BLOG_SOURCE_SLUGS.has(source)
      || type === 'blog'
      || type === 'blog-post'
      || /^https?:\/\/(?:www\.)?blog\.llvm\.org\//i.test(sourceUrl)
      || /github\.com\/llvm\/(?:llvm-blog-www|llvm-www-blog)\b/i.test(paperUrl);
  }

  function parseYearNumber(value) {
    const match = String(value || '').match(/\b((?:19|20)\d{2})\b/);
    return match ? Number.parseInt(match[1], 10) : 0;
  }

  function buildDateStamp(value, fallbackYear) {
    const raw = collapseWhitespace(value);
    const exact = raw.match(/\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/);
    if (exact) return Number(`${exact[1]}${exact[2]}${exact[3]}`);
    const month = raw.match(/\b((?:19|20)\d{2})-(\d{2})\b/);
    if (month) return Number(`${month[1]}${month[2]}00`);
    const year = parseYearNumber(raw) || parseYearNumber(fallbackYear);
    return year ? Number(`${year}0000`) : 0;
  }

  function parseCsvParam(value) {
    return uniqueStrings(String(value || '').split(',').map((item) => item || ''));
  }

  function buildCurrentPageUrl(overrides) {
    const params = new URLSearchParams(window.location.search);
    const next = {
      query: Object.prototype.hasOwnProperty.call(overrides || {}, 'query') ? overrides.query : state.query,
      source: Object.prototype.hasOwnProperty.call(overrides || {}, 'source') ? overrides.source : state.source,
      scope: Object.prototype.hasOwnProperty.call(overrides || {}, 'scope') ? overrides.scope : state.scope,
      tags: Object.prototype.hasOwnProperty.call(overrides || {}, 'tags') ? overrides.tags : [...state.activeTopics],
      years: Object.prototype.hasOwnProperty.call(overrides || {}, 'years') ? overrides.years : [...state.years],
      talkTypes: Object.prototype.hasOwnProperty.call(overrides || {}, 'talkTypes') ? overrides.talkTypes : [...state.talkTypes],
    };

    params.delete('q');
    params.delete('source');
    params.delete('scope');
    params.delete('tag');
    params.delete('year');
    params.delete('talkType');

    if (collapseWhitespace(next.query)) params.set('q', collapseWhitespace(next.query));
    if (next.source === 'official') params.set('source', 'official');
    if (next.scope === 'talks' || next.scope === 'papers') params.set('scope', next.scope);

    const tags = uniqueStrings(Array.isArray(next.tags) ? next.tags : []);
    const years = uniqueStrings(Array.isArray(next.years) ? next.years : []);
    const talkTypes = uniqueStrings(Array.isArray(next.talkTypes) ? next.talkTypes : []);

    if (tags.length) params.set('tag', tags.join(','));
    if (years.length) params.set('year', years.join(','));
    if (talkTypes.length) params.set('talkType', talkTypes.join(','));

    return `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
  }

  function updateUrl() {
    const nextUrl = buildCurrentPageUrl({});
    window.history.replaceState({}, '', nextUrl);
  }

  function buildSpeakerQueryHref(name) {
    return buildCurrentPageUrl({
      query: name,
      tags: [],
      years: [],
      talkTypes: [],
    });
  }

  function buildTopicFilterHref(topic) {
    return buildCurrentPageUrl({
      query: '',
      tags: [topic],
      years: [],
      talkTypes: [],
    });
  }

  function buildTalkDetailUrl(talk) {
    const explicit = sanitizeExternalUrl(talk && talk.detailUrl);
    if (explicit) return explicit;
    return `talks/talk.html?id=${encodeURIComponent(collapseWhitespace(talk && talk.id))}`;
  }

  function buildPaperDetailUrl(paper) {
    const id = collapseWhitespace(paper && paper.id);
    if (!id) return '';
    return `${INTERNAL_PAPER_PAGE_PATH}?id=${encodeURIComponent(id)}&from=mlir-pubs`;
  }

  function describeSourceLabel(record) {
    const upstream = !!(record && record._mlirSourceUpstream);
    if (upstream) return 'mlir.llvm.org';
    return '';
  }

  function talkCategoryLabel(category) {
    const key = normalizeTalkCategory(category);
    return TALK_CATEGORY_LABELS[key] || TALK_CATEGORY_LABELS.other;
  }

  function normalizeTalkResourceActions(talk) {
    return Array.isArray(talk && talk.resourceActions)
      ? talk.resourceActions
          .map((action) => ({
            kind: collapseWhitespace(action && action.kind).toLowerCase(),
            label: collapseWhitespace(action && action.label),
            url: sanitizeExternalUrl(action && action.url),
          }))
          .filter((action) => action.url)
      : [];
  }

  function mergeResourceActions(actionsA, actionsB) {
    const merged = [];
    const seen = new Set();
    for (const action of [...(Array.isArray(actionsA) ? actionsA : []), ...(Array.isArray(actionsB) ? actionsB : [])]) {
      const url = sanitizeExternalUrl(action && action.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      merged.push({
        kind: collapseWhitespace(action && action.kind).toLowerCase(),
        label: collapseWhitespace(action && action.label),
        url,
      });
    }
    return merged;
  }

  function mergeSpeakers(baseSpeakers, extraSpeakers) {
    const merged = [];
    const seen = new Set();
    for (const speaker of [...(Array.isArray(baseSpeakers) ? baseSpeakers : []), ...(Array.isArray(extraSpeakers) ? extraSpeakers : [])]) {
      const name = collapseWhitespace(speaker && speaker.name);
      const key = normalizePersonKey(name);
      if (!name || !key || seen.has(key)) continue;
      seen.add(key);
      merged.push({
        name,
        affiliation: collapseWhitespace(speaker && speaker.affiliation),
      });
    }
    return merged;
  }

  function choosePreferredText(primary, secondary) {
    const first = collapseWhitespace(primary);
    const second = collapseWhitespace(secondary);
    if (!first) return second;
    if (!second) return first;
    return first.length >= second.length ? first : second;
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

  function buildTalkMergeIndex(talks) {
    const byExact = new Map();
    const byTitle = new Map();
    for (const talk of (Array.isArray(talks) ? talks : [])) {
      const titleKey = normalizeTitleKey(talk && talk.title);
      const year = talkYear(talk);
      if (!titleKey) continue;
      if (year) byExact.set(`${titleKey}|${year}`, talk);
      if (!byTitle.has(titleKey)) byTitle.set(titleKey, []);
      byTitle.get(titleKey).push(talk);
    }
    return { byExact, byTitle };
  }

  function findMatchingArchiveTalk(upstreamTalk, index) {
    const titleKey = normalizeTitleKey(upstreamTalk && upstreamTalk.title);
    if (!titleKey || !index) return null;

    const year = talkYear(upstreamTalk);
    if (year) {
      const exact = index.byExact.get(`${titleKey}|${year}`);
      if (exact) return exact;
    }

    const candidates = index.byTitle.get(titleKey) || [];
    return candidates.length === 1 ? candidates[0] : null;
  }

  function mergeTalkRecords(baseTalk, extraTalk, extraIsUpstream) {
    const merged = { ...baseTalk };
    const sourceArchive = !!(baseTalk && baseTalk._mlirSourceArchive) || !!(extraTalk && extraTalk._mlirSourceArchive);
    const sourceUpstream = !!(baseTalk && baseTalk._mlirSourceUpstream) || !!extraIsUpstream || !!(extraTalk && extraTalk._mlirSourceUpstream);

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
    merged.projectGithub = sanitizeExternalUrl(baseTalk && baseTalk.projectGithub) || sanitizeExternalUrl(extraTalk && extraTalk.projectGithub);
    merged.sourceUrl = sanitizeExternalUrl(baseTalk && baseTalk.sourceUrl) || sanitizeExternalUrl(extraTalk && extraTalk.sourceUrl);
    merged.detailUrl = sanitizeExternalUrl(baseTalk && baseTalk.detailUrl) || sanitizeExternalUrl(extraTalk && extraTalk.detailUrl);
    merged.tags = uniqueStrings([...(Array.isArray(baseTalk && baseTalk.tags) ? baseTalk.tags : []), ...(Array.isArray(extraTalk && extraTalk.tags) ? extraTalk.tags : [])]);
    merged.speakers = mergeSpeakers(baseTalk && baseTalk.speakers, extraTalk && extraTalk.speakers);
    merged.resourceActions = mergeResourceActions(baseTalk && baseTalk.resourceActions, extraTalk && extraTalk.resourceActions);
    merged._mlirSourceArchive = sourceArchive;
    merged._mlirSourceUpstream = sourceUpstream;
    return merged;
  }

  function normalizeActions(entry) {
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

  function buildPrimaryHref(actions, fallbackUrl) {
    const primaryAction = actions.find((action) => action.kind === 'primary')
      || actions.find((action) => action.kind === 'preprint')
      || actions[0]
      || null;
    return collapseWhitespace(primaryAction && primaryAction.url) || sanitizeExternalUrl(fallbackUrl);
  }

  function extractYearFromEntry(entry) {
    const match = collapseWhitespace([
      entry && entry.title,
      entry && entry.summary,
      entry && entry.text,
    ].join(' ')).match(/\b((?:19|20)\d{2})\b/);
    return match ? match[1] : '';
  }

  function extractAuthorsFromEntry(entry) {
    const summary = collapseWhitespace(entry && entry.summary);
    const authorSegment = summary.split(' - ')[0] || summary;
    return uniqueStrings(
      authorSegment
        .split(/\s*,\s*|\s+and\s+/i)
        .map((value) => collapseWhitespace(value))
        .filter((value) => value && !/\bproceedings\b/i.test(value))
    );
  }

  function extractVenueFromEntry(entry) {
    const summary = collapseWhitespace(entry && entry.summary);
    const segments = summary.split(' - ').map((value) => collapseWhitespace(value)).filter(Boolean);
    if (segments.length <= 1) return '';
    return segments.slice(1).join(' - ');
  }

  function normalizePaperRecord(rawPaper) {
    if (!rawPaper || typeof rawPaper !== 'object') return null;
    const paper = { ...rawPaper };
    paper.id = collapseWhitespace(paper.id);
    paper.title = collapseWhitespace(paper.title);
    paper.abstract = collapseWhitespace(paper.abstract);
    paper._year = collapseWhitespace(paper._year || paper.year);
    paper.year = collapseWhitespace(paper.year || paper._year);
    paper.publication = collapseWhitespace(paper.publication || paper.venue);
    paper.paperUrl = sanitizeExternalUrl(paper.paperUrl || '');
    paper.sourceUrl = sanitizeExternalUrl(paper.sourceUrl || '');
    paper.doi = extractDoi(paper.doi || paper.paperUrl || paper.sourceUrl || '');
    paper.authors = Array.isArray(paper.authors)
      ? paper.authors
          .map((author) => {
            const name = collapseWhitespace(author && author.name);
            return name ? { name, affiliation: collapseWhitespace(author && author.affiliation) } : null;
          })
          .filter(Boolean)
      : [];
    paper.tags = uniqueStrings([
      ...(Array.isArray(paper.tags) ? paper.tags : []),
      ...(Array.isArray(paper.keywords) ? paper.keywords : []),
      ...(Array.isArray(paper.matchedSubprojects) ? paper.matchedSubprojects : []),
    ]);
    paper.titleKey = normalizeTitleKey(paper.title);
    paper._citationCount = Number.isFinite(Number(paper._citationCount)) ? Number(paper._citationCount) : 0;
    paper._hasInternalDetail = typeof paper._hasInternalDetail === 'boolean' ? paper._hasInternalDetail : !!paper.id;
    paper._mlirSourceArchive = !!paper._mlirSourceArchive;
    paper._mlirSourceUpstream = !!paper._mlirSourceUpstream;
    paper._mlirExternalActions = Array.isArray(paper._mlirExternalActions) ? paper._mlirExternalActions : [];
    return paper.id && paper.title ? paper : null;
  }

  function buildPaperIndex(papers) {
    const index = {
      byTitle: new Map(),
      byDoi: new Map(),
      byUrl: new Map(),
    };

    for (const paper of (Array.isArray(papers) ? papers : [])) {
      if (!paper) continue;
      if (paper.titleKey && !index.byTitle.has(paper.titleKey)) {
        index.byTitle.set(paper.titleKey, paper);
      }
      if (paper.doi && !index.byDoi.has(paper.doi)) {
        index.byDoi.set(paper.doi, paper);
      }
      for (const url of [paper.paperUrl, paper.sourceUrl]) {
        const normalizedUrl = sanitizeExternalUrl(url);
        if (normalizedUrl && !index.byUrl.has(normalizedUrl)) {
          index.byUrl.set(normalizedUrl, paper);
        }
      }
    }

    return index;
  }

  function findLinkedPaper(entry, paperIndex) {
    if (!paperIndex) return null;
    const actions = normalizeActions(entry);

    for (const action of actions) {
      const doi = extractDoi(action.url);
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

  function mergePaperActions(existingActions, extraActions) {
    const merged = [];
    const seen = new Set();
    for (const action of [...(Array.isArray(existingActions) ? existingActions : []), ...(Array.isArray(extraActions) ? extraActions : [])]) {
      const url = sanitizeExternalUrl(action && action.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      merged.push({
        kind: collapseWhitespace(action && action.kind).toLowerCase(),
        label: collapseWhitespace(action && action.label),
        url,
      });
    }
    return merged;
  }

  function buildSyntheticPaperFromEntry(entry, fallbackUrl) {
    const actions = normalizeActions(entry);
    const title = collapseWhitespace(entry && entry.title) || 'Untitled MLIR Publication';
    const year = extractYearFromEntry(entry);
    const venue = extractVenueFromEntry(entry);
    return normalizePaperRecord({
      id: `mlir-curated-${slugify(title)}`,
      title,
      abstract: collapseWhitespace(entry && entry.summary),
      _year: year,
      year,
      publication: venue,
      authors: extractAuthorsFromEntry(entry).map((name) => ({ name })),
      paperUrl: buildPrimaryHref(actions, fallbackUrl),
      sourceUrl: sanitizeExternalUrl(fallbackUrl),
      tags: ['MLIR'],
      matchedSubprojects: ['MLIR'],
      _hasInternalDetail: false,
      _mlirSourceArchive: false,
      _mlirSourceUpstream: true,
      _mlirExternalActions: actions,
    });
  }

  function emptyCounts() {
    return { works: 0, talks: 0, papers: 0 };
  }

  function buildSourceCounts(items) {
    const counts = {
      all: emptyCounts(),
      official: emptyCounts(),
    };

    for (const item of (Array.isArray(items) ? items : [])) {
      if (!item) continue;
      counts.all.works += 1;
      if (item.kind === 'talk') counts.all.talks += 1;
      if (item.kind === 'paper') counts.all.papers += 1;

      if (item.sourceUpstream) {
        counts.official.works += 1;
        if (item.kind === 'talk') counts.official.talks += 1;
        if (item.kind === 'paper') counts.official.papers += 1;
      }
    }

    return counts;
  }

  function buildScopeCounts(items) {
    const counts = emptyCounts();
    for (const item of (Array.isArray(items) ? items : [])) {
      if (!item) continue;
      counts.works += 1;
      if (item.kind === 'talk') counts.talks += 1;
      if (item.kind === 'paper') counts.papers += 1;
    }
    return counts;
  }

  function countForScope(counts, scope) {
    const normalizedScope = scope === 'talks' || scope === 'papers' ? scope : 'all';
    if (normalizedScope === 'talks') return Number(counts && counts.talks) || 0;
    if (normalizedScope === 'papers') return Number(counts && counts.papers) || 0;
    return Number(counts && counts.works) || 0;
  }

  function tokenizeQuery(value) {
    return uniqueStrings(
      String(value || '')
        .toLowerCase()
        .split(/[^a-z0-9+#.]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    );
  }

  function buildTalkSearchIndex(talk, topics) {
    const speakerNames = Array.isArray(talk && talk.speakers)
      ? talk.speakers.map((speaker) => collapseWhitespace(speaker && speaker.name)).filter(Boolean)
      : [];
    return {
      title: normalizeKey(talk && talk.title),
      abstract: normalizeKey(talk && talk.abstract),
      names: normalizeKey(speakerNames.join(' ')),
      topics: normalizeKey((Array.isArray(topics) ? topics : []).join(' ')),
      meta: normalizeKey([talk && talk.meetingName, talk && talk.meetingDate, talk && talk.category].join(' ')),
    };
  }

  function buildPaperSearchIndex(paper, topics) {
    const authorNames = Array.isArray(paper && paper.authors)
      ? paper.authors.map((author) => collapseWhitespace(author && author.name)).filter(Boolean)
      : [];
    return {
      title: normalizeKey(paper && paper.title),
      abstract: normalizeKey(paper && paper.abstract),
      names: normalizeKey(authorNames.join(' ')),
      topics: normalizeKey((Array.isArray(topics) ? topics : []).join(' ')),
      meta: normalizeKey([paper && paper.publication, paper && paper._year, paper && paper.year].join(' ')),
    };
  }

  function computeMatchScore(searchIndex, tokens, rawQuery) {
    if (!tokens.length) return 0;
    const phrase = normalizeKey(rawQuery);
    let score = 0;
    for (const token of tokens) {
      let tokenScore = 0;
      if (searchIndex.title.includes(token)) tokenScore = Math.max(tokenScore, 10);
      if (searchIndex.names.includes(token)) tokenScore = Math.max(tokenScore, 8);
      if (searchIndex.topics.includes(token)) tokenScore = Math.max(tokenScore, 7);
      if (searchIndex.abstract.includes(token)) tokenScore = Math.max(tokenScore, 4);
      if (searchIndex.meta.includes(token)) tokenScore = Math.max(tokenScore, 3);
      if (!tokenScore) return 0;
      score += tokenScore;
    }
    if (phrase && searchIndex.title.includes(phrase)) score += 12;
    return score;
  }

  function buildTalkItem(talk) {
    const topics = getTalkKeyTopics(talk, 8);
    const searchIndex = buildTalkSearchIndex(talk, topics);
    return {
      kind: 'talk',
      talk,
      title: collapseWhitespace(talk && talk.title) || 'Untitled MLIR Talk',
      sourceUpstream: !!(talk && talk._mlirSourceUpstream),
      sourceArchive: !!(talk && talk._mlirSourceArchive),
      sourceLabel: describeSourceLabel(talk),
      topics,
      topicKeys: new Set(topics.map(normalizeTopicKey)),
      searchIndex,
      year: talkYear(talk),
      talkCategory: normalizeTalkCategory(talk && talk.category),
      sortStamp: buildDateStamp(
        `${collapseWhitespace(talk && talk.meetingDate)} ${collapseWhitespace(talk && talk.meeting)}`,
        talk && talk.title
      ),
    };
  }

  function buildPaperItem(paper) {
    const topics = getPaperKeyTopics(paper, 8);
    const searchIndex = buildPaperSearchIndex(paper, topics);
    return {
      kind: 'paper',
      paper,
      title: collapseWhitespace(paper && paper.title) || 'Untitled MLIR Paper',
      sourceUpstream: !!(paper && paper._mlirSourceUpstream),
      sourceArchive: !!(paper && paper._mlirSourceArchive),
      sourceLabel: describeSourceLabel(paper),
      topics,
      topicKeys: new Set(topics.map(normalizeTopicKey)),
      searchIndex,
      year: collapseWhitespace(paper && (paper._year || paper.year)),
      talkCategory: '',
      sortStamp: buildDateStamp(
        `${collapseWhitespace(paper && paper.publishedDate)} ${collapseWhitespace(paper && paper.year)} ${collapseWhitespace(paper && paper._year)}`,
        paper && paper.title
      ),
    };
  }

  function matchesSelectedSource(item, source = state.source) {
    if (source === 'official') return !!(item && item.sourceUpstream);
    return true;
  }

  function matchesSelectedScope(item, scope = state.scope) {
    if (scope === 'talks') return !!item && item.kind === 'talk';
    if (scope === 'papers') return !!item && item.kind === 'paper';
    return true;
  }

  function matchesSelectedTopics(item, topics = state.activeTopics) {
    if (!topics || !topics.size) return true;
    const itemTopicKeys = item && item.topicKeys instanceof Set ? item.topicKeys : new Set();
    for (const topic of topics) {
      if (itemTopicKeys.has(normalizeTopicKey(topic))) return true;
    }
    return false;
  }

  function matchesSelectedYears(item, years = state.years) {
    if (!years || !years.size) return true;
    const year = collapseWhitespace(item && item.year);
    return !!year && years.has(year);
  }

  function matchesSelectedTalkTypes(item, talkTypes = state.talkTypes, scope = state.scope) {
    if (!talkTypes || !talkTypes.size) return true;
    if (scope !== 'talks') return true;
    if (!item || item.kind !== 'talk') return false;
    return talkTypes.has(collapseWhitespace(item.talkCategory));
  }

  function matchesSelectedFilters(item, overrides) {
    const options = overrides || {};
    return matchesSelectedTopics(item, options.topics !== undefined ? options.topics : state.activeTopics)
      && matchesSelectedYears(item, options.years !== undefined ? options.years : state.years)
      && matchesSelectedTalkTypes(
        item,
        options.talkTypes !== undefined ? options.talkTypes : state.talkTypes,
        options.scope !== undefined ? options.scope : state.scope
      );
  }

  function compareItems(a, b) {
    const scoreDiff = (b._queryScore || 0) - (a._queryScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    const dateDiff = (b.sortStamp || 0) - (a.sortStamp || 0);
    if (dateDiff !== 0) return dateDiff;
    const sourceDiff = ((b.sourceUpstream ? 1 : 0) + (b.sourceArchive ? 1 : 0)) - ((a.sourceUpstream ? 1 : 0) + (a.sourceArchive ? 1 : 0));
    if (sourceDiff !== 0) return sourceDiff;
    if (a.kind !== b.kind) return a.kind === 'talk' ? -1 : 1;
    return String(a.title || '').localeCompare(String(b.title || ''));
  }

  function buildSpeakerLinks(names) {
    const values = uniqueStrings(names);
    if (!values.length) return '';
    return values
      .map((name) => `<a class="speaker-btn" href="${escapeHtml(buildSpeakerQueryHref(name))}">${escapeHtml(name)}</a>`)
      .join('<span class="speaker-btn-sep">, </span>');
  }

  function renderTopicTags(topics) {
    const shown = (Array.isArray(topics) ? topics : []).slice(0, 4);
    if (!shown.length) return '';
    return `
      <div class="card-tags-wrap">
        <div class="card-tags" aria-label="Key Topics">
          ${shown.map((topic) => `<a class="card-tag" href="${escapeHtml(buildTopicFilterHref(topic))}">${escapeHtml(topic)}</a>`).join('')}
          ${topics.length > shown.length ? `<span class="card-tag card-tag--more" aria-hidden="true">+${topics.length - shown.length}</span>` : ''}
        </div>
      </div>`;
  }

  function renderTalkActionButtons(talk) {
    const buttons = [];
    const seen = new Set();
    const resourceActions = normalizeTalkResourceActions(talk);

    function pushButton(label, url, extraClass) {
      const href = sanitizeExternalUrl(url);
      const text = collapseWhitespace(label);
      if (!href || !text || seen.has(href)) return;
      seen.add(href);
      buttons.push(
        `<a href="${escapeHtml(href)}" class="card-link-btn${extraClass ? ` ${extraClass}` : ''}" target="_blank" rel="noopener noreferrer"><span aria-hidden="true">${escapeHtml(text)}</span></a>`
      );
    }

    if (talk && talk.videoUrl) pushButton('Watch', talk.videoUrl, 'card-link-btn--video');
    if (talk && talk.slidesUrl) {
      const label = String(talk && talk.category || '').trim().toLowerCase() === 'poster' ? 'Poster' : 'Slides';
      pushButton(label, talk.slidesUrl, '');
    }
    if (talk && talk.projectGithub) pushButton('GitHub', talk.projectGithub, '');

    for (const action of resourceActions) {
      if (!action.url) continue;
      if (action.kind === 'recording') {
        pushButton(action.label || 'Recording', action.url, 'card-link-btn--video');
        continue;
      }
      if (action.kind === 'slides') {
        pushButton(action.label || 'Slides', action.url, '');
        continue;
      }
      if (action.kind === 'github' || /github\.com/i.test(action.url)) {
        pushButton(action.label || 'GitHub', action.url, '');
      }
    }

    return buttons.join('');
  }

  function normalizePaperExternalActionLabel(action) {
    const url = sanitizeExternalUrl(action && action.url);
    const label = collapseWhitespace(action && action.label);
    const kind = collapseWhitespace(action && action.kind).toLowerCase();

    if (kind === 'faq') return 'FAQ';
    if (kind === 'preprint') return /arxiv/i.test(label || url) ? 'arXiv' : (label || 'Preprint');
    if (isDirectPdfUrl(url)) return 'PDF';
    if (/arxiv\.org/i.test(url)) return 'arXiv';
    if (kind === 'primary' && extractDoi(url)) return 'Publisher';
    if (kind === 'primary' && label.toLowerCase() === 'paper') return 'Publisher';
    return label || 'Source';
  }

  function renderPaperActionButtons(paper) {
    const buttons = [];
    const seen = new Set();
    const detailHref = paper && paper._hasInternalDetail ? buildPaperDetailUrl(paper) : '';

    function pushButton(label, url, extraClass, external) {
      const href = external ? sanitizeExternalUrl(url) : collapseWhitespace(url);
      const text = collapseWhitespace(label);
      if (!href || !text || seen.has(href)) return;
      seen.add(href);
      buttons.push(
        `<a href="${escapeHtml(href)}" class="card-link-btn${extraClass ? ` ${extraClass}` : ''}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}><span aria-hidden="true">${escapeHtml(text)}</span></a>`
      );
    }

    if (detailHref) pushButton('Paper', detailHref, 'card-link-btn--video', false);

    const directPdf = isDirectPdfUrl(paper && paper.paperUrl) ? paper.paperUrl : (isDirectPdfUrl(paper && paper.sourceUrl) ? paper.sourceUrl : '');
    if (directPdf) pushButton('PDF', directPdf, '', true);
    if (paper && paper.paperUrl && !directPdf) pushButton(extractDoi(paper.paperUrl) ? 'Publisher' : 'Source', paper.paperUrl, '', true);
    if (paper && paper.sourceUrl && paper.sourceUrl !== paper.paperUrl && paper.sourceUrl !== directPdf) pushButton(isDirectPdfUrl(paper.sourceUrl) ? 'PDF' : 'Source', paper.sourceUrl, '', true);

    for (const action of (Array.isArray(paper && paper._mlirExternalActions) ? paper._mlirExternalActions : [])) {
      pushButton(normalizePaperExternalActionLabel(action), action.url, '', true);
    }

    return buttons.join('');
  }

  function renderTalkCard(item) {
    const talk = item && item.talk;
    const title = collapseWhitespace(talk && talk.title) || 'Untitled MLIR Talk';
    const titleEsc = escapeHtml(title);
    const detailHref = buildTalkDetailUrl(talk);
    const meetingLabel = collapseWhitespace(talk && (talk.meetingName || talk.meetingDate || talk.meeting));
    const abstract = truncateText(talk && talk.abstract, 300);
    const thumbnailUrl = collapseWhitespace(talk && talk.videoId)
      ? `https://img.youtube.com/vi/${encodeURIComponent(String(talk.videoId))}/hqdefault.jpg`
      : '';
    const footer = renderTalkActionButtons(talk);
    const speakerNames = Array.isArray(talk && talk.speakers)
      ? talk.speakers.map((speaker) => collapseWhitespace(speaker && speaker.name)).filter(Boolean)
      : [];

    return `
      <article class="talk-card">
        <a href="${escapeHtml(detailHref)}" class="card-link-wrap" aria-label="${titleEsc}">
          <div class="card-thumbnail" aria-hidden="true">
            ${thumbnailUrl
              ? `<img src="${escapeHtml(thumbnailUrl)}" alt="" loading="lazy"><div class="play-overlay" aria-hidden="true"><div class="play-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg></div></div>`
              : `<div class="card-thumbnail-placeholder"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 18v3"/></svg></div>`
            }
          </div>
          <div class="card-body">
            <div class="card-meta">
              <span class="badge badge-${escapeHtml(collapseWhitespace(talk && talk.category).toLowerCase() || 'other')}">${escapeHtml(talkCategoryLabel(talk && talk.category))}</span>
              ${meetingLabel ? `<span class="meeting-label">${escapeHtml(meetingLabel)}</span>` : ''}
              ${item && item.sourceLabel ? `<span class="meeting-label">${escapeHtml(item.sourceLabel)}</span>` : ''}
            </div>
            <p class="card-title">${titleEsc}</p>
            ${abstract ? `<p class="card-abstract">${escapeHtml(abstract)}</p>` : ''}
          </div>
        </a>
        ${speakerNames.length ? `<p class="card-speakers">${buildSpeakerLinks(speakerNames)}</p>` : ''}
        ${renderTopicTags(item && item.topics)}
        ${footer ? `<div class="card-footer">${footer}</div>` : ''}
      </article>`;
  }

  function renderPaperCard(item) {
    const paper = item && item.paper;
    const title = collapseWhitespace(paper && paper.title) || 'Untitled MLIR Paper';
    const abstract = truncateText(
      collapseWhitespace(paper && (paper.abstract || paper.summary || paper.publication || '')),
      340
    ) || 'Curated MLIR publication';
    const year = collapseWhitespace(paper && (paper._year || paper.year));
    const publication = collapseWhitespace(paper && (paper.publication || paper.venue));
    const detailHref = paper && paper._hasInternalDetail
      ? buildPaperDetailUrl(paper)
      : (sanitizeExternalUrl(paper && paper.paperUrl) || sanitizeExternalUrl(paper && paper.sourceUrl));
    const footer = renderPaperActionButtons(paper);
    const authorNames = Array.isArray(paper && paper.authors)
      ? paper.authors.map((author) => collapseWhitespace(author && author.name)).filter(Boolean)
      : [];
    const citationCount = Number.isFinite(Number(paper && paper._citationCount)) ? Number(paper && paper._citationCount) : 0;

    return `
      <article class="talk-card paper-card">
        <a href="${escapeHtml(detailHref)}" class="card-link-wrap" aria-label="${escapeHtml(title)}">
          <div class="card-body">
            <div class="card-meta">
              <span class="badge badge-paper">Paper</span>
              ${year ? `<span class="meeting-label">${escapeHtml(year)}</span>` : ''}
              ${publication ? `<span class="meeting-label">${escapeHtml(publication)}</span>` : ''}
              ${item && item.sourceLabel ? `<span class="meeting-label">${escapeHtml(item.sourceLabel)}</span>` : ''}
            </div>
            <p class="card-title">${escapeHtml(title)}</p>
            <p class="card-abstract">${escapeHtml(abstract)}</p>
          </div>
        </a>
        ${authorNames.length ? `<p class="card-speakers paper-authors">${buildSpeakerLinks(authorNames)}</p>` : ''}
        ${renderTopicTags(item && item.topics)}
        ${(footer || citationCount > 0) ? `<div class="card-footer">${footer}${citationCount > 0 ? `<span class="paper-citation-count">${citationCount.toLocaleString()} citation${citationCount === 1 ? '' : 's'}</span>` : ''}</div>` : ''}
      </article>`;
  }

  function renderItem(item) {
    if (!item || typeof item !== 'object') return '';
    if (item.kind === 'talk') return renderTalkCard(item);
    if (item.kind === 'paper') return renderPaperCard(item);
    return '';
  }

  function getNode(id) {
    return document.getElementById(id);
  }

  function setLoadingState() {
    const root = getNode('mlir-results-root');
    if (!root) return;
    root.innerHTML = `
      <div class="loading-state">
        <div class="spinner" aria-hidden="true"></div>
        <p>Loading MLIR content…</p>
      </div>`;
    root.setAttribute('aria-busy', 'true');
  }

  function renderEmptyState() {
    const root = getNode('mlir-results-root');
    if (!root) return;
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon" aria-hidden="true">!</div>
        <h2>No MLIR results found</h2>
        <p>Try a different query, switch between talks and papers, or clear the active filters.</p>
      </div>`;
    root.setAttribute('aria-busy', 'false');
  }

  function renderErrorState(message) {
    const root = getNode('mlir-results-root');
    const subtitle = getNode('mlir-browse-subtitle');
    if (subtitle) subtitle.textContent = 'Could not load MLIR content.';
    teardownInfiniteLoader();
    if (!root) return;
    root.innerHTML = `
      <div class="empty-state" role="alert">
        <div class="empty-state-icon" aria-hidden="true">!</div>
        <h2>Could not load MLIR content</h2>
        <p>${escapeHtml(String(message || 'Unknown error'))}</p>
      </div>`;
    root.setAttribute('aria-busy', 'false');
  }

  function createActiveFilterPill(typeLabel, valueLabel, ariaLabel, onRemove) {
    const pill = document.createElement('span');
    pill.className = 'active-filter-pill';

    const type = document.createElement('span');
    type.className = 'active-filter-pill__type';
    type.textContent = typeLabel;
    pill.appendChild(type);

    const value = document.createElement('span');
    value.className = 'active-filter-pill__value';
    value.textContent = valueLabel;
    pill.appendChild(value);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'active-filter-pill__remove';
    button.setAttribute('aria-label', ariaLabel);
    button.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onRemove();
    });
    pill.appendChild(button);

    return pill;
  }

  function renderActiveFilters() {
    const el = getNode('mlir-active-filters');
    if (!el) return;

    const pills = [];

    for (const topic of [...state.activeTopics].sort((a, b) => a.localeCompare(b))) {
      pills.push(createActiveFilterPill(
        'Key Topic',
        topic,
        `Remove key topic filter: ${topic}`,
        () => {
          state.activeTopics.delete(topic);
          updateUrl();
          recomputeResults();
        }
      ));
    }

    for (const year of [...state.years].sort((a, b) => Number(b) - Number(a))) {
      pills.push(createActiveFilterPill(
        'Year',
        year,
        `Remove year filter: ${year}`,
        () => {
          state.years.delete(year);
          updateUrl();
          recomputeResults();
        }
      ));
    }

    for (const talkType of [...state.talkTypes].sort((a, b) => {
      const left = categoryOrderFromHub && Object.prototype.hasOwnProperty.call(categoryOrderFromHub, a)
        ? categoryOrderFromHub[a]
        : (Object.prototype.hasOwnProperty.call(TALK_CATEGORY_ORDER, a) ? TALK_CATEGORY_ORDER[a] : 999);
      const right = categoryOrderFromHub && Object.prototype.hasOwnProperty.call(categoryOrderFromHub, b)
        ? categoryOrderFromHub[b]
        : (Object.prototype.hasOwnProperty.call(TALK_CATEGORY_ORDER, b) ? TALK_CATEGORY_ORDER[b] : 999);
      if (left !== right) return left - right;
      return talkCategoryLabel(a).localeCompare(talkCategoryLabel(b));
    })) {
      pills.push(createActiveFilterPill(
        'Talk Type',
        talkCategoryLabel(talkType),
        `Remove talk type filter: ${talkCategoryLabel(talkType)}`,
        () => {
          state.talkTypes.delete(talkType);
          updateUrl();
          recomputeResults();
        }
      ));
    }

    el.innerHTML = '';
    el.classList.toggle('hidden', pills.length === 0);
    pills.forEach((pill) => el.appendChild(pill));
  }

  function updateSearchUi() {
    const input = getNode('mlir-search-input');
    const clear = getNode('mlir-search-clear');
    if (input && input.value !== state.query) input.value = state.query;
    if (clear) clear.classList.toggle('visible', !!state.query);
  }

  function updateSourceUi() {
    const allButton = getNode('mlir-source-all');
    const officialButton = getNode('mlir-source-official');
    if (allButton) {
      const active = state.source === 'all';
      allButton.classList.toggle('active', active);
      allButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (officialButton) {
      const active = state.source === 'official';
      officialButton.classList.toggle('active', active);
      officialButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    const allCount = getNode('mlir-source-count-all');
    const officialCount = getNode('mlir-source-count-official');
    if (allCount) allCount.textContent = countForScope(currentSourceCounts.all, state.scope).toLocaleString();
    if (officialCount) officialCount.textContent = countForScope(currentSourceCounts.official, state.scope).toLocaleString();
  }

  function updateScopeUi() {
    const scopeButtons = [
      { id: 'mlir-scope-all', scope: 'all' },
      { id: 'mlir-scope-talks', scope: 'talks' },
      { id: 'mlir-scope-papers', scope: 'papers' },
    ];
    for (const { id, scope } of scopeButtons) {
      const button = getNode(id);
      if (!button) continue;
      const active = state.scope === scope;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    const allCount = getNode('mlir-scope-count-all');
    const talksCount = getNode('mlir-scope-count-talks');
    const papersCount = getNode('mlir-scope-count-papers');
    if (allCount) allCount.textContent = currentScopeCounts.works.toLocaleString();
    if (talksCount) talksCount.textContent = currentScopeCounts.talks.toLocaleString();
    if (papersCount) papersCount.textContent = currentScopeCounts.papers.toLocaleString();
  }

  function updateSummaryUi() {
    const subtitle = getNode('mlir-browse-subtitle');
    const resultsCount = getNode('mlir-results-count');
    const resultsContext = getNode('mlir-results-context');
    const sourceText = state.source === 'official'
      ? 'from mlir.llvm.org'
      : 'from mlir.llvm.org and the LLVM archive';
    const queryText = collapseWhitespace(state.query);
    const selectedCount = countForScope(currentSelectedCounts, state.scope);

    if (subtitle) {
      if (state.scope === 'talks') {
        if (queryText) {
          subtitle.innerHTML = `Showing <strong>${selectedCount.toLocaleString()}</strong> MLIR talks matching <strong>${escapeHtml(queryText)}</strong> ${sourceText}.`;
        } else {
          subtitle.innerHTML = `Browse <strong>${selectedCount.toLocaleString()}</strong> MLIR talks ${sourceText}.`;
        }
      } else if (state.scope === 'papers') {
        if (queryText) {
          subtitle.innerHTML = `Showing <strong>${selectedCount.toLocaleString()}</strong> MLIR papers matching <strong>${escapeHtml(queryText)}</strong> ${sourceText}.`;
        } else {
          subtitle.innerHTML = `Browse <strong>${selectedCount.toLocaleString()}</strong> MLIR papers ${sourceText}.`;
        }
      } else if (queryText) {
        subtitle.innerHTML = `Showing <strong>${selectedCount.toLocaleString()}</strong> MLIR works matching <strong>${escapeHtml(queryText)}</strong>: <strong>${currentSelectedCounts.talks.toLocaleString()}</strong> talks and <strong>${currentSelectedCounts.papers.toLocaleString()}</strong> papers ${sourceText}.`;
      } else {
        subtitle.innerHTML = `Browse <strong>${selectedCount.toLocaleString()}</strong> MLIR works: <strong>${currentSelectedCounts.talks.toLocaleString()}</strong> talks and <strong>${currentSelectedCounts.papers.toLocaleString()}</strong> papers ${sourceText}.`;
      }
    }

    if (resultsCount) {
      const label = state.scope === 'talks'
        ? 'talk'
        : (state.scope === 'papers' ? 'paper' : 'work');
      resultsCount.textContent = `${selectedCount.toLocaleString()} ${label}${selectedCount === 1 ? '' : 's'}`;
    }

    if (resultsContext) {
      resultsContext.textContent = `${currentSelectedCounts.talks.toLocaleString()} talks · ${currentSelectedCounts.papers.toLocaleString()} papers`;
    }
  }

  function renderFacetButtons(containerId, options, selectedSet, facetName, labelFormatter) {
    const container = getNode(containerId);
    if (!container) return;
    if (!Array.isArray(options) || !options.length) {
      container.innerHTML = '<p class="filter-group-hint">No filters available.</p>';
      return;
    }

    container.innerHTML = options.map((option) => {
      const value = collapseWhitespace(option && option.value);
      const active = selectedSet.has(value);
      const label = typeof labelFormatter === 'function' ? labelFormatter(value) : value;
      return `
        <button
          type="button"
          class="filter-chip${facetName === 'topic' ? ' filter-chip--tag' : ''}${facetName === 'talkType' ? ' filter-chip--type' : ''}${active ? ' active' : ''}"
          data-filter-type="${escapeHtml(facetName)}"
          data-value="${escapeHtml(value)}"
          role="switch"
          aria-checked="${active ? 'true' : 'false'}"
        >
          <span class="${facetName === 'talkType' ? 'filter-chip-type-label' : ''}">${escapeHtml(label)}</span>
          <span class="${facetName === 'talkType' ? 'filter-chip-type-count' : 'filter-chip-count'}">${Number(option && option.count || 0).toLocaleString()}</span>
        </button>`;
    }).join('');
  }

  function buildTopicFacetOptions(queryMatchedItems) {
    const items = queryMatchedItems.filter((item) => (
      matchesSelectedSource(item)
      && matchesSelectedScope(item)
      && matchesSelectedYears(item)
      && matchesSelectedTalkTypes(item)
    ));
    const counts = new Map();
    for (const item of items) {
      const seen = new Set();
      for (const topic of (Array.isArray(item.topics) ? item.topics : [])) {
        const label = collapseWhitespace(topic);
        const key = normalizeTopicKey(label);
        if (!label || !key || seen.has(key)) continue;
        seen.add(key);
        const current = counts.get(key) || { value: label, count: 0 };
        current.count += 1;
        counts.set(key, current);
      }
    }
    return [...counts.values()].sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.value.localeCompare(b.value);
    });
  }

  function buildYearFacetOptions(queryMatchedItems) {
    const items = queryMatchedItems.filter((item) => (
      matchesSelectedSource(item)
      && matchesSelectedScope(item)
      && matchesSelectedTopics(item)
      && matchesSelectedTalkTypes(item)
    ));
    const counts = new Map();
    for (const item of items) {
      const year = collapseWhitespace(item && item.year);
      if (!year) continue;
      counts.set(year, (counts.get(year) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => Number(b.value) - Number(a.value));
  }

  function buildTalkTypeFacetOptions(queryMatchedItems) {
    const items = queryMatchedItems.filter((item) => (
      item && item.kind === 'talk'
      && matchesSelectedSource(item)
      && matchesSelectedTopics(item)
      && matchesSelectedYears(item)
    ));
    const counts = new Map();
    for (const item of items) {
      const category = collapseWhitespace(item && item.talkCategory) || 'other';
      counts.set(category, (counts.get(category) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => {
        const left = categoryOrderFromHub && Object.prototype.hasOwnProperty.call(categoryOrderFromHub, a.value)
          ? categoryOrderFromHub[a.value]
          : (Object.prototype.hasOwnProperty.call(TALK_CATEGORY_ORDER, a.value) ? TALK_CATEGORY_ORDER[a.value] : 999);
        const right = categoryOrderFromHub && Object.prototype.hasOwnProperty.call(categoryOrderFromHub, b.value)
          ? categoryOrderFromHub[b.value]
          : (Object.prototype.hasOwnProperty.call(TALK_CATEGORY_ORDER, b.value) ? TALK_CATEGORY_ORDER[b.value] : 999);
        if (left !== right) return left - right;
        return talkCategoryLabel(a.value).localeCompare(talkCategoryLabel(b.value));
      });
  }

  function updateFilterClearButton() {
    const clearButton = getNode('mlir-clear-filters');
    if (!clearButton) return;
    const hasFilters = state.activeTopics.size > 0 || state.years.size > 0 || state.talkTypes.size > 0;
    clearButton.classList.toggle('hidden', !hasFilters);
  }

  function updateFilterUi(queryMatchedItems) {
    renderFacetButtons('mlir-filter-tags', buildTopicFacetOptions(queryMatchedItems), state.activeTopics, 'topic');
    renderFacetButtons('mlir-filter-years', buildYearFacetOptions(queryMatchedItems), state.years, 'year');
    renderFacetButtons(
      'mlir-filter-talk-types',
      buildTalkTypeFacetOptions(queryMatchedItems),
      state.talkTypes,
      'talkType',
      (value) => talkCategoryLabel(value)
    );

    const talkTypeSection = document.querySelector('.filter-accordion[data-accordion="talk-type"]');
    if (talkTypeSection) talkTypeSection.hidden = state.scope !== 'talks';

    updateFilterClearButton();
    renderActiveFilters();
  }

  function teardownInfiniteLoader() {
    if (loadMoreObserver) {
      loadMoreObserver.disconnect();
      loadMoreObserver = null;
    }

    if (loadMoreScrollHandler) {
      window.removeEventListener('scroll', loadMoreScrollHandler);
      window.removeEventListener('resize', loadMoreScrollHandler);
      loadMoreScrollHandler = null;
    }

    const sentinel = getNode('mlir-load-sentinel');
    if (sentinel) sentinel.remove();
  }

  function ensureLoadMoreSentinel(root) {
    let sentinel = getNode('mlir-load-sentinel');
    if (!sentinel) {
      sentinel = document.createElement('div');
      sentinel.id = 'mlir-load-sentinel';
      sentinel.setAttribute('aria-hidden', 'true');
      sentinel.style.width = '100%';
      sentinel.style.height = '1px';
      sentinel.style.gridColumn = '1 / -1';
    }
    root.appendChild(sentinel);
    return sentinel;
  }

  function appendNextResultsBatch(forceBatchSize = RENDER_BATCH_SIZE) {
    const root = getNode('mlir-results-root');
    if (!root) return;

    if (!filteredItems.length) {
      teardownInfiniteLoader();
      renderEmptyState();
      return;
    }

    if (renderedCount >= filteredItems.length) {
      teardownInfiniteLoader();
      return;
    }

    const nextCount = Math.min(renderedCount + forceBatchSize, filteredItems.length);
    let html = '';
    for (let index = renderedCount; index < nextCount; index += 1) {
      html += renderItem(filteredItems[index]);
    }
    if (html) root.insertAdjacentHTML('beforeend', html);
    root.setAttribute('aria-busy', 'false');
    renderedCount = nextCount;

    if (renderedCount >= filteredItems.length) {
      teardownInfiniteLoader();
      return;
    }

    ensureLoadMoreSentinel(root);
  }

  function setupInfiniteLoader() {
    const root = getNode('mlir-results-root');
    if (!root) return;

    teardownInfiniteLoader();
    if (renderedCount >= filteredItems.length) return;

    const sentinel = ensureLoadMoreSentinel(root);

    if ('IntersectionObserver' in window) {
      loadMoreObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            appendNextResultsBatch();
            break;
          }
        }
      }, { root: null, rootMargin: LOAD_MORE_ROOT_MARGIN, threshold: 0 });

      loadMoreObserver.observe(sentinel);
      return;
    }

    loadMoreScrollHandler = () => {
      const activeSentinel = getNode('mlir-load-sentinel');
      if (!activeSentinel) return;
      const rect = activeSentinel.getBoundingClientRect();
      if (rect.top <= window.innerHeight + 900) {
        appendNextResultsBatch();
      }
    };

    window.addEventListener('scroll', loadMoreScrollHandler, { passive: true });
    window.addEventListener('resize', loadMoreScrollHandler);
    loadMoreScrollHandler();
  }

  function renderResults() {
    const root = getNode('mlir-results-root');
    if (!root) return;

    root.setAttribute('aria-busy', 'false');

    teardownInfiniteLoader();
    renderedCount = 0;

    if (!filteredItems.length) {
      renderEmptyState();
      return;
    }

    root.innerHTML = '';
    appendNextResultsBatch(INITIAL_BATCH_SIZE);
    setupInfiniteLoader();
  }

  function recomputeResults() {
    const tokens = tokenizeQuery(state.query);
    const queryMatchedItems = [];

    for (const item of allItems) {
      const score = computeMatchScore(item.searchIndex, tokens, state.query);
      if (tokens.length && score <= 0) continue;
      item._queryScore = score;
      queryMatchedItems.push(item);
    }

    const facetMatchedItems = queryMatchedItems.filter((item) => matchesSelectedFilters(item));
    currentSourceCounts = buildSourceCounts(facetMatchedItems);

    const sourceMatchedItems = facetMatchedItems.filter((item) => matchesSelectedSource(item));
    currentScopeCounts = buildScopeCounts(sourceMatchedItems);

    filteredItems = sourceMatchedItems.filter((item) => matchesSelectedScope(item)).sort(compareItems);
    currentSelectedCounts = state.scope === 'all'
      ? buildScopeCounts(filteredItems)
      : currentScopeCounts;

    updateSearchUi();
    updateSourceUi();
    updateScopeUi();
    updateSummaryUi();
    updateFilterUi(queryMatchedItems);
    renderResults();
  }

  function parseUrlState() {
    const params = new URLSearchParams(window.location.search);
    state.query = collapseWhitespace(params.get('q'));

    const source = collapseWhitespace(params.get('source')).toLowerCase();
    state.source = (source === 'official' || source === 'mlir.llvm.org' || source === 'mlir-llvm-org') ? 'official' : 'all';

    const scope = collapseWhitespace(params.get('scope')).toLowerCase();
    state.scope = (scope === 'talks' || scope === 'papers') ? scope : 'all';

    state.activeTopics = new Set(parseCsvParam(params.get('tag')));
    state.years = new Set(parseCsvParam(params.get('year')));
    state.talkTypes = new Set(parseCsvParam(params.get('talkType')).map(normalizeTalkCategory));

    if (state.scope !== 'talks') state.talkTypes.clear();
  }

  function setQuery(nextQuery) {
    state.query = collapseWhitespace(nextQuery);
    updateUrl();
    recomputeResults();
  }

  function setSource(nextSource) {
    state.source = nextSource === 'official' ? 'official' : 'all';
    updateUrl();
    recomputeResults();
  }

  function setScope(nextScope) {
    state.scope = nextScope === 'talks' || nextScope === 'papers' ? nextScope : 'all';
    if (state.scope !== 'talks') state.talkTypes.clear();
    updateUrl();
    recomputeResults();
  }

  function clearFilters() {
    state.activeTopics.clear();
    state.years.clear();
    state.talkTypes.clear();
    updateUrl();
    recomputeResults();
  }

  function toggleFacetValue(type, value) {
    const normalizedValue = collapseWhitespace(value);
    if (!normalizedValue) return;

    let targetSet = null;
    if (type === 'topic') targetSet = state.activeTopics;
    if (type === 'year') targetSet = state.years;
    if (type === 'talkType') targetSet = state.talkTypes;
    if (!targetSet) return;

    if (targetSet.has(normalizedValue)) targetSet.delete(normalizedValue);
    else targetSet.add(normalizedValue);

    updateUrl();
    recomputeResults();
  }

  function setFilterAccordionOpen(name, open) {
    const section = document.querySelector(`.filter-accordion[data-accordion="${CSS.escape(name)}"]`);
    if (!section) return;

    const toggle = section.querySelector('.filter-accordion-toggle');
    const panel = section.querySelector('.filter-accordion-panel');
    if (!toggle || !panel) return;

    section.classList.toggle('is-collapsed', !open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    panel.hidden = !open;
  }

  function initFilterAccordions() {
    const sections = document.querySelectorAll('.filter-accordion[data-accordion]');
    if (!sections.length) return;

    sections.forEach((section) => {
      const name = section.dataset.accordion;
      const toggle = section.querySelector('.filter-accordion-toggle');
      if (!name || !toggle) return;

      setFilterAccordionOpen(name, true);

      toggle.addEventListener('click', () => {
        const currentlyOpen = toggle.getAttribute('aria-expanded') === 'true';
        setFilterAccordionOpen(name, !currentlyOpen);
      });
    });
  }

  function setFilterSidebarCollapsed(collapsed, persist = true) {
    const collapseBtn = getNode('mlir-filter-collapse-btn');
    if (!collapseBtn) return;

    document.body.classList.toggle('filter-collapsed', collapsed);
    collapseBtn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
    collapseBtn.setAttribute('aria-label', collapsed ? 'Expand filters' : 'Collapse filters');
    collapseBtn.setAttribute('title', collapsed ? 'Expand filters' : 'Collapse filters');

    if (persist) {
      safeSessionSet('llvm-hub-filter-sidebar-collapsed', collapsed ? '1' : '0');
    }
  }

  function initFilterSidebarCollapse() {
    const collapseBtn = getNode('mlir-filter-collapse-btn');
    const filterSection = document.querySelector('.filter-section');
    const mobileOpenBtn = getNode('mlir-mobile-filter-open');
    const mobileCloseBtn = getNode('mlir-mobile-filter-close');
    const mobileApplyBtn = getNode('mlir-mobile-filter-apply');
    const mobileClearBtn = getNode('mlir-mobile-filter-clear');
    const mobileScrim = getNode('mlir-mobile-filter-scrim');
    if (!collapseBtn || !filterSection) return;

    const mobileMq = window.matchMedia('(max-width: 1180px)');

    const setMobileDrawerOpen = (open) => {
      const isMobile = mobileMq.matches;
      const active = isMobile && open;

      document.body.classList.toggle('mobile-filters-open', active);
      if (mobileOpenBtn) mobileOpenBtn.setAttribute('aria-expanded', active ? 'true' : 'false');

      if (mobileScrim) {
        mobileScrim.classList.toggle('hidden', !active);
        mobileScrim.setAttribute('aria-hidden', active ? 'false' : 'true');
      }

      if (isMobile) {
        filterSection.hidden = !active;
        if (active) filterSection.removeAttribute('inert');
        else filterSection.setAttribute('inert', '');
      } else {
        filterSection.hidden = false;
        filterSection.removeAttribute('inert');
      }
    };

    const syncSidebarMode = () => {
      if (mobileMq.matches) {
        document.body.classList.remove('filter-collapsed');
        collapseBtn.setAttribute('aria-pressed', 'false');
        collapseBtn.setAttribute('aria-label', 'Collapse filters');
        collapseBtn.setAttribute('title', 'Collapse filters');
        setMobileDrawerOpen(false);
        return;
      }

      safeSessionRemove('llvm-hub-filter-sidebar-collapsed');
      setFilterSidebarCollapsed(false, false);
      setMobileDrawerOpen(false);
    };

    syncSidebarMode();

    if (typeof mobileMq.addEventListener === 'function') {
      mobileMq.addEventListener('change', syncSidebarMode);
    } else if (typeof mobileMq.addListener === 'function') {
      mobileMq.addListener(syncSidebarMode);
    }

    collapseBtn.addEventListener('click', () => {
      if (mobileMq.matches) return;
      const next = !document.body.classList.contains('filter-collapsed');
      setFilterSidebarCollapsed(next, true);
    });

    if (mobileOpenBtn) {
      mobileOpenBtn.addEventListener('click', () => {
        if (!mobileMq.matches) return;
        setMobileDrawerOpen(true);
      });
    }

    if (mobileCloseBtn) {
      mobileCloseBtn.addEventListener('click', () => {
        setMobileDrawerOpen(false);
        if (mobileOpenBtn) mobileOpenBtn.focus();
      });
    }

    if (mobileScrim) {
      mobileScrim.addEventListener('click', () => {
        setMobileDrawerOpen(false);
        if (mobileOpenBtn) mobileOpenBtn.focus();
      });
    }

    if (mobileApplyBtn) {
      mobileApplyBtn.addEventListener('click', () => {
        setMobileDrawerOpen(false);
        if (mobileOpenBtn) mobileOpenBtn.focus();
      });
    }

    if (mobileClearBtn) {
      mobileClearBtn.addEventListener('click', () => {
        clearFilters();
        setMobileDrawerOpen(false);
        if (mobileOpenBtn) mobileOpenBtn.focus();
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.body.classList.contains('mobile-filters-open')) {
        setMobileDrawerOpen(false);
        if (mobileOpenBtn) mobileOpenBtn.focus();
      }
    });
  }

  async function loadCombinedItems() {
    const [eventPayload, rawMlirTalks, paperPayload, curatedPubsResponse] = await Promise.all([
      typeof window.loadEventData === 'function' ? window.loadEventData() : Promise.resolve({ talks: [] }),
      typeof window.loadMLIRTalks === 'function' ? window.loadMLIRTalks() : Promise.resolve([]),
      typeof window.loadPaperData === 'function' ? window.loadPaperData() : Promise.resolve({ papers: [] }),
      fetch(CURATED_PUBS_DATA_PATH, { cache: 'default' }),
    ]);

    if (!curatedPubsResponse.ok) {
      throw new Error(`Could not load ${CURATED_PUBS_DATA_PATH}: HTTP ${curatedPubsResponse.status}`);
    }

    const curatedPubsPayload = await curatedPubsResponse.json();

    const archiveTalks = normalizeTalks(Array.isArray(eventPayload && eventPayload.talks) ? eventPayload.talks : [])
      .filter((talk) => getTalkKeyTopics(talk, Infinity).some((topic) => normalizeTopicKey(topic) === 'mlir'))
      .map((talk) => ({ ...talk, _mlirSourceArchive: true, _mlirSourceUpstream: false }));

    const mergedTalks = archiveTalks.map((talk) => ({ ...talk }));
    const talkIndex = buildTalkMergeIndex(mergedTalks);

    for (const upstreamTalk of normalizeTalks(Array.isArray(rawMlirTalks) ? rawMlirTalks : [])) {
      const taggedUpstreamTalk = { ...upstreamTalk, _mlirSourceArchive: false, _mlirSourceUpstream: true };
      const match = findMatchingArchiveTalk(taggedUpstreamTalk, talkIndex);
      if (match) {
        const merged = mergeTalkRecords(match, taggedUpstreamTalk, true);
        Object.assign(match, merged);
        continue;
      }
      mergedTalks.push(taggedUpstreamTalk);
    }

    const archivePapers = (Array.isArray(paperPayload && paperPayload.papers) ? paperPayload.papers : [])
      .filter((paper) => !isBlogPaper(paper))
      .map((paper) => normalizePaperRecord({
        ...paper,
        _mlirSourceArchive: getPaperKeyTopics(paper, Infinity).some((topic) => normalizeTopicKey(topic) === 'mlir'),
        _mlirSourceUpstream: false,
      }))
      .filter((paper) => paper && paper._mlirSourceArchive);

    const fallbackPubsUrl = sanitizeExternalUrl(curatedPubsPayload && curatedPubsPayload.sourceUrl);
    const mergedPapers = archivePapers.map((paper) => ({ ...paper }));
    const paperIndex = buildPaperIndex(mergedPapers);

    for (const section of (Array.isArray(curatedPubsPayload && curatedPubsPayload.sections) ? curatedPubsPayload.sections : [])) {
      for (const group of (Array.isArray(section && section.groups) ? section.groups : [])) {
        for (const entry of (Array.isArray(group && group.entries) ? group.entries : [])) {
          if (!entry || typeof entry !== 'object') continue;
          const linkedPaper = findLinkedPaper(entry, paperIndex);
          const actions = normalizeActions(entry);
          if (linkedPaper) {
            linkedPaper._mlirSourceUpstream = true;
            linkedPaper._mlirExternalActions = mergePaperActions(linkedPaper._mlirExternalActions, actions);
            linkedPaper.abstract = choosePreferredText(linkedPaper.abstract, entry && entry.summary);
            continue;
          }
          const synthetic = buildSyntheticPaperFromEntry(entry, fallbackPubsUrl);
          if (synthetic) mergedPapers.push(synthetic);
        }
      }
    }

    return [
      ...mergedTalks.map(buildTalkItem),
      ...mergedPapers.map(buildPaperItem),
    ];
  }

  function bindUi() {
    const form = getNode('mlir-search-form');
    const input = getNode('mlir-search-input');
    const clear = getNode('mlir-search-clear');
    const allSourceToggle = getNode('mlir-source-all');
    const officialSourceToggle = getNode('mlir-source-official');
    const allScopeToggle = getNode('mlir-scope-all');
    const talksScopeToggle = getNode('mlir-scope-talks');
    const papersScopeToggle = getNode('mlir-scope-papers');
    const clearFiltersButton = getNode('mlir-clear-filters');
    const filterSidebarBody = getNode('mlir-filter-sidebar-body');

    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        setQuery(input ? input.value : '');
      });
    }

    if (input) {
      input.addEventListener('input', () => {
        setQuery(input.value);
      });
    }

    if (clear) {
      clear.addEventListener('click', () => {
        setQuery('');
      });
    }

    if (allSourceToggle) {
      allSourceToggle.addEventListener('click', () => setSource('all'));
    }

    if (officialSourceToggle) {
      officialSourceToggle.addEventListener('click', () => setSource('official'));
    }

    if (allScopeToggle) {
      allScopeToggle.addEventListener('click', () => setScope('all'));
    }

    if (talksScopeToggle) {
      talksScopeToggle.addEventListener('click', () => setScope('talks'));
    }

    if (papersScopeToggle) {
      papersScopeToggle.addEventListener('click', () => setScope('papers'));
    }

    if (clearFiltersButton) {
      clearFiltersButton.addEventListener('click', clearFilters);
    }

    if (filterSidebarBody) {
      filterSidebarBody.addEventListener('click', (event) => {
        const target = event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-filter-type][data-value]')
          : null;
        if (!target) return;
        toggleFacetValue(target.dataset.filterType, target.dataset.value);
      });
    }
  }

  async function init() {
    initTheme();
    initTextSize();
    initCustomizationMenu();
    initMobileNavMenu();
    initShareMenu();

    parseUrlState();
    updateSearchUi();
    setLoadingState();
    initFilterAccordions();
    initFilterSidebarCollapse();
    bindUi();

    try {
      allItems = await loadCombinedItems();
      recomputeResults();
    } catch (error) {
      renderErrorState(error && error.message ? error.message : error);
    }
  }

  init();
})();
