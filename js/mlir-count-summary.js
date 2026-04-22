/**
 * mlir-count-summary.js - fixes legacy MLIR talks/pubs hero counts to use MLIR-wide totals.
 */

(function () {
  const HubUtils = window.LLVMHubUtils || {};
  const getTalkKeyTopics = typeof HubUtils.getTalkKeyTopics === 'function'
    ? HubUtils.getTalkKeyTopics.bind(HubUtils)
    : null;
  const getPaperKeyTopics = typeof HubUtils.getPaperKeyTopics === 'function'
    ? HubUtils.getPaperKeyTopics.bind(HubUtils)
    : null;

  const CURATED_TALKS_PATH = 'sub-projects/mlir/data/talks.json';
  const CURATED_PUBS_PATH = 'sub-projects/mlir/data/publications.json';
  const BLOG_SOURCE_SLUGS = new Set(['llvm-blog-www', 'llvm-www-blog']);

  function collapseWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeTopicKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
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

  function countEntries(payload) {
    let total = 0;
    for (const section of (Array.isArray(payload && payload.sections) ? payload.sections : [])) {
      for (const group of (Array.isArray(section && section.groups) ? section.groups : [])) {
        total += Array.isArray(group && group.entries) ? group.entries.length : 0;
      }
    }
    return total;
  }

  function hasMlirTalkTopic(talk) {
    if (!getTalkKeyTopics) return false;
    return getTalkKeyTopics(talk, Infinity).some((topic) => normalizeTopicKey(topic) === 'mlir');
  }

  function hasMlirPaperTopic(paper) {
    if (!getPaperKeyTopics) return false;
    return getPaperKeyTopics(paper, Infinity).some((topic) => normalizeTopicKey(topic) === 'mlir');
  }

  async function updateLegacyTalksSummary() {
    const subtitle = document.getElementById('hero-subtitle');
    if (!subtitle || typeof window.loadEventData !== 'function') return;

    const [archivePayload, curatedResponse] = await Promise.all([
      window.loadEventData(),
      fetch(CURATED_TALKS_PATH, { cache: 'default' }),
    ]);
    if (!curatedResponse.ok) return;
    const curatedPayload = await curatedResponse.json();
    const curatedCount = countEntries(curatedPayload);
    const archiveCount = (Array.isArray(archivePayload && archivePayload.talks) ? archivePayload.talks : [])
      .filter((talk) => talk && typeof talk === 'object' && hasMlirTalkTopic(talk))
      .length;

    const totalCountEl = document.getElementById('total-count');
    if (totalCountEl) totalCountEl.textContent = (curatedCount + archiveCount).toLocaleString();
    subtitle.innerHTML = `Browse <strong id="total-count">${(curatedCount + archiveCount).toLocaleString()}</strong> MLIR talks overall: <strong>${curatedCount.toLocaleString()}</strong> from mlir.llvm.org and <strong>${archiveCount.toLocaleString()}</strong> in the MLIR-tagged archive below.`;
  }

  async function updateLegacyPubsSummary() {
    const subtitle = document.getElementById('papers-subtitle');
    if (!subtitle || typeof window.loadPaperData !== 'function') return;

    const [paperPayload, curatedResponse] = await Promise.all([
      window.loadPaperData(),
      fetch(CURATED_PUBS_PATH, { cache: 'default' }),
    ]);
    if (!curatedResponse.ok) return;
    const curatedPayload = await curatedResponse.json();
    const curatedCount = countEntries(curatedPayload);
    const archiveCount = (Array.isArray(paperPayload && paperPayload.papers) ? paperPayload.papers : [])
      .filter((paper) => paper && typeof paper === 'object' && !isBlogPaper(paper) && hasMlirPaperTopic(paper))
      .length;

    subtitle.innerHTML = `Browse <strong>${archiveCount.toLocaleString()}</strong> MLIR papers in the library, with <strong>${curatedCount.toLocaleString()}</strong> also curated on mlir.llvm.org.`;
  }

  async function init() {
    try {
      if (document.getElementById('hero-subtitle') && document.getElementById('total-count')) {
        await updateLegacyTalksSummary();
      }
      if (document.getElementById('papers-subtitle')) {
        await updateLegacyPubsSummary();
      }
    } catch {
      // Leave the existing page copy alone on failure.
    }
  }

  init();
})();
