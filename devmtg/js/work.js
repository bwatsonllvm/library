/**
 * work.js — Unified talks + papers view for a selected speaker/topic.
 */

const HubUtils = window.LLVMHubUtils || {};

const TALK_BATCH_SIZE = 24;
const PAPER_BATCH_SIZE = 24;

const state = {
  kind: 'topic', // 'speaker' | 'topic'
  value: '',
  from: 'talks', // 'talks' | 'papers'
};

let filteredTalks = [];
let filteredPapers = [];
let renderedTalkCount = 0;
let renderedPaperCount = 0;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeValue(value) {
  return String(value || '').trim().toLowerCase();
}

function toTitleCaseSlug(slug) {
  return String(slug || '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function buildWorkUrl(kind, value) {
  const params = new URLSearchParams();
  params.set('kind', kind);
  params.set('value', String(value || '').trim());
  params.set('from', 'work');
  return `work.html?${params.toString()}`;
}

function parseStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const kindParam = normalizeValue(params.get('kind'));
  const kind = kindParam === 'speaker' ? 'speaker' : 'topic';
  const value = String(params.get('value') || params.get('q') || '').trim();
  const fromParam = normalizeValue(params.get('from'));
  const from = fromParam === 'papers' ? 'papers' : 'talks';

  state.kind = kind;
  state.value = value;
  state.from = from;
}

function normalizePaperRecord(rawPaper) {
  if (!rawPaper || typeof rawPaper !== 'object') return null;

  const paper = { ...rawPaper };
  paper.id = String(paper.id || '').trim();
  paper.title = String(paper.title || '').trim();
  paper.abstract = String(paper.abstract || '').trim();
  paper.year = String(paper.year || '').trim();
  paper.publication = String(paper.publication || '').trim();
  paper.venue = String(paper.venue || '').trim();
  paper.type = String(paper.type || '').trim();
  paper.paperUrl = String(paper.paperUrl || '').trim();

  paper.authors = Array.isArray(paper.authors)
    ? paper.authors
      .map((author) => {
        if (!author || typeof author !== 'object') return null;
        const name = String(author.name || '').trim();
        if (!name) return null;
        return { name };
      })
      .filter(Boolean)
    : [];

  paper.tags = Array.isArray(paper.tags)
    ? paper.tags.map((tag) => String(tag || '').trim()).filter(Boolean)
    : [];

  if (!paper.id || !paper.title) return null;

  paper._year = /^\d{4}$/.test(paper.year) ? paper.year : '';
  return paper;
}

function compareTalksNewestFirst(a, b) {
  const meetingDiff = String(b.meeting || '').localeCompare(String(a.meeting || ''));
  if (meetingDiff !== 0) return meetingDiff;

  const titleDiff = String(a.title || '').localeCompare(String(b.title || ''));
  if (titleDiff !== 0) return titleDiff;

  return String(a.id || '').localeCompare(String(b.id || ''));
}

function comparePapersNewestFirst(a, b) {
  const yearDiff = String(b._year || '').localeCompare(String(a._year || ''));
  if (yearDiff !== 0) return yearDiff;

  const titleDiff = String(a.title || '').localeCompare(String(b.title || ''));
  if (titleDiff !== 0) return titleDiff;

  return String(a.id || '').localeCompare(String(b.id || ''));
}

function matchesTalkEntity(talk, normalizedNeedle) {
  if (state.kind === 'speaker') {
    return (talk.speakers || []).some((speaker) => normalizeValue(speaker.name) === normalizedNeedle);
  }

  return (talk.tags || []).some((tag) => normalizeValue(tag) === normalizedNeedle);
}

function matchesPaperEntity(paper, normalizedNeedle) {
  if (state.kind === 'speaker') {
    return (paper.authors || []).some((author) => normalizeValue(author.name) === normalizedNeedle);
  }

  return (paper.tags || []).some((tag) => normalizeValue(tag) === normalizedNeedle);
}

function renderEntityLinks(items, kind) {
  if (!items || items.length === 0) return '';

  return items
    .map((label) => {
      const value = String(label || '').trim();
      if (!value) return '';
      return `<a class="speaker-btn" href="${escapeHtml(buildWorkUrl(kind, value))}">${escapeHtml(value)}</a>`;
    })
    .filter(Boolean)
    .join('<span class="speaker-btn-sep">, </span>');
}

function renderTagLinks(tags) {
  if (!tags || tags.length === 0) return '';

  const shown = tags.slice(0, 5);
  return `<div class="card-tags-wrap"><div class="card-tags" aria-label="Topics">${shown
    .map((tag) => `<a class="card-tag" href="${escapeHtml(buildWorkUrl('topic', tag))}">${escapeHtml(tag)}</a>`)
    .join('')}${tags.length > shown.length ? `<span class="card-tag card-tag--more" aria-hidden="true">+${tags.length - shown.length}</span>` : ''}</div></div>`;
}

