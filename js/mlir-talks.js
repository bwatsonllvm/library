/**
 * mlir-talks.js - MLIR subproject talks page runtime.
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

  const DATA_PATH = 'sub-projects/mlir/data/talks.json';

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

  function tokenize(query) {
    return collapseWhitespace(query)
      .toLowerCase()
      .split(' ')
      .filter((token) => token.length >= 2);
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

  function buildEntryMeta(sectionTitle, groupTitle) {
    const parts = [String(sectionTitle || '').trim(), String(groupTitle || '').trim()].filter(Boolean);
    return parts.join(' / ');
  }

  function renderDescriptions(values) {
    const descriptions = Array.isArray(values) ? values.map((value) => collapseWhitespace(value)).filter(Boolean) : [];
    if (!descriptions.length) return '';
    return descriptions.map((value) => `<p class="subproject-copy">${escapeHtml(value)}</p>`).join('');
  }

  function renderEntry(entry, metaLabel) {
    const actions = Array.isArray(entry && entry.actions) ? entry.actions : [];
    const title = collapseWhitespace(entry && entry.title);
    const summary = collapseWhitespace(entry && entry.summary);
    return `
      <article class="subproject-entry">
        ${metaLabel ? `<div class="subproject-entry-kicker">${escapeHtml(metaLabel)}</div>` : ''}
        <h3 class="subproject-entry-title">${escapeHtml(title || '(untitled item)')}</h3>
        ${summary ? `<p class="subproject-entry-summary">${escapeHtml(summary)}</p>` : ''}
        ${actions.length ? `
          <div class="subproject-entry-actions">
            ${actions.map((action) => {
              const href = sanitizeExternalUrl(action && action.url);
              const label = collapseWhitespace(action && action.label);
              if (!href || !label) return '';
              return `<a href="${escapeHtml(href)}" class="link-btn" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
            }).join('')}
          </div>` : ''}
      </article>`;
  }

  function buildGroupedMarkup(payload) {
    const sections = Array.isArray(payload && payload.sections) ? payload.sections : [];
    return sections.map((section) => {
      const sectionTitle = collapseWhitespace(section && section.title);
      const sectionGroups = Array.isArray(section && section.groups) ? section.groups : [];
      const groupsHtml = sectionGroups.map((group) => {
        const groupTitle = collapseWhitespace(group && group.title);
        const entries = Array.isArray(group && group.entries) ? group.entries : [];
        if (!entries.length) return '';
        return `
          <div class="subproject-group">
            ${groupTitle ? `<h3 class="subproject-group-title">${escapeHtml(groupTitle)}</h3>` : ''}
            ${renderDescriptions(group && group.descriptions)}
            <div class="subproject-entry-list">
              ${entries.map((entry) => renderEntry(entry, '')).join('')}
            </div>
          </div>`;
      }).join('');

      if (!groupsHtml && !(Array.isArray(section && section.descriptions) && section.descriptions.length)) return '';

      return `
        <section class="subproject-section">
          ${sectionTitle ? `<div class="section-label" aria-hidden="true">${escapeHtml(sectionTitle)}</div>` : ''}
          ${renderDescriptions(section && section.descriptions)}
          ${groupsHtml}
        </section>`;
    }).join('');
  }

  function buildSearchResults(payload, query) {
    const tokens = tokenize(query);
    const matches = [];
    const sections = Array.isArray(payload && payload.sections) ? payload.sections : [];

    for (const section of sections) {
      const sectionTitle = collapseWhitespace(section && section.title);
      for (const group of (Array.isArray(section && section.groups) ? section.groups : [])) {
        const groupTitle = collapseWhitespace(group && group.title);
        for (const entry of (Array.isArray(group && group.entries) ? group.entries : [])) {
          const haystack = collapseWhitespace([
            entry && entry.title,
            entry && entry.summary,
            entry && entry.text,
            sectionTitle,
            groupTitle,
          ].join(' ')).toLowerCase();
          if (!tokens.every((token) => haystack.includes(token))) continue;
          matches.push({ entry, meta: buildEntryMeta(sectionTitle, groupTitle) });
        }
      }
    }

    if (!matches.length) {
      return `
        <div class="empty-state" role="status">
          <div class="empty-state-icon" aria-hidden="true">!</div>
          <h2>No MLIR talks found</h2>
          <p>No upstream MLIR talks matched <strong>${escapeHtml(query)}</strong>.</p>
        </div>`;
    }

    return `
      <section class="subproject-section">
        <div class="section-label" aria-hidden="true">Search Results</div>
        <div class="subproject-entry-list">
          ${matches.map(({ entry, meta }) => renderEntry(entry, meta)).join('')}
        </div>
      </section>`;
  }

  function updateSubtitle(totalEntries, query) {
    const subtitle = document.getElementById('mlir-talks-subtitle');
    if (!subtitle) return;
    const cleanQuery = collapseWhitespace(query);
    if (!cleanQuery) {
      subtitle.innerHTML = `Browse <strong>${totalEntries.toLocaleString()}</strong> talks and design meeting presentations from the MLIR project.`;
      return;
    }
    subtitle.innerHTML = `Filtering <strong>${totalEntries.toLocaleString()}</strong> MLIR talks for <strong>${escapeHtml(cleanQuery)}</strong>.`;
  }

  function syncUrl(query) {
    const params = new URLSearchParams(window.location.search);
    const value = collapseWhitespace(query);
    if (value) params.set('q', value);
    else params.delete('q');
    const nextUrl = params.toString()
      ? `${window.location.pathname}?${params.toString()}`
      : window.location.pathname;
    history.replaceState(null, '', nextUrl);
  }

  async function init() {
    initTheme();
    initTextSize();
    initCustomizationMenu();
    initMobileNavMenu();

    const root = document.getElementById('mlir-talks-root');
    const searchInput = document.getElementById('mlir-talks-search');
    if (!root || !searchInput) {
      initShareMenu();
      return;
    }

    const params = new URLSearchParams(window.location.search);
    searchInput.value = collapseWhitespace(params.get('q') || '');

    try {
      const response = await fetch(DATA_PATH, { cache: 'default' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const totalEntries = countEntries(payload && payload.sections);

      const render = () => {
        const query = collapseWhitespace(searchInput.value);
        updateSubtitle(totalEntries, query);
        root.innerHTML = query
          ? buildSearchResults(payload, query)
          : buildGroupedMarkup(payload);
        syncUrl(query);
      };

      searchInput.addEventListener('input', render);
      render();
    } catch (error) {
      root.innerHTML = `
        <div class="empty-state" role="alert">
          <div class="empty-state-icon" aria-hidden="true">!</div>
          <h2>Could not load MLIR talks</h2>
          <p>${escapeHtml(String(error && error.message ? error.message : error))}</p>
        </div>`;
    }

    initShareMenu();
  }

  init();
})();
