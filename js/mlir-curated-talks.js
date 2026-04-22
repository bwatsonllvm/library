/**
 * mlir-curated-talks.js - render curated mlir.llvm.org talks above the scoped archive browse grid.
 */

(function () {
  const HubUtils = window.LLVMHubUtils || {};
  const PAGE_PATH = 'mlir/talks/';
  const DETAIL_PATH = 'mlir/talks/talk.html';
  const SOURCE_URL = 'https://mlir.llvm.org/talks/';
  const CATEGORY_LABELS = {
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
  };

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
      const parsed = new URL(raw, document.baseURI || window.location.href);
      const protocol = parsed.protocol.toLowerCase();
      if (protocol === 'http:' || protocol === 'https:') return parsed.toString();
    } catch {
      return '';
    }
    return '';
  }

  function truncateAbstract(value, maxLength = 240) {
    const text = collapseWhitespace(value);
    if (!text || text.length <= maxLength) return text;
    const slice = text.slice(0, maxLength);
    const boundary = slice.lastIndexOf(' ');
    return `${collapseWhitespace(boundary > 120 ? slice.slice(0, boundary) : slice)}…`;
  }

  function buildTalkDetailUrl(talk) {
    const explicit = sanitizeExternalUrl(talk && talk.detailUrl);
    if (explicit) return explicit;
    return `${DETAIL_PATH}?id=${encodeURIComponent(collapseWhitespace(talk && talk.id))}`;
  }

  function categoryLabel(value) {
    const key = collapseWhitespace(value).toLowerCase();
    return CATEGORY_LABELS[key] || CATEGORY_LABELS.other;
  }

  function buildSpeakerHref(name) {
    return `${PAGE_PATH}?speaker=${encodeURIComponent(String(name || '').trim())}`;
  }

  function buildTopicHref(topic) {
    return `${PAGE_PATH}?q=${encodeURIComponent(String(topic || '').trim())}`;
  }

  function renderSpeakerButtons(talk) {
    const speakers = Array.isArray(talk && talk.speakers) ? talk.speakers : [];
    const values = speakers
      .map((speaker) => collapseWhitespace(speaker && speaker.name))
      .filter(Boolean);
    if (!values.length) return '';
    return `
      <p class="card-speakers">
        ${values.map((name) => `<a href="${escapeHtml(buildSpeakerHref(name))}" class="speaker-btn" aria-label="Filter MLIR talks by ${escapeHtml(name)}">${escapeHtml(name)}</a>`).join('<span class="speaker-btn-sep">, </span>')}
      </p>`;
  }

  function renderTopicTags(talk) {
    const getter = typeof HubUtils.getTalkKeyTopics === 'function'
      ? HubUtils.getTalkKeyTopics.bind(HubUtils)
      : null;
    const topics = getter ? getter(talk, 8) : [];
    if (!topics.length) return '';
    return `
      <div class="card-tags-wrap">
        <div class="card-tags" aria-label="Key Topics">
          ${topics.slice(0, 4).map((topic) => `<a href="${escapeHtml(buildTopicHref(topic))}" class="card-tag" aria-label="Filter MLIR talks by key topic ${escapeHtml(topic)}">${escapeHtml(topic)}</a>`).join('')}
          ${topics.length > 4 ? `<span class="card-tag card-tag--more" aria-hidden="true">+${topics.length - 4}</span>` : ''}
        </div>
      </div>`;
  }

  function normalizeResourceActions(talk) {
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

  function buildActionButtons(talk) {
    const buttons = [];
    const seenUrls = new Set();
    const actions = normalizeResourceActions(talk);

    function pushButton(label, url, extraClass = '') {
      const href = sanitizeExternalUrl(url);
      const text = String(label || '').trim();
      if (!href || !text || seenUrls.has(href)) return;
      seenUrls.add(href);
      buttons.push(
        `<a href="${escapeHtml(href)}" class="card-link-btn${extraClass ? ` ${extraClass}` : ''}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHtml(text)} in a new tab"><span aria-hidden="true">${escapeHtml(text)}</span></a>`
      );
    }

    if (talk && talk.videoUrl) {
      pushButton('Watch', talk.videoUrl, 'card-link-btn--video');
    }

    for (const action of actions) {
      if (action.kind === 'recording') continue;
      if (action.kind === 'slides') {
        pushButton(action.label || 'Slides', action.url);
        continue;
      }
      if (action.kind === 'event') {
        pushButton(action.label || 'Event', action.url);
      }
    }

    if (talk && talk.projectGithub) {
      pushButton('GitHub', talk.projectGithub);
    }

    return buttons.join('');
  }

  function renderCard(talk) {
    const title = collapseWhitespace(talk && talk.title) || 'Untitled MLIR Talk';
    const detailHref = buildTalkDetailUrl(talk);
    const meetingLabel = collapseWhitespace(talk && (talk.meetingName || talk.meetingDate || talk.meeting));
    const abstract = truncateAbstract(talk && talk.abstract);
    const badge = categoryLabel(talk && talk.category);
    const footer = buildActionButtons(talk);

    return `
      <article class="talk-card">
        <a href="${escapeHtml(detailHref)}" class="card-link-wrap" aria-label="Open ${escapeHtml(title)}">
          <div class="card-body">
            <div class="card-meta">
              <span class="badge badge-${escapeHtml(collapseWhitespace(talk && talk.category).toLowerCase() || 'other')}">${escapeHtml(badge)}</span>
              ${meetingLabel ? `<span class="meeting-label">${escapeHtml(meetingLabel)}</span>` : ''}
            </div>
            <p class="card-title">${escapeHtml(title)}</p>
            <p class="card-abstract">${escapeHtml(abstract || 'Curated MLIR talk')}</p>
          </div>
        </a>
        ${renderSpeakerButtons(talk)}
        ${renderTopicTags(talk)}
        ${footer ? `<div class="card-footer">${footer}</div>` : ''}
      </article>`;
  }

  async function init() {
    const root = document.getElementById('mlir-curated-talks-root');
    const summary = document.getElementById('mlir-curated-talks-summary');
    if (!root) return;

    if (typeof window.loadMLIRTalks !== 'function') {
      root.innerHTML = `
        <div class="empty-state" role="alert">
          <div class="empty-state-icon" aria-hidden="true">!</div>
          <h2>Could not load curated MLIR talks</h2>
          <p>The MLIR curated talk loader is not available on this page.</p>
        </div>`;
      root.setAttribute('aria-busy', 'false');
      return;
    }

    try {
      const talks = await window.loadMLIRTalks();
      if (summary) {
        summary.innerHTML = `Showing <strong>${talks.length.toLocaleString()}</strong> curated talks from <a href="${escapeHtml(SOURCE_URL)}" target="_blank" rel="noopener noreferrer">mlir.llvm.org/talks</a>.`;
      }
      root.innerHTML = Array.isArray(talks) ? talks.map((talk) => renderCard(talk)).join('') : '';
      root.setAttribute('aria-busy', 'false');
    } catch (error) {
      root.innerHTML = `
        <div class="empty-state" role="alert">
          <div class="empty-state-icon" aria-hidden="true">!</div>
          <h2>Could not load curated MLIR talks</h2>
          <p>${escapeHtml(String(error && error.message ? error.message : error))}</p>
        </div>`;
      root.setAttribute('aria-busy', 'false');
    }
  }

  init();
})();
