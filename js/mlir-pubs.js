/**
 * mlir-pubs.js - curated MLIR publications section runtime.
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

  function renderDescriptions(values) {
    const descriptions = Array.isArray(values) ? values.map((value) => collapseWhitespace(value)).filter(Boolean) : [];
    if (!descriptions.length) return '';
    return descriptions.map((value) => `<p class="subproject-copy">${escapeHtml(value)}</p>`).join('');
  }

  function renderEntry(entry) {
    const actions = Array.isArray(entry && entry.actions) ? entry.actions : [];
    const title = collapseWhitespace(entry && entry.title);
    const summary = collapseWhitespace(entry && entry.summary);
    return `
      <article class="subproject-entry">
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

  function renderSections(payload) {
    const sections = Array.isArray(payload && payload.sections) ? payload.sections : [];
    return sections.map((section) => {
      const sectionTitle = collapseWhitespace(section && section.title);
      const groups = Array.isArray(section && section.groups) ? section.groups : [];
      const groupsHtml = groups.map((group) => {
        const groupTitle = collapseWhitespace(group && group.title);
        const entries = Array.isArray(group && group.entries) ? group.entries : [];
        if (!entries.length) return '';
        return `
          <div class="subproject-group">
            ${groupTitle ? `<h3 class="subproject-group-title">${escapeHtml(groupTitle)}</h3>` : ''}
            ${renderDescriptions(group && group.descriptions)}
            <div class="subproject-entry-list">
              ${entries.map((entry) => renderEntry(entry)).join('')}
            </div>
          </div>`;
      }).join('');

      return `
        <section class="subproject-section">
          ${sectionTitle ? `<div class="section-label" aria-hidden="true">${escapeHtml(sectionTitle)}</div>` : ''}
          ${renderDescriptions(section && section.descriptions)}
          ${groupsHtml}
        </section>`;
    }).join('');
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
      if (summary) {
        summary.innerHTML = `Showing <strong>${totalEntries.toLocaleString()}</strong> curated publications from <a href="${escapeHtml(sanitizeExternalUrl(payload && payload.sourceUrl))}" target="_blank" rel="noopener noreferrer">mlir.llvm.org/pubs</a>.`;
      }
      root.innerHTML = renderSections(payload);
    } catch (error) {
      root.innerHTML = `
        <div class="empty-state" role="alert">
          <div class="empty-state-icon" aria-hidden="true">!</div>
          <h2>Could not load curated MLIR publications</h2>
          <p>${escapeHtml(String(error && error.message ? error.message : error))}</p>
        </div>`;
    }

    initShareMenu();
  }

  init();
})();
