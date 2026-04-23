/**
 * home.js — Home page interactions.
 */

const HubUtils = window.LLVMHubUtils || {};
const PageShell = typeof HubUtils.createPageShell === 'function'
  ? HubUtils.createPageShell({
      mobileHeaderActionMap: {
        share: 'share-btn',
        display: 'customization-toggle',
      },
    })
  : null;

const initTheme = PageShell ? () => PageShell.initTheme() : () => {};
const initTextSize = PageShell ? () => PageShell.initTextSize() : () => {};
const initCustomizationMenu = PageShell ? () => PageShell.initCustomizationMenu() : () => {};
const initMobileNavMenu = PageShell ? () => PageShell.initMobileNavMenu() : () => {};
const initShareMenu = PageShell ? () => PageShell.initShareMenu() : () => {};

function initHomeHeroSearch() {
  const input = document.getElementById('home-search-input');
  const clearBtn = document.getElementById('home-search-clear');
  if (!input || !clearBtn) return;

  const syncClear = () => {
    const hasText = String(input.value || '').trim().length > 0;
    clearBtn.classList.toggle('visible', hasText);
  };

  input.addEventListener('input', syncClear);
  input.addEventListener('focus', syncClear);
  input.addEventListener('blur', () => {
    window.setTimeout(syncClear, 150);
  });

  clearBtn.addEventListener('click', (event) => {
    event.preventDefault();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    syncClear();
  });

  syncClear();
}

function formatCompactNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) return '';
  return number.toLocaleString();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: 'default' });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function loadViewerFile(key, fallbackPath) {
  try {
    const manifest = await fetchJson('js/data/viewer-artifacts.json');
    const ref = manifest && manifest.files ? manifest.files[key] : '';
    return fetchJson(ref || fallbackPath);
  } catch {
    return fetchJson(fallbackPath);
  }
}

async function hydrateHomeStats() {
  const statNodes = [...document.querySelectorAll('[data-home-stat]')];
  if (!statNodes.length) return;

  try {
    const stats = await loadViewerFile('siteStats', 'js/data/site-stats.json');
    for (const node of statNodes) {
      const key = node.getAttribute('data-home-stat');
      const value = Number(stats && stats[key]);
      const text = Number.isFinite(value) && value > 0 ? formatCompactNumber(value) : '';
      if (text) node.textContent = text;
    }
  } catch {
    // Keep the server-rendered fallback counts.
  }
}

async function hydratePopularTopics() {
  const container = document.getElementById('home-topic-list');
  if (!container) return;

  try {
    const index = await loadViewerFile('autocompleteIndex', 'js/data/autocomplete-index.json');
    const topics = Array.isArray(index && index.topics) ? index.topics : [];
    const shown = topics
      .filter((topic) => topic && topic.label)
      .slice(0, 8);
    if (!shown.length) return;

    container.innerHTML = shown
      .map((topic) => {
        const label = String(topic.label || '').trim();
        const count = Number(topic.count || 0);
        const countText = count > 0 ? formatCompactNumber(count) : '';
        const href = `work.html?mode=entity&kind=topic&value=${encodeURIComponent(label)}&from=work`;
        return `<a class="home-topic-chip" href="${escapeHtml(href)}">${escapeHtml(label)}${countText ? `<span aria-hidden="true">${escapeHtml(countText)}</span>` : ''}</a>`;
      })
      .join('');
  } catch {
    // Keep the curated fallback topic list.
  }
}

function init() {
  initTheme();
  initTextSize();
  initCustomizationMenu();
  initMobileNavMenu();
  initShareMenu();
  initHomeHeroSearch();
  hydrateHomeStats();
  hydratePopularTopics();
}

init();
