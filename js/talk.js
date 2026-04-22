/**
 * talk.js - talk detail runtime with related paper linking.
 */

(function () {
  const HubUtils = window.LLVMHubUtils || {};
  const TalkPageConfig = window.LLVMTalkPageConfig && typeof window.LLVMTalkPageConfig === 'object'
    ? window.LLVMTalkPageConfig
    : {};
  const PageShell = typeof HubUtils.createPageShell === 'function'
    ? HubUtils.createPageShell()
    : null;

  const initTheme = PageShell ? () => PageShell.initTheme() : () => {};
  const initTextSize = PageShell ? () => PageShell.initTextSize() : () => {};
  const initCustomizationMenu = PageShell ? () => PageShell.initCustomizationMenu() : () => {};
  const initMobileNavMenu = PageShell ? () => PageShell.initMobileNavMenu() : () => {};
  const initShareMenu = PageShell ? () => PageShell.initShareMenu() : () => {};
  const safeSessionGet = PageShell ? PageShell.safeSessionGet : () => null;

  const TALK_PAPER_LINKS_PATH = String(TalkPageConfig.referenceIndexPath || 'js/data/talk-paper-links.json').trim() || 'js/data/talk-paper-links.json';
  const TALK_LISTING_PATH = String(TalkPageConfig.listingPath || 'talks/').trim() || 'talks/';
  const TALK_LISTING_LABEL = String(TalkPageConfig.listingLabel || 'All Talks').trim() || 'All Talks';
  const TALK_DETAIL_PATH = String(TalkPageConfig.detailPath || 'talks/talk.html').trim() || 'talks/talk.html';
  const TALK_DATA_HINT_HTML = String(
    TalkPageConfig.dataHintHtml
    || 'Ensure <code>devmtg/events/index.json</code> and <code>devmtg/events/*.json</code> are available and that <code>js/events-data.js</code> loads first.'
  ).trim();
  const BLOG_SOURCE_SLUGS = new Set(['llvm-blog-www', 'llvm-www-blog']);
  const DIRECT_PDF_URL_RE = /\.pdf(?:$|[?#])|\/pdf(?:$|[/?#])|[?&](?:format|type|output)=pdf(?:$|[&#])|[?&]filename=[^&#]*\.pdf(?:$|[&#])/i;
  const MATCH_STOPWORDS = new Set([
    'about', 'after', 'against', 'algorithm', 'algorithms', 'among', 'analysis', 'approach',
    'approaches', 'around', 'based', 'being', 'between', 'beyond', 'compiler', 'compilers',
    'design', 'details', 'during', 'each', 'from', 'have', 'into', 'llvm', 'more', 'most',
    'other', 'over', 'part', 'parts', 'paper', 'papers', 'program', 'programs', 'research',
    'results', 'same', 'show', 'shows', 'some', 'study', 'system', 'systems', 'talk', 'their',
    'these', 'this', 'through', 'using', 'with', 'within', 'work',
  ]);

  let talkPaperLinkIndexPromise = null;

  function normalizeTalks(rawTalks) {
    if (typeof HubUtils.normalizeTalks === 'function') return HubUtils.normalizeTalks(rawTalks);
    return Array.isArray(rawTalks) ? rawTalks : [];
  }

  function getTalkTopics(talk, limit = Infinity) {
    if (typeof HubUtils.getTalkKeyTopics === 'function') {
      return HubUtils.getTalkKeyTopics(talk, limit);
    }
    const tags = Array.isArray(talk && talk.tags) ? talk.tags : [];
    return Number.isFinite(limit) ? tags.slice(0, Math.max(0, Math.floor(limit))) : tags;
  }

  function getPaperTopics(paper, limit = Infinity) {
    if (typeof HubUtils.getPaperKeyTopics === 'function') {
      return HubUtils.getPaperKeyTopics(paper, limit);
    }
    const values = [
      ...(Array.isArray(paper && paper.tags) ? paper.tags : []),
      ...(Array.isArray(paper && paper.keywords) ? paper.keywords : []),
      ...(Array.isArray(paper && paper.matchedSubprojects) ? paper.matchedSubprojects : []),
    ];
    const deduped = [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
    return Number.isFinite(limit) ? deduped.slice(0, Math.max(0, Math.floor(limit))) : deduped;
  }

  function formatMeetingDate(value) {
    if (typeof HubUtils.formatMeetingDateUniversal === 'function') {
      return HubUtils.formatMeetingDateUniversal(value);
    }
    return String(value || '').trim();
  }

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

  function stripDiacritics(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function normalizeMatchText(value) {
    return collapseWhitespace(
      stripDiacritics(String(value || '').toLowerCase())
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
    );
  }

  function tokenizeImportantWords(value) {
    return [...new Set(
      normalizeMatchText(value)
        .split(' ')
        .filter((token) => token.length >= 4 && !MATCH_STOPWORDS.has(token))
    )];
  }

  function sanitizeExternalUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw, window.location.href);
      const protocol = parsed.protocol.toLowerCase();
      if (protocol === 'http:' || protocol === 'https:') return parsed.toString();
    } catch {
      return '';
    }
    return '';
  }

  function buildTalkDetailUrl(talk) {
    const explicit = sanitizeExternalUrl(talk && talk.detailUrl);
    if (explicit) return explicit;
    return `${TALK_DETAIL_PATH}?id=${encodeURIComponent(String(talk && talk.id || '').trim())}`;
  }

  function buildEmbeddedVideoUrl(videoUrl) {
    const normalized = sanitizeExternalUrl(videoUrl);
    if (!normalized) return '';
    const youtubeId = typeof HubUtils.extractYouTubeId === 'function'
      ? HubUtils.extractYouTubeId(normalized)
      : '';
    return youtubeId ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeId)}?rel=0` : '';
  }

  function normalizePeople(rawPeople) {
    const values = Array.isArray(rawPeople) ? rawPeople : [];
    return values.map((rawPerson) => {
      if (typeof HubUtils.normalizePersonRecord === 'function') {
        const normalized = HubUtils.normalizePersonRecord(rawPerson);
        if (!normalized || !normalized.name) return null;
        return {
          name: String(normalized.name || '').trim(),
          affiliation: String(normalized.affiliation || '').trim(),
        };
      }
      if (!rawPerson || typeof rawPerson !== 'object') return null;
      const name = String(rawPerson.name || '').trim();
      if (!name) return null;
      return {
        name,
        affiliation: String(rawPerson.affiliation || '').trim(),
      };
    }).filter(Boolean);
  }

  function extractDoi(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const match = raw.match(/10\.\d{4,9}\/[\w.()\-;/:%+]+/i);
    return match ? String(match[0]).trim().toLowerCase() : '';
  }

  function doiUrlFromValue(doi) {
    const normalized = extractDoi(doi);
    return normalized ? `https://doi.org/${normalized}` : '';
  }

  function normalizeOpenAlexId(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return sanitizeExternalUrl(raw);
    const cleaned = raw.replace(/^https?:\/\/openalex\.org\//i, '').replace(/^works\//i, '').trim();
    if (!/^W\d+$/i.test(cleaned)) return '';
    return `https://openalex.org/${cleaned.toUpperCase()}`;
  }

  function isDirectPdfUrl(value) {
    return DIRECT_PDF_URL_RE.test(String(value || '').trim());
  }

  function normalizePaperRecord(rawPaper) {
    if (!rawPaper || typeof rawPaper !== 'object') return null;

    const paper = { ...rawPaper };
    paper.id = String(paper.id || '').trim();
    paper.title = String(paper.title || '').trim();
    paper.abstract = String(paper.abstract || '').trim();
    paper.year = String(paper.year || '').trim();
    paper.source = String(paper.source || '').trim();
    paper.type = String(paper.type || '').trim();
    paper.paperUrl = sanitizeExternalUrl(paper.paperUrl || '');
    paper.sourceUrl = sanitizeExternalUrl(paper.sourceUrl || '');
    paper.authors = normalizePeople(paper.authors);
    paper.tags = Array.isArray(paper.tags) ? paper.tags.map((value) => String(value || '').trim()).filter(Boolean) : [];
    paper.keywords = Array.isArray(paper.keywords) ? paper.keywords.map((value) => String(value || '').trim()).filter(Boolean) : [];
    paper.matchedSubprojects = Array.isArray(paper.matchedSubprojects)
      ? paper.matchedSubprojects.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    paper.doi = extractDoi(paper.doi) || extractDoi(paper.paperUrl) || extractDoi(paper.sourceUrl);
    paper.openalexId = normalizeOpenAlexId(paper.openalexId || paper.openAlexId || '');
    paper._isBlog = BLOG_SOURCE_SLUGS.has(String(paper.source || '').trim().toLowerCase())
      || ['blog', 'blog-post'].includes(String(paper.type || '').trim().toLowerCase());
    paper._titleTokens = tokenizeImportantWords(paper.title);
    paper._topicKeys = [...new Set(
      getPaperTopics(paper, Infinity)
        .map((topic) => normalizeMatchText(topic))
        .filter(Boolean)
    )];

    if (!paper.id || !paper.title || paper._isBlog) return null;
    return paper;
  }

  function normalizePapers(rawPapers) {
    if (!Array.isArray(rawPapers)) return [];
    return rawPapers.map(normalizePaperRecord).filter(Boolean);
  }

  function buildPaperDetailUrl(paper) {
    return `papers/paper.html?id=${encodeURIComponent(String(paper && paper.id || '').trim())}&from=papers`;
  }

  function buildRelatedPaperActions(paper) {
    const title = String(paper && paper.title || '').trim() || 'this paper';
    const titleEsc = escapeHtml(title);
    const detailUrl = buildPaperDetailUrl(paper);
    const paperHref = sanitizeExternalUrl(paper && paper.paperUrl || '');
    const sourceHref = sanitizeExternalUrl(paper && paper.sourceUrl || '');
    const paperIsPdf = isDirectPdfUrl(paperHref);
    const sourceIsPdf = isDirectPdfUrl(sourceHref);
    const directPdfHref = paperIsPdf
      ? paperHref
      : (sourceIsPdf ? sourceHref : '');
    const publisherHref = paperHref && paperHref !== directPdfHref ? paperHref : '';
    const sourceListingHref = sourceHref && sourceHref !== directPdfHref && sourceHref !== publisherHref ? sourceHref : '';
    const doiHref = sanitizeExternalUrl(doiUrlFromValue(paper && paper.doi || ''));
    const openAlexHref = normalizeOpenAlexId(paper && (paper.openalexId || paper.openAlexId) || '');

    const actions = [
      `<a href="${escapeHtml(detailUrl)}" class="link-btn" aria-label="Open library page for ${titleEsc}">Paper</a>`,
    ];

    if (directPdfHref) {
      actions.push(`<a href="${escapeHtml(directPdfHref)}" class="link-btn" target="_blank" rel="noopener noreferrer" aria-label="Open PDF for ${titleEsc} (opens in new tab)">PDF</a>`);
    }
    if (publisherHref) {
      actions.push(`<a href="${escapeHtml(publisherHref)}" class="link-btn" target="_blank" rel="noopener noreferrer" aria-label="Open publisher page for ${titleEsc} (opens in new tab)">Publisher</a>`);
    }
    if (sourceListingHref) {
      actions.push(`<a href="${escapeHtml(sourceListingHref)}" class="link-btn" target="_blank" rel="noopener noreferrer" aria-label="Open source listing for ${titleEsc} (opens in new tab)">Source</a>`);
    }
    if (doiHref && doiHref !== publisherHref && doiHref !== sourceListingHref) {
      actions.push(`<a href="${escapeHtml(doiHref)}" class="link-btn" target="_blank" rel="noopener noreferrer" aria-label="Open DOI record for ${titleEsc} (opens in new tab)">DOI</a>`);
    }
    if (openAlexHref) {
      actions.push(`<a href="${escapeHtml(openAlexHref)}" class="link-btn" target="_blank" rel="noopener noreferrer" aria-label="Open OpenAlex record for ${titleEsc} (opens in new tab)">OpenAlex</a>`);
    }

    return actions.join('');
  }

  function buildPaperTitleVariants(title) {
    const variants = [];
    const add = (value) => {
      const normalized = normalizeMatchText(value);
      if (!normalized) return;
      const tokenCount = normalized.split(' ').filter(Boolean).length;
      if (normalized.length < 16 || tokenCount < 3) return;
      if (!variants.includes(normalized)) variants.push(normalized);
    };

    const rawTitle = collapseWhitespace(title);
    if (!rawTitle) return variants;

    add(rawTitle);
    add(rawTitle.replace(/[“”"']/g, ''));

    const splitMatch = rawTitle.split(/\s*(?:[:\-–—])\s*/).map((part) => collapseWhitespace(part)).filter(Boolean);
    if (splitMatch.length > 1) {
      add(splitMatch[0]);
    }

    add(rawTitle.replace(/^(?:a|an|the)\s+/i, ''));
    return variants;
  }

  function hasTitleMention(haystack, titleVariants) {
    const text = ` ${String(haystack || '')} `;
    for (const variant of (Array.isArray(titleVariants) ? titleVariants : [])) {
      if (text.includes(` ${variant} `)) return true;
    }
    return false;
  }

  function countOverlap(values, set) {
    let total = 0;
    for (const value of (Array.isArray(values) ? values : [])) {
      if (set.has(value)) total += 1;
    }
    return total;
  }

  function buildAuthorPaperCountMap(papers) {
    const counts = new Map();
    for (const paper of (Array.isArray(papers) ? papers : [])) {
      for (const author of (paper && paper.authors) || []) {
        const key = typeof HubUtils.normalizePersonKey === 'function'
          ? HubUtils.normalizePersonKey(author && author.name)
          : normalizeMatchText(author && author.name);
        if (!key) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    return counts;
  }

  async function loadTalkPaperLinkIndex() {
    if (talkPaperLinkIndexPromise) return talkPaperLinkIndexPromise;

    talkPaperLinkIndexPromise = (async () => {
      try {
        const response = await fetch(TALK_PAPER_LINKS_PATH, { cache: 'default' });
        if (!response.ok) return { talks: {} };
        const payload = await response.json();
        if (!payload || typeof payload !== 'object') return { talks: {} };
        return payload;
      } catch {
        return { talks: {} };
      }
    })();

    return talkPaperLinkIndexPromise;
  }

  function getSlideReferencedPaperIds(indexPayload, talk) {
    if (!indexPayload || typeof indexPayload !== 'object') return [];
    const talks = indexPayload.talks;
    if (!talks || typeof talks !== 'object') return [];
    const talkId = String(talk && talk.id || '').trim();
    if (!talkId) return [];
    const entry = talks[talkId];
    if (!entry || typeof entry !== 'object') return [];

    const indexedSlidesUrl = sanitizeExternalUrl(entry.slidesUrl || '');
    const currentSlidesUrl = sanitizeExternalUrl(talk && talk.slidesUrl);
    if (indexedSlidesUrl && currentSlidesUrl && indexedSlidesUrl !== currentSlidesUrl) return [];

    return Array.isArray(entry.slidePaperIds)
      ? entry.slidePaperIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
  }

  function buildRelatedPaperEntries(talk, papers, slideReferenceIndex) {
    if (!talk || typeof talk !== 'object') return [];
    const slidePaperIds = getSlideReferencedPaperIds(slideReferenceIndex, talk);
    if (!slidePaperIds.length) return [];

    const paperById = new Map();
    for (const paper of (Array.isArray(papers) ? papers : [])) {
      if (!paper || typeof paper !== 'object') continue;
      const paperId = String(paper.id || '').trim();
      if (!paperId || paperById.has(paperId)) continue;
      paperById.set(paperId, paper);
    }

    const results = [];
    for (const paperId of slidePaperIds) {
      const paper = paperById.get(String(paperId || '').trim());
      if (!paper) continue;
      results.push({
        paper,
        reasons: ['Referenced in slides'],
      });
    }

    return results;
  }

  function renderRelatedPaperEntry(entry) {
    const paper = entry && entry.paper;
    if (!paper) return '';

    const authors = Array.isArray(paper.authors)
      ? paper.authors.map((author) => String(author && author.name || '').trim()).filter(Boolean)
      : [];
    const detailUrl = buildPaperDetailUrl(paper);

    return `
      <li class="talk-paper-list-item">
        <div class="talk-paper-title-row">
          <a href="${escapeHtml(detailUrl)}" class="talk-paper-link">${escapeHtml(String(paper.title || '').trim())}</a>
          ${paper.year ? `<span class="talk-paper-year">${escapeHtml(String(paper.year || '').trim())}</span>` : ''}
        </div>
        ${authors.length ? `<p class="talk-paper-authors">${authors.map((name) => escapeHtml(name)).join(', ')}</p>` : ''}
        <div class="talk-paper-meta-row">
          <div class="talk-paper-reason-list">
            ${(entry.reasons || []).map((reason) => `<span class="detail-tag detail-tag--meta">${escapeHtml(reason)}</span>`).join('')}
          </div>
        </div>
        <div class="talk-paper-actions">
          ${buildRelatedPaperActions(paper)}
        </div>
      </li>`;
  }

  async function populateRelatedPapers(talk) {
    const section = document.getElementById('talk-related-papers-section');
    if (!section) return;

    if (typeof window.loadPaperData !== 'function') {
      section.remove();
      return;
    }

    try {
      const [paperPayload, slideReferenceIndex] = await Promise.all([
        window.loadPaperData(),
        loadTalkPaperLinkIndex(),
      ]);

      const papers = normalizePapers(paperPayload && paperPayload.papers);
      const entries = buildRelatedPaperEntries(talk, papers, slideReferenceIndex);
      if (!entries.length) {
        section.remove();
        return;
      }

      section.hidden = false;
      section.removeAttribute('aria-busy');
      section.innerHTML = `
        <div class="section-label" aria-hidden="true">Referenced Papers</div>
        <ul class="talk-paper-list">
          ${entries.map((entry) => renderRelatedPaperEntry(entry)).join('')}
        </ul>`;
    } catch {
      section.remove();
    }
  }

  function upsertMeta(attrName, attrValue, content) {
    if (!content) return;
    const selector = `meta[${attrName}="${attrValue}"]`;
    let node = document.head.querySelector(selector);
    if (!node) {
      node = document.createElement('meta');
      node.setAttribute(attrName, attrValue);
      document.head.appendChild(node);
    }
    node.setAttribute('content', String(content));
  }

  function updateSeo(talk) {
    if (!talk || typeof talk !== 'object') return;
    const title = String(talk.title || '').trim();
    if (!title) return;
    const description = String(talk.abstract || '').replace(/\s+/g, ' ').trim().slice(0, 260);
    upsertMeta('name', 'description', description || `${title} talk details`);
    upsertMeta('property', 'og:type', 'article');
    upsertMeta('property', 'og:title', `${title} — LLVM Research Library`);
    upsertMeta('property', 'og:description', description || title);
    upsertMeta('property', 'og:url', window.location.href);
    upsertMeta('name', 'twitter:card', 'summary');
    upsertMeta('name', 'twitter:title', `${title} — LLVM Research Library`);
    upsertMeta('name', 'twitter:description', description || title);
  }

  function setIssueContext(context) {
    if (typeof window.setLibraryIssueContext !== 'function') return;
    if (!context || typeof context !== 'object') return;
    window.setLibraryIssueContext(context);
  }

  function setIssueContextForTalk(talk) {
    if (!talk || typeof talk !== 'object') return;
    setIssueContext({
      pageType: 'Talk',
      itemType: 'Talk',
      itemId: String(talk.id || '').trim(),
      itemTitle: String(talk.title || '').trim(),
      pageTitle: `${String(talk.title || '').trim()} — LLVM Research Library`,
      meeting: String(talk.meeting || '').trim(),
      meetingName: String(talk.meetingName || '').trim(),
      slidesUrl: String(talk.slidesUrl || '').trim(),
      posterUrl: String(talk.posterUrl || '').trim(),
      videoUrl: String(talk.videoUrl || '').trim(),
      sourceUrl: String(talk.sourceUrl || '').trim(),
    });
  }

  async function loadTalkDetailContextById(talkId) {
    const targetId = String(talkId || '').trim();
    if (!targetId) return { loaded: true, talk: null, relatedPool: [] };

    if (typeof window.loadTalkRecordById === 'function') {
      try {
        const payload = await window.loadTalkRecordById(targetId);
        if (!payload || typeof payload !== 'object') {
          return { loaded: true, talk: null, relatedPool: [] };
        }
        const normalizedTalk = normalizeTalks([payload.talk]);
        const talk = normalizedTalk.length ? normalizedTalk[0] : null;
        const relatedPool = normalizeTalks(payload.talks);
        return {
          loaded: true,
          talk,
          relatedPool: Array.isArray(relatedPool) ? relatedPool : [],
        };
      } catch {
        // Fallback below.
      }
    }

    if (typeof window.loadEventData !== 'function') {
      return { loaded: false, talk: null, relatedPool: [] };
    }

    try {
      const payload = await window.loadEventData();
      const talks = normalizeTalks(payload && payload.talks);
      const talk = talks.find((candidate) => String(candidate && candidate.id || '') === targetId) || null;
      return { loaded: true, talk, relatedPool: talks };
    } catch {
      return { loaded: false, talk: null, relatedPool: [] };
    }
  }

  function renderAbstract(text) {
    const normalized = String(text || '').trim();
    if (!normalized) return '<p><em>No abstract available.</em></p>';
    return normalized
      .split(/\n{2,}|\r\n\r\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => `<p>${escapeHtml(paragraph.replace(/\n/g, ' '))}</p>`)
      .join('\n');
  }

  function buildSpeakerWorkUrl(name) {
    const speaker = String(name || '').trim();
    if (!speaker) return 'work.html';
    return `work.html?kind=speaker&value=${encodeURIComponent(speaker)}&from=talks`;
  }

  function countTopicOverlap(values, topicKeys) {
    let total = 0;
    for (const value of (Array.isArray(values) ? values : [])) {
      const key = normalizeMatchText(value);
      if (key && topicKeys.has(key)) total += 1;
    }
    return total;
  }

  function renderSpeakers(speakers) {
    const values = Array.isArray(speakers) ? speakers : [];
    if (!values.length) {
      return '<p style="color: var(--color-text-muted); font-size: var(--font-size-sm);">Speaker information not available.</p>';
    }

    return values.map((speaker) => {
      const name = String(speaker && speaker.name || '').trim();
      if (!name) return '';
      const affiliation = String(speaker && speaker.affiliation || '').trim();
      return `
        <div class="speaker-chip">
          <div>
            <a href="${buildSpeakerWorkUrl(name)}" class="speaker-name-link" aria-label="View talks and papers by ${escapeHtml(name)}">${escapeHtml(name)}</a>
            ${affiliation ? `<br><span class="speaker-affiliation">${escapeHtml(affiliation)}</span>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  function getRelatedTalks(talk, relatedPool) {
    const values = Array.isArray(relatedPool) ? relatedPool : [];
    const targetId = String(talk && talk.id || '').trim();
    if (!targetId || !values.length) return [];

    const topicKeys = new Set(
      getTalkTopics(talk, Infinity)
        .map((topic) => normalizeMatchText(topic))
        .filter(Boolean)
    );
    if (!topicKeys.size) return [];

    const scored = [];

    for (const candidate of values) {
      if (!candidate || typeof candidate !== 'object') continue;
      const candidateId = String(candidate.id || '').trim();
      if (!candidateId || candidateId === targetId) continue;
      const overlap = countTopicOverlap(getTalkTopics(candidate, Infinity), topicKeys);
      if (!overlap) continue;
      scored.push({
        talk: candidate,
        overlap,
        sameMeeting: candidate.meeting && talk.meeting && candidate.meeting === talk.meeting ? 1 : 0,
      });
    }

    scored.sort((a, b) => {
      const overlapDiff = b.overlap - a.overlap;
      if (overlapDiff !== 0) return overlapDiff;
      const meetingDiff = b.sameMeeting - a.sameMeeting;
      if (meetingDiff !== 0) return meetingDiff;
      const meetingCompare = String(b.talk && (b.talk.meetingDate || b.talk.meeting) || '')
        .localeCompare(String(a.talk && (a.talk.meetingDate || a.talk.meeting) || ''));
      if (meetingCompare !== 0) return meetingCompare;
      return String(a.talk && a.talk.title || '').localeCompare(String(b.talk && b.talk.title || ''));
    });

    return scored.slice(0, 6).map((entry) => entry.talk);
  }

  function renderRelatedCard(talk) {
    const title = String(talk && talk.title || '').trim() || '(untitled talk)';
    const meeting = String(talk && talk.meeting || '').trim();
    const speakers = Array.isArray(talk && talk.speakers)
      ? talk.speakers.map((speaker) => String(speaker && speaker.name || '').trim()).filter(Boolean)
      : [];
    const speakerText = speakers.join(', ');
    const label = speakerText ? `${title} by ${speakerText}` : title;

    return `
      <article class="talk-card">
        <a href="${escapeHtml(buildTalkDetailUrl(talk))}" class="card-link-wrap" aria-label="${escapeHtml(label)}">
          <div class="card-body">
            <div class="card-meta">
              ${meeting ? `<span class="meeting-label">${escapeHtml(meeting)}</span>` : ''}
            </div>
            <p class="card-title">${escapeHtml(title)}</p>
          </div>
        </a>
      </article>`;
  }

  function renderNotFound(id) {
    const root = document.getElementById('talk-detail-root');
    if (!root) return;
    root.innerHTML = `
      <div class="talk-detail">
        <a href="${escapeHtml(TALK_LISTING_PATH)}" class="back-btn" aria-label="Back to ${escapeHtml(TALK_LISTING_LABEL)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
          <span aria-hidden="true">${escapeHtml(TALK_LISTING_LABEL)}</span>
        </a>
        <div class="empty-state">
          <div class="empty-state-icon" aria-hidden="true">!</div>
          <h2>Talk not found</h2>
          <p>No talk found with ID <code>${escapeHtml(id || '(none)')}</code>.</p>
          <p><a href="${escapeHtml(TALK_LISTING_PATH)}">Browse ${escapeHtml(TALK_LISTING_LABEL)} →</a></p>
        </div>
      </div>`;
  }

  function renderLoadError() {
    const root = document.getElementById('talk-detail-root');
    if (!root) return;
    root.innerHTML = `
      <div class="talk-detail">
        <div class="empty-state" role="alert">
          <div class="empty-state-icon" aria-hidden="true">!</div>
          <h2>Could not load data</h2>
          <p>${TALK_DATA_HINT_HTML}</p>
        </div>
      </div>`;
  }

  function renderTalkDetail(talk, relatedPool) {
    const root = document.getElementById('talk-detail-root');
    if (!root) return;

    const title = String(talk.title || '').trim();
    const meetingDate = formatMeetingDate(talk.meetingDate);
    const meetingLocation = String(talk.meetingLocation || '').trim();
    const meetingMeta = [meetingDate, meetingLocation].filter(Boolean).join(' · ');

    const videoUrl = sanitizeExternalUrl(talk.videoUrl);
    const embeddedVideoUrl = buildEmbeddedVideoUrl(videoUrl);
    const slidesUrl = sanitizeExternalUrl(talk.slidesUrl);
    const posterUrl = sanitizeExternalUrl(talk.posterUrl);
    const githubUrl = sanitizeExternalUrl(talk.projectGithub);
    const sourceUrl = sanitizeExternalUrl(talk.sourceUrl);

    const links = [];
    if (videoUrl) links.push(`<a href="${escapeHtml(videoUrl)}" class="link-btn" target="_blank" rel="noopener noreferrer">Watch Video</a>`);
    if (slidesUrl) {
      const primaryDocLabel = String(talk.category || '').trim().toLowerCase() === 'poster' ? 'View Poster' : 'View Slides';
      links.push(`<a href="${escapeHtml(slidesUrl)}" class="link-btn" target="_blank" rel="noopener noreferrer">${primaryDocLabel}</a>`);
    }
    if (posterUrl && posterUrl !== slidesUrl) {
      links.push(`<a href="${escapeHtml(posterUrl)}" class="link-btn" target="_blank" rel="noopener noreferrer">View Poster</a>`);
    }
    if (githubUrl) links.push(`<a href="${escapeHtml(githubUrl)}" class="link-btn" target="_blank" rel="noopener noreferrer">Project on GitHub</a>`);
    if (sourceUrl) links.push(`<a href="${escapeHtml(sourceUrl)}" class="link-btn" target="_blank" rel="noopener noreferrer">Source Listing</a>`);

    const topics = getTalkTopics(talk, 18);
    const topicsHtml = topics.length
      ? `<section class="tags-section" aria-label="Key Topics">
          <div class="section-label" aria-hidden="true">Key Topics</div>
          <div class="detail-tags">
            ${topics.map((topic) =>
              `<a href="talks/?tag=${encodeURIComponent(topic)}" class="detail-tag" aria-label="Browse talks for key topic ${escapeHtml(topic)}">${escapeHtml(topic)}</a>`
            ).join('')}
          </div>
        </section>`
      : '';

    const related = getRelatedTalks(talk, relatedPool);

    root.innerHTML = `
      <div class="talk-detail">
        <a href="${escapeHtml(TALK_LISTING_PATH)}" class="back-btn" id="back-btn" aria-label="Back to ${escapeHtml(TALK_LISTING_LABEL)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
          <span aria-hidden="true">${escapeHtml(TALK_LISTING_LABEL)}</span>
        </a>

        <div class="talk-header">
          <div class="talk-header-meta">
            ${meetingMeta ? `<span class="meeting-info-badge">${escapeHtml(meetingMeta)}</span>` : ''}
          </div>
          <h1 class="talk-title">${escapeHtml(title)}</h1>
        </div>

        <section class="speakers-section" aria-label="Speakers">
          <div class="section-label" aria-hidden="true">Speakers</div>
          <div class="speakers-list">${renderSpeakers(talk.speakers)}</div>
        </section>

        ${links.length ? `<div class="links-bar" aria-label="Resources">${links.join('')}</div>` : ''}

        ${embeddedVideoUrl ? `
        <section class="video-section" aria-label="Video player">
          <div class="section-label" aria-hidden="true">Video</div>
          <div class="video-embed">
            <iframe
              src="${escapeHtml(embeddedVideoUrl)}"
              title="${escapeHtml(title || 'Talk video')}"
              loading="lazy"
              referrerpolicy="strict-origin-when-cross-origin"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowfullscreen
            ></iframe>
          </div>
        </section>` : ''}

        <section class="abstract-section" aria-label="Abstract">
          <div class="section-label" aria-hidden="true">Abstract</div>
          <div class="abstract-body">${renderAbstract(talk.abstract)}</div>
        </section>

        <section class="talk-paper-links-section" id="talk-related-papers-section" aria-label="Referenced papers" aria-busy="true">
          <div class="section-label" aria-hidden="true">Referenced Papers</div>
          <p class="talk-paper-links-loading">Loading slide-referenced papers…</p>
        </section>

        ${topicsHtml}
      </div>

      ${related.length ? `
      <section class="related-section" aria-label="Related talks">
        <h2>Related Talks</h2>
        <div class="related-grid">
          ${related.map((item) => renderRelatedCard(item)).join('')}
        </div>
      </section>` : ''}`;

    const backBtn = document.getElementById('back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', (event) => {
        if (safeSessionGet('llvm-hub-search-state')) return;
        if (window.history.length > 1) {
          event.preventDefault();
          window.history.back();
        }
      });
    }
  }

  async function init() {
    initTheme();
    initTextSize();
    initCustomizationMenu();
    initMobileNavMenu();

    const params = new URLSearchParams(window.location.search);
    const talkId = String(params.get('id') || '').trim();

    setIssueContext({
      pageType: 'Talk',
      itemType: 'Talk',
      itemId: talkId,
    });

    if (!talkId) {
      renderNotFound(null);
      setIssueContext({ itemTitle: 'Missing talk ID', issueTitle: '[Talk] Missing talk ID' });
      initShareMenu();
      return;
    }

    const context = await loadTalkDetailContextById(talkId);
    if (!context || context.loaded !== true) {
      renderLoadError();
      initShareMenu();
      return;
    }

    const talk = context.talk;
    if (!talk) {
      renderNotFound(talkId);
      setIssueContext({ itemTitle: `Unknown talk ID: ${talkId}`, issueTitle: `[Talk] Unknown talk ID: ${talkId}` });
      initShareMenu();
      return;
    }

    document.title = `${String(talk.title || '').trim()} — LLVM Research Library`;
    updateSeo(talk);
    renderTalkDetail(talk, context.relatedPool);
    void populateRelatedPapers(talk);
    setIssueContextForTalk(talk);
    initShareMenu();
  }

  init();
})();
