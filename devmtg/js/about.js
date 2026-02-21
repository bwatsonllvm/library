/**
 * about.js — Static about page enhancements.
 */

const HubUtils = window.LLVMHubUtils || {};

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
    if (menu.classList.contains('open')) closeMenu();
    else openMenu();
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

function setText(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function normalizeTalks(rawTalks) {
  if (typeof HubUtils.normalizeTalks === 'function') {
    return HubUtils.normalizeTalks(rawTalks);
  }
  return Array.isArray(rawTalks) ? rawTalks : [];
}

function normalizePapers(rawPapers) {
  return Array.isArray(rawPapers) ? rawPapers : [];
}

async function loadAndRenderStats() {
  let talks = [];
  let papers = [];

  try {
    if (typeof window.loadEventData === 'function') {
      const events = await window.loadEventData();
      talks = normalizeTalks(events && events.talks);
    }
    if (typeof window.loadPaperData === 'function') {
      const paperPayload = await window.loadPaperData();
      papers = normalizePapers(paperPayload && paperPayload.papers);
    }
  } catch {
    // Keep defaults if any data source fails.
  }

  const uniqueMeetings = new Set(
    talks
      .map((talk) => String((talk && talk.meeting) || '').trim())
      .filter(Boolean)
  );

  let peopleCount = 0;
  if (typeof HubUtils.buildPeopleIndex === 'function') {
    try {
      peopleCount = HubUtils.buildPeopleIndex(talks, papers).length;
    } catch {
      peopleCount = 0;
    }
  }

  setText('about-stat-talks', formatCount(talks.length));
  setText('about-stat-papers', formatCount(papers.length));
  setText('about-stat-people', formatCount(peopleCount));
  setText('about-stat-meetings', formatCount(uniqueMeetings.size));
}

(function init() {
  initMobileNavMenu();
  loadAndRenderStats();
})();