function renderTalkCard(talk) {
  const title = escapeHtml(talk.title || 'Untitled talk');
  const meetingLabel = escapeHtml(talk.meetingName || talk.meeting || talk._year || 'Meeting');
  const talkType = escapeHtml(toTitleCaseSlug(talk.category || 'talk'));
  const speakerNames = (talk.speakers || []).map((speaker) => speaker.name).filter(Boolean);
  const speakersHtml = renderEntityLinks(speakerNames, 'speaker');

  return `
    <article class="talk-card">
      <a href="talk.html?id=${escapeHtml(talk.id || '')}" class="card-link-wrap" aria-label="${title}">
        <div class="card-body">
          <div class="card-meta">
            <span class="badge badge-technical-talk">${talkType}</span>
            <span class="meeting-label">${meetingLabel}</span>
          </div>
          <p class="card-title">${title}</p>
        </div>
      </a>
      ${speakersHtml ? `<p class="card-speakers">${speakersHtml}</p>` : ''}
      ${renderTagLinks(talk.tags || [])}
    </article>`;
}

function renderPaperCard(paper) {
  const title = escapeHtml(paper.title || 'Untitled paper');
  const venue = escapeHtml(paper.publication || paper.venue || toTitleCaseSlug(paper.type || 'paper'));
  const year = escapeHtml(paper._year || 'Unknown year');
  const authorNames = (paper.authors || []).map((author) => author.name).filter(Boolean);
  const authorsHtml = renderEntityLinks(authorNames, 'speaker');

  return `
    <article class="talk-card paper-card">
      <a href="paper.html?id=${escapeHtml(paper.id || '')}" class="card-link-wrap" aria-label="${title}">
        <div class="card-body">
          <div class="card-meta">
            <span class="badge badge-paper">Paper</span>
            <span class="meeting-label">${year}</span>
            <span class="meeting-label">${venue}</span>
          </div>
          <p class="card-title">${title}</p>
        </div>
      </a>
      ${authorsHtml ? `<p class="card-speakers paper-authors">${authorsHtml}</p>` : ''}
      ${renderTagLinks(paper.tags || [])}
    </article>`;
}

function setEmptyState(gridId, label) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  grid.setAttribute('aria-busy', 'false');
  const scope = state.value
    ? ` for "${escapeHtml(state.value)}"`
    : '';
  grid.innerHTML = `<div class="work-empty-state">No ${escapeHtml(label)} found${scope}.</div>`;
}

function renderTalkBatch(reset = false) {
  const grid = document.getElementById('work-talks-grid');
  const moreBtn = document.getElementById('work-talks-more');
  if (!grid || !moreBtn) return;

  if (reset) {
    grid.innerHTML = '';
    renderedTalkCount = 0;
  }

  if (!filteredTalks.length) {
    moreBtn.classList.add('hidden');
    setEmptyState('work-talks-grid', 'talks');
    return;
  }

  const nextCount = Math.min(renderedTalkCount + TALK_BATCH_SIZE, filteredTalks.length);
  const html = filteredTalks.slice(renderedTalkCount, nextCount).map(renderTalkCard).join('');
  grid.insertAdjacentHTML('beforeend', html);
  grid.setAttribute('aria-busy', 'false');
  renderedTalkCount = nextCount;

  const remaining = filteredTalks.length - renderedTalkCount;
  if (remaining > 0) {
    moreBtn.textContent = `Show more talks (${remaining.toLocaleString()} left)`;
    moreBtn.classList.remove('hidden');
  } else {
    moreBtn.classList.add('hidden');
  }
}

function renderPaperBatch(reset = false) {
  const grid = document.getElementById('work-papers-grid');
  const moreBtn = document.getElementById('work-papers-more');
  if (!grid || !moreBtn) return;

  if (reset) {
    grid.innerHTML = '';
    renderedPaperCount = 0;
  }

  if (!filteredPapers.length) {
    moreBtn.classList.add('hidden');
    setEmptyState('work-papers-grid', 'papers');
    return;
  }

  const nextCount = Math.min(renderedPaperCount + PAPER_BATCH_SIZE, filteredPapers.length);
  const html = filteredPapers.slice(renderedPaperCount, nextCount).map(renderPaperCard).join('');
  grid.insertAdjacentHTML('beforeend', html);
  grid.setAttribute('aria-busy', 'false');
  renderedPaperCount = nextCount;

  const remaining = filteredPapers.length - renderedPaperCount;
  if (remaining > 0) {
    moreBtn.textContent = `Show more papers (${remaining.toLocaleString()} left)`;
    moreBtn.classList.remove('hidden');
  } else {
    moreBtn.classList.add('hidden');
  }
}

