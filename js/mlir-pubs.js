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

  function countEntries(sections) {
    let total = 0;
    for (const section of (Array.isArray(sections) ? sections : [])) {
      for (const group of (Array.isArray(section && section.groups) ? section.groups : [])) {
        total += Array.isArray(group && group.entries) ? group.entries.length : 0;
      }
    }
    return total;
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
        .split(/\s*,\s*/)
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

  function renderAuthors(entry) {
    const authors = extractAuthors(entry);
    if (!authors.length) return '';
    return `
      <p class="card-speakers paper-authors">
        ${authors.map((name) => `<span class="card-speaker-link">${escapeHtml(name)}</span>`).join('<span class="speaker-btn-sep">, </span>')}
      </p>`;
  }

  function renderActionButtons(actions) {
    const limited = actions.slice(0, 4);
    if (!limited.length) return '';
    return limited.map((action, index) => {
      const classes = ['card-link-btn'];
      if (index === 0) classes.push('card-link-btn--video');
      return `<a href="${escapeHtml(action.url)}" class="${classes.join(' ')}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHtml(action.label)} in a new tab"><span aria-hidden="true">${escapeHtml(action.label)}</span></a>`;
    }).join('');
  }

  function renderEntry(entry, fallbackUrl) {
    const actions = normalizeActions(entry);
    const detailHref = buildPrimaryHref(actions, fallbackUrl);
    const title = collapseWhitespace(entry && entry.title) || 'Untitled MLIR Publication';
    const year = extractYear(entry);
    const venue = extractVenue(entry);
    const summary = collapseWhitespace(entry && entry.summary);

    return `
      <article class="talk-card paper-card">
        <a href="${escapeHtml(detailHref)}" class="card-link-wrap" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHtml(title)} in a new tab">
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
        ${renderAuthors(entry)}
        ${actions.length ? `<div class="card-footer">${renderActionButtons(actions)}</div>` : ''}
      </article>`;
  }

  function renderSections(payload) {
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
    return entries.map((entry) => renderEntry(entry, fallbackUrl)).join('');
  }

  async function init() {
    const root = document.getElementById('mlir-curated-pubs-root');
    const summary = document.getElementById('mlir-curated-pubs-summary');
    if (!root) {
      initShareMenu();
      return;
    }

    try {
      const response = await fetch(DATA_PATH, { cache: 'default' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const totalEntries = countEntries(payload && payload.sections);
      const sourceUrl = sanitizeExternalUrl(payload && payload.sourceUrl);
      if (summary) {
        summary.innerHTML = `Showing <strong>${totalEntries.toLocaleString()}</strong> curated publications from <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">mlir.llvm.org/pubs</a>.`;
      }
      root.innerHTML = renderSections(payload);
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
