/**
 * mlir-pubs.js - curated MLIR publication cards rendered with the core paper-card shell.
 */

(function () {
  const HubUtils = window.LLVMHubUtils || {};
  const PageShell = typeof HubUtils.createPageShell === 'function'
    ? HubUtils.createPageShell()
    : null;

  const initShareMenu = PageShell ? () => PageShell.initShareMenu() : () => {};
  const DATA_PATH = 'sub-projects/mlir/data/publications.json';
  const PAGE_PATH = 'mlir/pubs/';
  const DIRECT_PDF_URL_RE = /\.pdf(?:$|[?#])|\/pdf(?:$|[/?#])|[?&](?:format|type|output)=pdf(?:$|[&#])|[?&]filename=[^&#]*\.pdf(?:$|[&#])/i;

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
      const parsed = new URL(raw, window.location.href);
      const protocol = parsed.protocol.toLowerCase();
      if (protocol === 'http:' || protocol === 'https:') return parsed.toString();
    } catch {
      return '';
    }
    return '';
  }

  function normalizeTitleKey(value) {
    return collapseWhitespace(String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' '));
  }

  function extractDoi(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const match = raw.match(/10\.\d{4,9}\/[\w.()\-;/:%+]+/i);
    return match ? String(match[0]).trim().toLowerCase() : '';
  }

  function isDirectPdfUrl(value) {
    return DIRECT_PDF_URL_RE.test(String(value || '').trim());
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

  function buildPaperDetailUrl(paper) {
    return `papers/paper.html?id=${encodeURIComponent(String(paper && paper.id || '').trim())}&from=mlir-pubs`;
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

  function buildFilterHref(param, value) {
    const params = new URLSearchParams(window.location.search);
    params.delete('q');
    params.delete('sort');
    params.set(param, value);
    return params.toString() ? `${PAGE_PATH}?${params.toString()}` : PAGE_PATH;
  }

  function extractYear(entry) {
    const match = collapseWhitespace([
      entry && entry.title,
      entry && entry.summary,
      entry && entry.text,
    ].join(' ')).match(/\b((?:19|20)\d{2})\b/);
    return match ? match[1] : '';
  }

  function extractAuthors(entry) {
    const summary = collapseWhitespace(entry && entry.summary);
    const authorSegment = summary.split(' - ')[0] || summary;
    return uniqueStrings(
      authorSegment
        .split(/\s*,\s*|\s+and\s+/i)
        .map((value) => collapseWhitespace(value))
        .filter((value) => value && !/\bproceedings\b/i.test(value))
    );
  }

  function extractVenue(entry) {
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
    paper.year = collapseWhitespace(paper.year);
    paper.publication = collapseWhitespace(paper.publication || paper.venue);
    paper.paperUrl = sanitizeExternalUrl(paper.paperUrl || '');
    paper.sourceUrl = sanitizeExternalUrl(paper.sourceUrl || '');
    paper.doi = extractDoi(paper.doi || paper.paperUrl || paper.sourceUrl || '');
    paper.authors = Array.isArray(paper.authors)
      ? paper.authors
          .map((author) => {
            const name = collapseWhitespace(author && author.name);
            return name ? { name } : null;
          })
          .filter(Boolean)
      : [];
    paper.tags = uniqueStrings([
      ...(Array.isArray(paper.tags) ? paper.tags : []),
      ...(Array.isArray(paper.keywords) ? paper.keywords : []),
      ...(Array.isArray(paper.matchedSubprojects) ? paper.matchedSubprojects : []),
    ]);
    if (!paper.id || !paper.title) return null;
    paper.titleKey = normalizeTitleKey(paper.title);
    return paper;
  }

  function buildPaperIndex(payload) {
    const index = {
      byTitle: new Map(),
      byDoi: new Map(),
      byUrl: new Map(),
    };

    const papers = Array.isArray(payload && payload.papers) ? payload.papers : [];
    for (const rawPaper of papers) {
      const paper = normalizePaperRecord(rawPaper);
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

  function getPaperTopics(entry, linkedPaper) {
    if (linkedPaper && Array.isArray(linkedPaper.tags) && linkedPaper.tags.length) {
      return linkedPaper.tags.slice(0, 8);
    }
    if (typeof HubUtils.getPaperKeyTopics !== 'function') return [];
    const summary = collapseWhitespace(entry && entry.summary);
    return HubUtils.getPaperKeyTopics({
      title: collapseWhitespace(entry && entry.title),
      abstract: summary,
      tags: [],
      keywords: [],
      matchedSubprojects: ['MLIR'],
    }, 8);
  }

  function renderAuthors(entry, linkedPaper) {
    const authors = linkedPaper && Array.isArray(linkedPaper.authors) && linkedPaper.authors.length
      ? linkedPaper.authors.map((author) => collapseWhitespace(author && author.name)).filter(Boolean)
      : extractAuthors(entry);
    if (!authors.length) return '';
    return `
      <p class="card-speakers paper-authors">
        ${authors.map((name) => `<a href="${escapeHtml(buildFilterHref('speaker', name))}" class="speaker-btn" aria-label="Filter MLIR publications by ${escapeHtml(name)}">${escapeHtml(name)}</a>`).join('<span class="speaker-btn-sep">, </span>')}
      </p>`;
  }

  function renderTopicTags(entry, linkedPaper) {
    const topics = getPaperTopics(entry, linkedPaper);
    if (!topics.length) return '';
    return `
      <div class="card-tags-wrap">
        <div class="card-tags" aria-label="Key Topics">
          ${topics.slice(0, 4).map((topic) =>
            `<a href="${escapeHtml(buildFilterHref('tag', topic))}" class="card-tag" aria-label="Filter MLIR publications by key topic ${escapeHtml(topic)}">${escapeHtml(topic)}</a>`
          ).join('')}
          ${topics.length > 4 ? `<span class="card-tag card-tag--more" aria-hidden="true">+${topics.length - 4}</span>` : ''}
        </div>
      </div>`;
  }

  function normalizeExternalActionLabel(action) {
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

  function buildActionButtons(entry, linkedPaper) {
    const buttons = [];
    const seenUrls = new Set();

    if (linkedPaper) {
      buttons.push(
        `<a href="${escapeHtml(buildPaperDetailUrl(linkedPaper))}" class="card-link-btn card-link-btn--video" aria-label="Open library page for ${escapeHtml(linkedPaper.title)}"><span aria-hidden="true">Paper</span></a>`
      );
    }

    const pushExternalButton = (label, url) => {
      const normalizedUrl = sanitizeExternalUrl(url);
      if (!normalizedUrl || seenUrls.has(normalizedUrl)) return;
      seenUrls.add(normalizedUrl);
      buttons.push(
        `<a href="${escapeHtml(normalizedUrl)}" class="card-link-btn" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHtml(label)} in a new tab"><span aria-hidden="true">${escapeHtml(label)}</span></a>`
      );
    };

    const actions = normalizeActions(entry);
    for (const action of actions) {
      pushExternalButton(normalizeExternalActionLabel(action), action.url);
    }

    if (linkedPaper) {
      const externalCandidates = [
        { label: isDirectPdfUrl(linkedPaper.paperUrl) ? 'PDF' : 'Publisher', url: linkedPaper.paperUrl },
        { label: isDirectPdfUrl(linkedPaper.sourceUrl) ? 'PDF' : 'Source', url: linkedPaper.sourceUrl },
      ];
      for (const candidate of externalCandidates) {
        pushExternalButton(candidate.label, candidate.url);
      }
    }

    return buttons.join('');
  }

  function renderEntry(entry, linkedPaper, fallbackUrl) {
    const actions = normalizeActions(entry);
    const detailHref = linkedPaper
      ? buildPaperDetailUrl(linkedPaper)
      : buildPrimaryHref(actions, fallbackUrl);
    const title = collapseWhitespace(entry && entry.title) || 'Untitled MLIR Publication';
    const year = linkedPaper && linkedPaper.year ? linkedPaper.year : extractYear(entry);
    const venue = linkedPaper && linkedPaper.publication ? linkedPaper.publication : extractVenue(entry);
    const summary = collapseWhitespace(
      linkedPaper && linkedPaper.abstract
        ? linkedPaper.abstract
        : (entry && entry.summary)
    );
    const footerHtml = buildActionButtons(entry, linkedPaper);

    return `
      <article class="talk-card paper-card">
        <a href="${escapeHtml(detailHref)}" class="card-link-wrap" aria-label="Open ${escapeHtml(title)}">
          <div class="card-body">
            <div class="card-meta">
              <span class="badge badge-paper">Paper</span>
              ${year ? `<span class="meeting-label">${escapeHtml(year)}</span>` : ''}
              ${venue ? `<span class="meeting-label">${escapeHtml(venue)}</span>` : ''}
            </div>
            <p class="card-title">${escapeHtml(title)}</p>
            <p class="card-abstract">${escapeHtml(summary || venue || 'Curated MLIR publication')}</p>
          </div>
        </a>
        ${renderAuthors(entry, linkedPaper)}
        ${renderTopicTags(entry, linkedPaper)}
        ${footerHtml ? `<div class="card-footer">${footerHtml}</div>` : ''}
      </article>`;
  }

  function countEntries(sections) {
    let total = 0;
    for (const section of (Array.isArray(sections) ? sections : [])) {
      for (const group of (Array.isArray(section && section.groups) ? section.groups : [])) {
        total += Array.isArray(group && group.entries) ? group.entries.length : 0;
      }
    }
    return total;
  }

  function renderSections(payload, paperIndex) {
    const sections = Array.isArray(payload && payload.sections) ? payload.sections : [];
    const fallbackUrl = sanitizeExternalUrl(payload && payload.sourceUrl);
    const entries = [];
    for (const section of sections) {
      for (const group of (Array.isArray(section && section.groups) ? section.groups : [])) {
        for (const entry of (Array.isArray(group && group.entries) ? group.entries : [])) {
          if (entry && typeof entry === 'object') entries.push(entry);
        }
      }
    }
    return entries.map((entry) => renderEntry(entry, findLinkedPaper(entry, paperIndex), fallbackUrl)).join('');
  }

  async function init() {
    const root = document.getElementById('mlir-curated-pubs-root');
    const summary = document.getElementById('mlir-curated-pubs-summary');
    if (!root) {
      initShareMenu();
      return;
    }

    try {
      const [response, paperPayload] = await Promise.all([
        fetch(DATA_PATH, { cache: 'default' }),
        typeof window.loadPaperData === 'function' ? window.loadPaperData() : Promise.resolve({ papers: [] }),
      ]);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const totalEntries = countEntries(payload && payload.sections);
      const sourceUrl = sanitizeExternalUrl(payload && payload.sourceUrl);
      const paperIndex = buildPaperIndex(paperPayload);
      if (summary) {
        summary.innerHTML = `Showing <strong>${totalEntries.toLocaleString()}</strong> curated publications from <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">mlir.llvm.org/pubs</a>.`;
      }
      root.innerHTML = renderSections(payload, paperIndex);
      root.setAttribute('aria-busy', 'false');
    } catch (error) {
      root.innerHTML = `
        <div class="empty-state" role="alert">
          <div class="empty-state-icon" aria-hidden="true">!</div>
          <h2>Could not load curated MLIR publications</h2>
          <p>${escapeHtml(String(error && error.message ? error.message : error))}</p>
        </div>`;
      root.setAttribute('aria-busy', 'false');
    }

    initShareMenu();
  }

  init();
})();