function applyHeaderState() {
  const titleEl = document.getElementById('work-title');
  const subtitleEl = document.getElementById('work-subtitle');
  const summaryEl = document.getElementById('work-results-summary');
  const talksCountEl = document.getElementById('work-talks-count');
  const papersCountEl = document.getElementById('work-papers-count');
  const backLink = document.getElementById('work-back-link');
  const secondaryBackLink = document.getElementById('work-secondary-back-link');

  const entityLabel = state.kind === 'speaker' ? 'Speaker' : 'Topic';
  const backHref = state.from === 'papers' ? 'papers.html' : 'index.html';
  const backText = state.from === 'papers' ? 'Back to papers' : 'Back to talks';

  if (backLink) {
    backLink.href = backHref;
    backLink.textContent = backText;
  }
  if (secondaryBackLink) {
    secondaryBackLink.href = backHref;
    secondaryBackLink.textContent = backText;
  }

  if (!state.value) {
    if (titleEl) titleEl.textContent = 'All Work';
    if (subtitleEl) subtitleEl.textContent = 'Choose a speaker or topic from Talks or Papers to view all related work.';
    if (summaryEl) summaryEl.textContent = 'No speaker/topic selected';
    if (talksCountEl) talksCountEl.textContent = '';
    if (papersCountEl) papersCountEl.textContent = '';
    return;
  }

  if (titleEl) titleEl.textContent = `${entityLabel}: ${state.value}`;
  if (subtitleEl) subtitleEl.innerHTML = `Showing talks and papers for <strong>${escapeHtml(state.value)}</strong>`;

  if (talksCountEl) {
    talksCountEl.textContent = `${filteredTalks.length.toLocaleString()} talk${filteredTalks.length === 1 ? '' : 's'}`;
  }

  if (papersCountEl) {
    papersCountEl.textContent = `${filteredPapers.length.toLocaleString()} paper${filteredPapers.length === 1 ? '' : 's'}`;
  }

  if (summaryEl) {
    const total = filteredTalks.length + filteredPapers.length;
    summaryEl.innerHTML = `<strong>${total.toLocaleString()}</strong> total results · ${filteredTalks.length.toLocaleString()} talks · ${filteredPapers.length.toLocaleString()} papers`;
  }
}

function renderError(message) {
  const talksGrid = document.getElementById('work-talks-grid');
  const papersGrid = document.getElementById('work-papers-grid');
  const summaryEl = document.getElementById('work-results-summary');

  if (summaryEl) summaryEl.textContent = 'Could not load all work';

  const html = `<div class="work-empty-state">${escapeHtml(message)}</div>`;

  if (talksGrid) {
    talksGrid.setAttribute('aria-busy', 'false');
    talksGrid.innerHTML = html;
  }

  if (papersGrid) {
    papersGrid.setAttribute('aria-busy', 'false');
    papersGrid.innerHTML = html;
  }
}

function initMobileNavMenu() {
  const menu = document.getElementById('mobile-nav-menu');
  const toggle = document.getElementById('mobile-nav-toggle');
  const panel = document.getElementById('mobile-nav-panel');
  if (!menu || !toggle || !panel) return;

  const openMenu = () => {
    menu.classList.add('open');
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
  };

  const closeMenu = () => {
    menu.classList.remove('open');
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };

  const isInsideMenu = (target) => menu.contains(target);

  closeMenu();

  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (menu.classList.contains('open')) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  panel.addEventListener('click', (event) => {
    const target = event.target.closest('a,button');
    if (target) closeMenu();
  });

  document.addEventListener('pointerdown', (event) => {
    if (!isInsideMenu(event.target)) closeMenu();
  });

  document.addEventListener('focusin', (event) => {
    if (!isInsideMenu(event.target)) closeMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.classList.contains('open')) {
      closeMenu();
      toggle.focus();
    }
  });
}

async function init() {
  initMobileNavMenu();
  parseStateFromUrl();

  if (!state.value) {
    applyHeaderState();
    setEmptyState('work-talks-grid', 'talks');
    setEmptyState('work-papers-grid', 'papers');
    return;
  }

  if (typeof window.loadEventData !== 'function' || typeof window.loadPaperData !== 'function') {
    renderError('Data loaders are unavailable on this page.');
    return;
  }

  try {
    const [eventPayload, paperPayload] = await Promise.all([
      window.loadEventData(),
      window.loadPaperData(),
    ]);

    const talks = typeof HubUtils.normalizeTalks === 'function'
      ? HubUtils.normalizeTalks(eventPayload.talks || [])
      : (Array.isArray(eventPayload.talks) ? eventPayload.talks : []);

    const papers = Array.isArray(paperPayload.papers)
      ? paperPayload.papers.map(normalizePaperRecord).filter(Boolean)
      : [];

    const normalizedNeedle = normalizeValue(state.value);

    filteredTalks = talks
      .filter((talk) => matchesTalkEntity(talk, normalizedNeedle))
      .sort(compareTalksNewestFirst);

    filteredPapers = papers
      .filter((paper) => matchesPaperEntity(paper, normalizedNeedle))
      .sort(comparePapersNewestFirst);

    applyHeaderState();
    renderTalkBatch(true);
    renderPaperBatch(true);

    const talksMoreBtn = document.getElementById('work-talks-more');
    const papersMoreBtn = document.getElementById('work-papers-more');

    if (talksMoreBtn) talksMoreBtn.addEventListener('click', () => renderTalkBatch(false));
    if (papersMoreBtn) papersMoreBtn.addEventListener('click', () => renderPaperBatch(false));
  } catch (error) {
    renderError(`Could not load data: ${String(error && error.message ? error.message : error)}`);
  }
}

init();
