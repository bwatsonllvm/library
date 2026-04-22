/**
 * paper.js - minimal paper/blog detail runtime.
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

  const BLOGS_PAGE_PATH = 'blogs/';
  const PAPERS_PAGE_PATH = 'papers/';
  const MLIR_PUBS_PAGE_PATH = 'mlir/pubs/';
  const TALK_PAPER_LINKS_PATH = 'js/data/talk-paper-links.json';
  const BLOG_SOURCE_SLUGS = new Set(['llvm-blog-www', 'llvm-www-blog']);
  const PAPER_TO_TALK_REDIRECTS = Object.freeze({});
  const BLOG_HTML_ALLOWED_TAGS = new Set([
    'a', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'em', 'figcaption', 'figure',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
    's', 'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th',
    'thead', 'tr', 'ul',
  ]);
  const BLOG_HTML_VOID_TAGS = new Set(['br', 'hr', 'img']);
  const BLOG_HTML_DROP_TAGS = new Set([
    'button', 'embed', 'form', 'iframe', 'input', 'link', 'meta', 'noscript', 'object', 'script',
    'select', 'style', 'textarea',
  ]);

  let talkPaperLinkIndexPromise = null;

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

  function normalizeIsoDate(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return '';
    const year = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);
    const day = Number.parseInt(match[3], 10);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return '';
    if (month < 1 || month > 12 || day < 1 || day > 31) return '';
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  function formatIsoDateLabel(value) {
    const iso = normalizeIsoDate(value);
    if (!iso) return '';
    const [year, month, day] = iso.split('-').map((part) => Number.parseInt(part, 10));
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return '';
    const stamp = new Date(Date.UTC(year, month - 1, day));
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(stamp);
  }

  function normalizePeople(authors) {
    const values = Array.isArray(authors) ? authors : [];
    return values.map((author) => {
      if (typeof HubUtils.normalizePersonRecord === 'function') {
        const normalized = HubUtils.normalizePersonRecord(author);
        if (!normalized || !normalized.name) return null;
        const affiliation = author && typeof author === 'object'
          ? String(author.affiliation || '').trim()
          : '';
        return { name: normalized.name, affiliation };
      }
      if (!author || typeof author !== 'object') return null;
      const name = String(author.name || '').trim();
      if (!name) return null;
      return {
        name,
        affiliation: String(author.affiliation || '').trim(),
      };
    }).filter(Boolean);
  }

  function extractDoi(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const match = raw.match(/10\.\d{4,9}\/[\w.()\-;/:%+]+/i);
    return match ? String(match[0]).trim() : '';
  }

  function normalizeOpenAlexId(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return sanitizeExternalUrl(raw);
    const cleaned = raw.replace(/^https?:\/\/openalex\.org\//i, '').replace(/^works\//i, '').trim();
    if (!/^W\d+$/i.test(cleaned)) return '';
    return `https://openalex.org/${cleaned.toUpperCase()}`;
  }

  function normalizePaperRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const paper = { ...raw };
    paper.id = String(paper.id || '').trim();
    paper.title = String(paper.title || '').trim();
    paper.abstract = String(paper.abstract || '').trim();
    paper.year = String(paper.year || '').trim();
    paper.publishedDate = normalizeIsoDate(paper.publishedDate || paper.publishDate || paper.date);
    paper.publication = String(paper.publication || '').trim();
    paper.venue = String(paper.venue || '').trim();
    paper.source = String(paper.source || '').trim();
    paper.sourceName = String(paper.sourceName || '').trim();
    paper.type = String(paper.type || '').trim();
    paper.paperUrl = sanitizeExternalUrl(paper.paperUrl || '');
    paper.sourceUrl = sanitizeExternalUrl(paper.sourceUrl || '');
    paper.contentFormat = String(paper.contentFormat || paper.bodyFormat || '').trim().toLowerCase();
    paper.content = String(paper.content || paper.body || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    paper.citationCount = Number.isFinite(Number(paper.citationCount)) ? Number(paper.citationCount) : 0;
    paper.authors = normalizePeople(paper.authors);
    paper.tags = Array.isArray(paper.tags) ? paper.tags.map((v) => String(v || '').trim()).filter(Boolean) : [];
    paper.keywords = Array.isArray(paper.keywords) ? paper.keywords.map((v) => String(v || '').trim()).filter(Boolean) : [];
    if (!paper.keywords.length && paper.tags.length) paper.keywords = [...paper.tags];

    const doiCandidate = extractDoi(paper.doi) || extractDoi(paper.paperUrl) || extractDoi(paper.sourceUrl);
    paper.doi = doiCandidate;
    paper.openalexId = normalizeOpenAlexId(paper.openalexId || paper.openAlexId || '');

    if (!paper.id || !paper.title) return null;

    paper._year = /^\d{4}$/.test(paper.year) ? paper.year : '';
    paper._publishedDate = paper.publishedDate;
    paper._publishedDateLabel = formatIsoDateLabel(paper._publishedDate);

    const normalizedType = String(paper.type || '').trim().toLowerCase();
    const normalizedSource = String(paper.source || '').trim().toLowerCase();
    paper._isBlog = BLOG_SOURCE_SLUGS.has(normalizedSource) || normalizedType === 'blog-post' || normalizedType === 'blog';

    return paper;
  }

  function normalizePapers(rawPapers) {
    if (!Array.isArray(rawPapers)) return [];
    return rawPapers.map(normalizePaperRecord).filter(Boolean);
  }

  function normalizeTalks(rawTalks) {
    if (typeof HubUtils.normalizeTalks === 'function') return HubUtils.normalizeTalks(rawTalks);
    return Array.isArray(rawTalks) ? rawTalks : [];
  }

  function formatMeetingDate(value) {
    if (typeof HubUtils.formatMeetingDateUniversal === 'function') {
      return HubUtils.formatMeetingDateUniversal(value);
    }
    return String(value || '').trim();
  }

  function getPaperTopics(paper, limit = Infinity) {
    if (typeof HubUtils.getPaperKeyTopics === 'function') {
      return HubUtils.getPaperKeyTopics(paper, limit);
    }
    const values = [
      ...(Array.isArray(paper && paper.tags) ? paper.tags : []),
      ...(Array.isArray(paper && paper.keywords) ? paper.keywords : []),
    ];
    const deduped = [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
    return Number.isFinite(limit) ? deduped.slice(0, Math.max(0, Math.floor(limit))) : deduped;
  }

  function isBlogPaper(paper) {
    return !!(paper && paper._isBlog);
  }

  function getListingPathForPaper(paper) {
    return isBlogPaper(paper) ? BLOGS_PAGE_PATH : PAPERS_PAGE_PATH;
  }

  function getListingLabelForPaper(paper) {
    return isBlogPaper(paper) ? 'blogs' : 'papers';
  }

  function fallbackListingContextFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const from = String(params.get('from') || '').trim().toLowerCase();
    if (from === 'blogs' || from === 'blog') {
      return { path: BLOGS_PAGE_PATH, label: 'blogs', title: 'All Blogs', itemType: 'Blog' };
    }
    if (from === 'mlir-pubs') {
      return { path: MLIR_PUBS_PAGE_PATH, label: 'MLIR publications', title: 'MLIR Publications', itemType: 'Paper' };
    }
    return { path: PAPERS_PAGE_PATH, label: 'papers', title: 'All Papers', itemType: 'Paper' };
  }

  function getListingContextForPaper(paper) {
    if (isBlogPaper(paper)) {
      return { path: BLOGS_PAGE_PATH, label: 'blogs', title: 'All Blogs', itemType: 'Blog' };
    }
    const requested = fallbackListingContextFromUrl();
    if (requested.path === MLIR_PUBS_PAGE_PATH) return requested;
    return { path: PAPERS_PAGE_PATH, label: 'papers', title: 'All Papers', itemType: 'Paper' };
  }

  function buildSpeakerWorkUrl(name, paper) {
    const speaker = String(name || '').trim();
    if (!speaker) return 'work.html';
    const from = isBlogPaper(paper) ? 'blogs' : 'papers';
    return `work.html?kind=speaker&value=${encodeURIComponent(speaker)}&from=${from}`;
  }

  function isMlirTalkId(value) {
    return String(value || '').trim().toLowerCase().startsWith('mlir-talk-');
  }

  function setIssueContext(context) {
    if (typeof window.setLibraryIssueContext !== 'function') return;
    if (!context || typeof context !== 'object') return;
    window.setLibraryIssueContext(context);
  }

  function setIssueContextForPaper(paper) {
    if (!paper || typeof paper !== 'object') return;
    setIssueContext({
      pageType: 'Paper',
      itemType: isBlogPaper(paper) ? 'Blog' : 'Paper',
      itemId: String(paper.id || '').trim(),
      itemTitle: String(paper.title || '').trim(),
      pageTitle: `${String(paper.title || '').trim()} — LLVM Research Library`,
      year: String(paper._year || '').trim(),
      paperUrl: String(paper.paperUrl || '').trim(),
      sourceUrl: String(paper.sourceUrl || '').trim(),
      doi: String(paper.doi || '').trim(),
      openalexId: String(paper.openalexId || '').trim(),
    });
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

  function updateSeo(paper) {
    if (!paper || typeof paper !== 'object') return;
    const title = String(paper.title || '').trim();
    if (!title) return;
    const description = String(paper.abstract || '').replace(/\s+/g, ' ').trim().slice(0, 260);
    upsertMeta('name', 'description', description || `${title} details`);
    upsertMeta('property', 'og:type', 'article');
    upsertMeta('property', 'og:title', `${title} — LLVM Research Library`);
    upsertMeta('property', 'og:description', description || title);
    upsertMeta('property', 'og:url', window.location.href);
    upsertMeta('name', 'twitter:card', 'summary');
    upsertMeta('name', 'twitter:title', `${title} — LLVM Research Library`);
    upsertMeta('name', 'twitter:description', description || title);
  }

  function doiUrlFromValue(doi) {
    const normalized = extractDoi(doi);
    return normalized ? `https://doi.org/${normalized}` : '';
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

  async function loadPaperDetailContextById(paperId) {
    const targetId = String(paperId || '').trim();
    if (!targetId) return { loaded: true, paper: null, relatedPool: [], related: null };

    if (typeof window.loadPaperRecordById === 'function') {
      try {
        const payload = await window.loadPaperRecordById(targetId);
        if (!payload || typeof payload !== 'object') {
          return { loaded: true, paper: null, relatedPool: [], related: null };
        }
        const paper = normalizePaperRecord(payload.paper);
        const relatedPool = Array.isArray(payload && payload.related && payload.related.relatedPapers)
          ? payload.related.relatedPapers
          : (Array.isArray(payload.papers) ? payload.papers : []);
        return {
          loaded: true,
          paper,
          relatedPool,
          related: payload.related && typeof payload.related === 'object' ? payload.related : null,
        };
      } catch {
        // Fallback below.
      }
    }

    if (typeof window.loadPaperData !== 'function') {
      return { loaded: false, paper: null, relatedPool: [], related: null };
    }

    try {
      const payload = await window.loadPaperData();
      const papers = normalizePapers(payload && payload.papers);
      const paper = papers.find((candidate) => candidate.id === targetId) || null;
      return { loaded: true, paper, relatedPool: papers, related: null };
    } catch {
      return { loaded: false, paper: null, relatedPool: [], related: null };
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

  function sanitizeContentHref(value, paper) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.startsWith('#')) return raw;
    try {
      const baseUrl = sanitizeExternalUrl((paper && (paper.sourceUrl || paper.paperUrl)) || '') || window.location.href;
      const parsed = new URL(raw, baseUrl);
      const protocol = parsed.protocol.toLowerCase();
      if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') return parsed.toString();
    } catch {
      return '';
    }
    return '';
  }

  function sanitizeContentSrc(value, paper) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const baseUrl = sanitizeExternalUrl((paper && (paper.sourceUrl || paper.paperUrl)) || '') || window.location.href;
      const parsed = new URL(raw, baseUrl);
      const protocol = parsed.protocol.toLowerCase();
      if (protocol === 'http:' || protocol === 'https:') return parsed.toString();
    } catch {
      return '';
    }
    return '';
  }

  function createInlineHtmlTokenStore() {
    const tokens = [];
    return {
      stash(html) {
        const key = `\u0000BLOG_HTML_${tokens.length}\u0000`;
        tokens.push(String(html || ''));
        return key;
      },
      restore(text) {
        return String(text || '').replace(/\u0000BLOG_HTML_(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '');
      },
    };
  }

  function parseShortcodeAttributes(raw) {
    const attrs = {};
    const source = String(raw || '');
    const attrRe = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'}]+))/g;
    let match;
    while ((match = attrRe.exec(source)) !== null) {
      const key = String(match[1] || '').trim().toLowerCase();
      if (!key) continue;
      const value = String(match[2] || match[3] || match[4] || '').trim();
      attrs[key] = value;
    }
    return attrs;
  }

  function buildBlogFigureHtml(attrs, paper) {
    const src = sanitizeContentSrc(attrs.src || '', paper);
    const alt = String(attrs.alt || attrs.caption || attrs.title || '').trim();
    const caption = String(attrs.caption || attrs.title || '').trim();
    if (!src) {
      const sourceHref = sanitizeExternalUrl(paper && paper.sourceUrl);
      if (!sourceHref) return '';
      return `<p><a class="hugo-shortcode-link" href="${escapeHtml(sourceHref)}" target="_blank" rel="noopener noreferrer">View figure on the original blog post</a></p>`;
    }

    const imgAttrs = [
      `src="${escapeHtml(src)}"`,
      `alt="${escapeHtml(alt)}"`,
      'loading="lazy"',
      'decoding="async"',
    ];
    return `<figure class="hugo-figure"><img ${imgAttrs.join(' ')}>${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`;
  }

  function replaceHugoShortcodes(raw, paper) {
    const source = String(raw || '');
    if (!source.includes('{{')) return source;

    const withFigures = source.replace(/\{\{[<%]\s*figure\b([\s\S]*?)[>%]\}\}/gi, (_, attrBlob) => {
      return buildBlogFigureHtml(parseShortcodeAttributes(attrBlob), paper);
    });

    return withFigures.replace(/\{\{[<%][\s\S]*?[>%]\}\}/g, () => {
      const sourceHref = sanitizeExternalUrl(paper && paper.sourceUrl);
      if (!sourceHref) return '';
      return `<p><a class="hugo-shortcode-link" href="${escapeHtml(sourceHref)}" target="_blank" rel="noopener noreferrer">View embedded content on the original blog post</a></p>`;
    });
  }

  function sanitizeBlogHtmlFragment(rawHtml, paper) {
    const source = String(rawHtml || '').trim();
    if (!source || !document || typeof document.createElement !== 'function') return '';

    function sanitizeNodes(nodes) {
      return Array.from(nodes || []).map((node) => sanitizeNode(node)).join('');
    }

    function sanitizeNode(node) {
      if (!node) return '';
      if (node.nodeType === 3) return escapeHtml(node.textContent || '');
      if (node.nodeType !== 1) return '';

      const tag = String(node.tagName || '').toLowerCase();
      if (BLOG_HTML_DROP_TAGS.has(tag)) return '';
      if (!BLOG_HTML_ALLOWED_TAGS.has(tag)) return sanitizeNodes(node.childNodes);

      const attrs = [];
      const id = String(node.getAttribute('id') || '').trim();
      const className = String(node.getAttribute('class') || '').trim();
      const title = String(node.getAttribute('title') || '').trim();
      const lang = String(node.getAttribute('lang') || '').trim();

      if (id) attrs.push(`id="${escapeHtml(id)}"`);
      if (className) attrs.push(`class="${escapeHtml(className)}"`);
      if (title) attrs.push(`title="${escapeHtml(title)}"`);
      if (lang) attrs.push(`lang="${escapeHtml(lang)}"`);

      if (tag === 'a') {
        const href = sanitizeContentHref(node.getAttribute('href'), paper);
        if (!href) return sanitizeNodes(node.childNodes);
        attrs.push(`href="${escapeHtml(href)}"`);
        if (!href.startsWith('#') && !href.startsWith('mailto:')) {
          attrs.push('target="_blank"', 'rel="noopener noreferrer"');
        }
      }

      if (tag === 'img') {
        const src = sanitizeContentSrc(node.getAttribute('src'), paper);
        if (!src) return '';
        attrs.push(`src="${escapeHtml(src)}"`);
        attrs.push(`alt="${escapeHtml(String(node.getAttribute('alt') || '').trim())}"`);

        const width = Number.parseInt(node.getAttribute('width') || '', 10);
        const height = Number.parseInt(node.getAttribute('height') || '', 10);
        if (Number.isFinite(width) && width > 0) attrs.push(`width="${width}"`);
        if (Number.isFinite(height) && height > 0) attrs.push(`height="${height}"`);
        attrs.push('loading="lazy"', 'decoding="async"');
      }

      if ((tag === 'td' || tag === 'th') && node.hasAttribute('colspan')) {
        const colspan = Number.parseInt(node.getAttribute('colspan') || '', 10);
        if (Number.isFinite(colspan) && colspan > 1) attrs.push(`colspan="${colspan}"`);
      }
      if ((tag === 'td' || tag === 'th') && node.hasAttribute('rowspan')) {
        const rowspan = Number.parseInt(node.getAttribute('rowspan') || '', 10);
        if (Number.isFinite(rowspan) && rowspan > 1) attrs.push(`rowspan="${rowspan}"`);
      }
      if (tag === 'details' && node.hasAttribute('open')) {
        attrs.push('open');
      }

      if (BLOG_HTML_VOID_TAGS.has(tag)) {
        return `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
      }

      return `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${sanitizeNodes(node.childNodes)}</${tag}>`;
    }

    const template = document.createElement('template');
    template.innerHTML = replaceHugoShortcodes(source, paper);
    return sanitizeNodes(template.content.childNodes).trim();
  }

  function renderInlineMarkdown(rawText, paper) {
    const store = createInlineHtmlTokenStore();
    let text = String(rawText || '');

    text = text.replace(/`([^`]+)`/g, (_, code) => store.stash(`<code>${escapeHtml(code)}</code>`));

    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, rawSrc, title) => {
      const src = sanitizeContentSrc(rawSrc, paper);
      if (!src) return String(alt || '');
      const attrs = [
        `src="${escapeHtml(src)}"`,
        `alt="${escapeHtml(alt || '')}"`,
        'loading="lazy"',
        'decoding="async"',
      ];
      if (title) attrs.push(`title="${escapeHtml(title)}"`);
      return store.stash(`<img ${attrs.join(' ')}>`); // Inline markdown images are safe after URL sanitization.
    });

    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, label, rawHref, title) => {
      const href = sanitizeContentHref(rawHref, paper);
      const labelHtml = renderInlineMarkdown(label, paper);
      if (!href) return String(label || '');
      const attrs = [`href="${escapeHtml(href)}"`];
      if (title) attrs.push(`title="${escapeHtml(title)}"`);
      if (!href.startsWith('#') && !href.startsWith('mailto:')) {
        attrs.push('target="_blank"', 'rel="noopener noreferrer"');
      }
      return store.stash(`<a ${attrs.join(' ')}>${labelHtml}</a>`);
    });

    text = escapeHtml(text);
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    text = text.replace(/(^|[^\w*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
    text = text.replace(/(^|[^\w_])_([^_]+)_(?!\w)/g, '$1<em>$2</em>');
    return store.restore(text);
  }

  function isTableSeparatorRow(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed.includes('|')) return false;
    return /^[:|\-\s]+$/.test(trimmed);
  }

  function splitTableCells(line) {
    let trimmed = String(line || '').trim();
    if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
    if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
    return trimmed.split('|').map((cell) => cell.trim());
  }

  function looksLikeHtmlBlockStart(line) {
    const trimmed = String(line || '').trim();
    const match = trimmed.match(/^<\/?([A-Za-z][\w:-]*)\b/);
    if (!match) return false;
    const tag = String(match[1] || '').toLowerCase();
    return BLOG_HTML_ALLOWED_TAGS.has(tag) || BLOG_HTML_DROP_TAGS.has(tag);
  }

  function renderMarkdownTable(lines, startIndex, paper) {
    const headerLine = String(lines[startIndex] || '');
    const separatorLine = String(lines[startIndex + 1] || '');
    if (!headerLine.includes('|') || !isTableSeparatorRow(separatorLine)) return null;

    let index = startIndex + 2;
    const rowLines = [];
    while (index < lines.length) {
      const current = String(lines[index] || '');
      if (!current.trim() || !current.includes('|')) break;
      rowLines.push(current);
      index += 1;
    }

    const headers = splitTableCells(headerLine)
      .map((cell) => `<th>${renderInlineMarkdown(cell, paper)}</th>`)
      .join('');
    const bodyRows = rowLines
      .map((row) => `<tr>${splitTableCells(row).map((cell) => `<td>${renderInlineMarkdown(cell, paper)}</td>`).join('')}</tr>`)
      .join('');

    return {
      html: `<table><thead><tr>${headers}</tr></thead>${bodyRows ? `<tbody>${bodyRows}</tbody>` : ''}</table>`,
      nextIndex: index,
    };
  }

  function renderMarkdownList(lines, startIndex, paper) {
    const ordered = /^\s*\d+\.\s+/.test(String(lines[startIndex] || ''));
    const itemRe = ordered ? /^(\s*)\d+\.\s+(.*)$/ : /^(\s*)[-*+]\s+(.*)$/;
    const items = [];
    let index = startIndex;
    let current = null;

    while (index < lines.length) {
      const line = String(lines[index] || '');
      if (!line.trim()) break;

      const match = line.match(itemRe);
      if (match) {
        if (current) items.push(current);
        current = [String(match[2] || '').trim()];
        index += 1;
        continue;
      }

      if (current && /^\s{2,}\S/.test(line)) {
        current.push(line.trim());
        index += 1;
        continue;
      }
      break;
    }

    if (current) items.push(current);
    if (!items.length) return null;

    const tag = ordered ? 'ol' : 'ul';
    const html = items
      .map((itemLines) => {
        const rendered = renderInlineMarkdown(itemLines.join('\n'), paper)
          .replace(/ {2,}\n/g, '<br>')
          .replace(/\n/g, ' ');
        return `<li>${rendered}</li>`;
      })
      .join('');

    return { html: `<${tag}>${html}</${tag}>`, nextIndex: index };
  }

  function renderMarkdownBlockquote(lines, startIndex, paper) {
    const quoteLines = [];
    let index = startIndex;

    while (index < lines.length) {
      const line = String(lines[index] || '');
      if (!line.trim()) {
        quoteLines.push('');
        index += 1;
        continue;
      }
      if (!/^\s*>/.test(line)) break;
      quoteLines.push(line.replace(/^\s*>\s?/, ''));
      index += 1;
    }

    const innerHtml = renderMarkdownContent(quoteLines.join('\n'), paper);
    if (!innerHtml) return null;
    return { html: `<blockquote>${innerHtml}</blockquote>`, nextIndex: index };
  }

  function renderMarkdownParagraph(lines, startIndex, paper) {
    const paragraphLines = [];
    let index = startIndex;

    while (index < lines.length) {
      const line = String(lines[index] || '');
      if (!line.trim()) break;
      if (
        /^(#{1,6})\s+/.test(line)
        || /^\s*(?:[-*_]){3,}\s*$/.test(line)
        || /^\s*>/.test(line)
        || looksLikeHtmlBlockStart(line)
        || /^\s*(?:[-*+]|\d+\.)\s+/.test(line)
      ) {
        if (paragraphLines.length) break;
      }
      if (paragraphLines.length && line.includes('|') && isTableSeparatorRow(lines[index + 1])) break;
      paragraphLines.push(line);
      index += 1;
    }

    const rendered = renderInlineMarkdown(paragraphLines.join('\n').trim(), paper)
      .replace(/ {2,}\n/g, '<br>')
      .replace(/\n/g, ' ');
    return { html: rendered ? `<p>${rendered}</p>` : '', nextIndex: index };
  }

  function renderMarkdownContent(rawContent, paper) {
    const content = replaceHugoShortcodes(String(rawContent || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'), paper);
    if (!content.trim()) return '';

    const lines = content.split('\n');
    const parts = [];
    let index = 0;

    while (index < lines.length) {
      const line = String(lines[index] || '');
      const trimmed = line.trim();
      if (!trimmed) {
        index += 1;
        continue;
      }

      const fenceMatch = trimmed.match(/^(```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/);
      if (fenceMatch) {
        const fence = fenceMatch[1];
        const language = String(fenceMatch[2] || '').trim().toLowerCase();
        const codeLines = [];
        index += 1;
        while (index < lines.length && String(lines[index] || '').trim() !== fence) {
          codeLines.push(String(lines[index] || ''));
          index += 1;
        }
        if (index < lines.length) index += 1;
        const className = language ? ` class="blog-code language-${escapeHtml(language)}"` : ' class="blog-code"';
        parts.push(`<pre class="blog-code-block"><code${className}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        continue;
      }

      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const level = Math.min(6, Math.max(1, headingMatch[1].length));
        parts.push(`<h${level}>${renderInlineMarkdown(headingMatch[2], paper)}</h${level}>`);
        index += 1;
        continue;
      }

      if (/^\s*(?:[-*_]){3,}\s*$/.test(line)) {
        parts.push('<hr>');
        index += 1;
        continue;
      }

      const table = renderMarkdownTable(lines, index, paper);
      if (table) {
        parts.push(table.html);
        index = table.nextIndex;
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = renderMarkdownBlockquote(lines, index, paper);
        if (quote) {
          parts.push(quote.html);
          index = quote.nextIndex;
          continue;
        }
      }

      if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
        const list = renderMarkdownList(lines, index, paper);
        if (list) {
          parts.push(list.html);
          index = list.nextIndex;
          continue;
        }
      }

      if (looksLikeHtmlBlockStart(line)) {
        const htmlLines = [];
        while (index < lines.length && String(lines[index] || '').trim()) {
          htmlLines.push(String(lines[index] || ''));
          index += 1;
        }
        const sanitized = sanitizeBlogHtmlFragment(htmlLines.join('\n'), paper);
        if (sanitized) parts.push(sanitized);
        continue;
      }

      const paragraph = renderMarkdownParagraph(lines, index, paper);
      if (paragraph) {
        if (paragraph.html) parts.push(paragraph.html);
        index = paragraph.nextIndex;
        continue;
      }

      index += 1;
    }

    return parts.join('\n');
  }

  function renderBlogContent(paper) {
    const content = String((paper && paper.content) || '').trim();
    if (!content) return renderAbstract(paper && paper.abstract);

    const format = String((paper && paper.contentFormat) || '').trim().toLowerCase();
    if (format === 'html') {
      const html = sanitizeBlogHtmlFragment(content, paper);
      return html || renderAbstract(paper && paper.abstract);
    }

    const markdown = renderMarkdownContent(content, paper);
    return markdown || renderAbstract(paper && paper.abstract);
  }

  function renderAuthors(authors, paper) {
    const values = Array.isArray(authors) ? authors : [];
    if (!values.length) {
      return '<p style="color: var(--color-text-muted); font-size: var(--font-size-sm);">Author information not available.</p>';
    }
    return values.map((author) => {
      const name = String(author && author.name || '').trim();
      if (!name) return '';
      const affiliation = String(author && author.affiliation || '').trim();
      return `
        <div class="speaker-chip">
          <div>
            <a href="${buildSpeakerWorkUrl(name, paper)}" class="speaker-name-link" aria-label="View talks and papers by ${escapeHtml(name)}">${escapeHtml(name)}</a>
            ${affiliation ? `<br><span class="speaker-affiliation">${escapeHtml(affiliation)}</span>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  function countTagOverlap(candidate, tagSet) {
    if (!(tagSet instanceof Set) || !tagSet.size) return 0;
    const values = [
      ...(Array.isArray(candidate && candidate.tags) ? candidate.tags : []),
      ...(Array.isArray(candidate && candidate.keywords) ? candidate.keywords : []),
    ];
    let overlap = 0;
    for (const value of values) {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized && tagSet.has(normalized)) overlap += 1;
    }
    return overlap;
  }

  function getRelatedPapers(paper, relatedPool) {
    const values = Array.isArray(relatedPool) ? relatedPool : [];
    if (!values.length) return [];

    const targetId = String(paper && paper.id || '').trim();
    if (!targetId) return [];

    const targetIsBlog = isBlogPaper(paper);
    const targetYear = String(paper && paper._year || '').trim();
    const tagSet = new Set(
      [
        ...(Array.isArray(paper && paper.tags) ? paper.tags : []),
        ...(Array.isArray(paper && paper.keywords) ? paper.keywords : []),
      ]
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
    );

    const MAX_SCAN = 8000;
    const stride = values.length > MAX_SCAN ? Math.ceil(values.length / MAX_SCAN) : 1;

    const scored = [];
    const seenIds = new Set();
    for (let index = 0; index < values.length; index += stride) {
      const candidate = values[index];
      if (!candidate || typeof candidate !== 'object') continue;
      const id = String(candidate.id || '').trim();
      if (!id || id === targetId || seenIds.has(id)) continue;
      seenIds.add(id);

      const normalized = normalizePaperRecord(candidate);
      if (!normalized) continue;

      const sameYear = !!(targetYear && normalized._year === targetYear);
      const overlap = countTagOverlap(normalized, tagSet);
      if (!sameYear && overlap < 1) continue;

      let score = 0;
      if (sameYear) score += 120;
      score += overlap * 28;
      if (isBlogPaper(normalized) === targetIsBlog) score += 10;
      if (normalized._year) score += Number.parseInt(normalized._year, 10) * 0.001;

      scored.push({ paper: normalized, score, overlap });
    }

    scored.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      const overlapDiff = b.overlap - a.overlap;
      if (overlapDiff !== 0) return overlapDiff;
      return String(a.paper.title || '').localeCompare(String(b.paper.title || ''));
    });

    return scored.slice(0, 6).map((entry) => entry.paper);
  }

  function buildTalkDetailUrl(talk) {
    const talkId = String(talk && talk.id || '').trim();
    const detailPath = isMlirTalkId(talkId)
      ? 'mlir/talks/talk.html'
      : 'talks/talk.html';
    return `${detailPath}?id=${encodeURIComponent(talkId)}`;
  }

  function getFeaturedTalkIdsForPaper(indexPayload, paper) {
    const targetId = String(paper && paper.id || '').trim();
    if (!targetId || !indexPayload || typeof indexPayload !== 'object') return [];

    const talks = indexPayload.talks;
    if (!talks || typeof talks !== 'object') return [];

    const ids = [];
    for (const [talkId, entry] of Object.entries(talks)) {
      if (!talkId || !entry || typeof entry !== 'object') continue;
      const slidePaperIds = Array.isArray(entry.slidePaperIds)
        ? entry.slidePaperIds.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
      if (slidePaperIds.includes(targetId)) ids.push(String(talkId).trim());
    }
    return [...new Set(ids.filter(Boolean))];
  }

  async function loadFeaturedTalksById(talkIds) {
    const ids = Array.isArray(talkIds)
      ? [...new Set(talkIds.map((value) => String(value || '').trim()).filter(Boolean))]
      : [];
    if (!ids.length) return [];

    const talks = await Promise.all(ids.map(async (talkId) => {
      try {
        const loader = isMlirTalkId(talkId)
          ? window.loadMLIRTalkRecordById
          : window.loadTalkRecordById;
        if (typeof loader !== 'function') return null;
        const payload = await loader(talkId);
        if (!payload || typeof payload !== 'object') return null;
        const normalized = normalizeTalks([payload.talk]);
        return normalized.length ? normalized[0] : null;
      } catch {
        return null;
      }
    }));

    return talks
      .filter(Boolean)
      .sort((a, b) => {
        const idDiff = String(b && b.id || '').localeCompare(String(a && a.id || ''));
        if (idDiff !== 0) return idDiff;
        return String(a && a.title || '').localeCompare(String(b && b.title || ''));
      });
  }

  function renderFeaturedTalkSpeakers(talk, paper) {
    const speakers = Array.isArray(talk && talk.speakers)
      ? talk.speakers.map((speaker) => String(speaker && speaker.name || '').trim()).filter(Boolean)
      : [];
    if (!speakers.length) return '';

    return `
      <p class="paper-talk-speakers">
        ${speakers.map((name) =>
          `<a href="${buildSpeakerWorkUrl(name, paper)}" class="paper-talk-speaker-link" aria-label="View talks and papers by ${escapeHtml(name)}">${escapeHtml(name)}</a>`
        ).join('<span class="speaker-btn-sep">, </span>')}
      </p>`;
  }

  function buildFeaturedTalkActions(talk) {
    const title = String(talk && talk.title || '').trim() || 'this talk';
    const titleEsc = escapeHtml(title);
    const talkUrl = buildTalkDetailUrl(talk);
    const slidesUrl = sanitizeExternalUrl(talk && talk.slidesUrl || '');
    const videoUrl = sanitizeExternalUrl(talk && talk.videoUrl || '');
    const sourceUrl = sanitizeExternalUrl(talk && talk.sourceUrl || '');
    const primaryDocLabel = String(talk && talk.category || '').trim().toLowerCase() === 'poster'
      ? 'Poster'
      : 'Slides';

    const actions = [
      `<a href="${escapeHtml(talkUrl)}" class="link-btn" aria-label="Open talk page for ${titleEsc}">Talk</a>`,
    ];
    if (slidesUrl) {
      actions.push(`<a href="${escapeHtml(slidesUrl)}" class="link-btn" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHtml(primaryDocLabel.toLowerCase())} for ${titleEsc} (opens in new tab)">${escapeHtml(primaryDocLabel)}</a>`);
    }
    if (videoUrl) {
      actions.push(`<a href="${escapeHtml(videoUrl)}" class="link-btn" target="_blank" rel="noopener noreferrer" aria-label="Watch video for ${titleEsc} (opens in new tab)">Video</a>`);
    }
    if (sourceUrl) {
      actions.push(`<a href="${escapeHtml(sourceUrl)}" class="link-btn" target="_blank" rel="noopener noreferrer" aria-label="Open source listing for ${titleEsc} (opens in new tab)">Source</a>`);
    }
    return actions.join('');
  }

  function renderFeaturedTalkEntry(talk, paper) {
    const title = String(talk && talk.title || '').trim();
    const talkUrl = buildTalkDetailUrl(talk);
    const meetingCode = String(talk && talk.meeting || '').trim();
    const meetingDate = formatMeetingDate(talk && talk.meetingDate || '');
    const meetingLocation = String(talk && talk.meetingLocation || '').trim();
    const meetingName = String(talk && talk.meetingName || '').trim();
    const meetingSummary = [meetingName, [meetingDate, meetingLocation].filter(Boolean).join(' · ')]
      .filter(Boolean)
      .join(' · ');

    return `
      <li class="paper-talk-list-item">
        <div class="paper-talk-title-row">
          <a href="${escapeHtml(talkUrl)}" class="paper-talk-link">${escapeHtml(title)}</a>
          ${meetingCode ? `<span class="paper-talk-meeting">${escapeHtml(meetingCode)}</span>` : ''}
        </div>
        ${meetingSummary ? `<p class="paper-talk-meeting-details">${escapeHtml(meetingSummary)}</p>` : ''}
        ${renderFeaturedTalkSpeakers(talk, paper)}
        <div class="paper-talk-meta-row">
          <div class="paper-talk-reason-list">
            <span class="detail-tag detail-tag--meta">Mentioned in slides</span>
          </div>
        </div>
        <div class="paper-talk-actions">
          ${buildFeaturedTalkActions(talk)}
        </div>
      </li>`;
  }

  async function populateFeaturedTalks(paper) {
    const section = document.getElementById('paper-featured-talks-section');
    if (!section) return;
    const relatedContext = arguments[1] && typeof arguments[1] === 'object' ? arguments[1] : null;

    if (
      !paper
      || isBlogPaper(paper)
      || (typeof window.loadTalkRecordById !== 'function' && typeof window.loadMLIRTalkRecordById !== 'function')
    ) {
      section.remove();
      return;
    }

    if (relatedContext) {
      const talks = Array.isArray(relatedContext.featuredTalks) ? relatedContext.featuredTalks : [];
      if (talks.length) {
        section.innerHTML = `
          <div class="section-label" aria-hidden="true">Featured Talks</div>
          <ul class="paper-talk-list">
            ${talks.map((talk) => renderFeaturedTalkEntry(talk, paper)).join('')}
          </ul>`;
        section.setAttribute('aria-busy', 'false');
        return;
      }
      if (Array.isArray(relatedContext.featuredTalkIds) && !relatedContext.featuredTalkIds.length) {
        section.remove();
        return;
      }
    }

    try {
      const indexPayload = await loadTalkPaperLinkIndex();
      const talkIds = getFeaturedTalkIdsForPaper(indexPayload, paper);
      if (!talkIds.length) {
        section.remove();
        return;
      }

      const talks = await loadFeaturedTalksById(talkIds);
      if (!talks.length) {
        section.remove();
        return;
      }

      section.innerHTML = `
        <div class="section-label" aria-hidden="true">Featured Talks</div>
        <ul class="paper-talk-list">
          ${talks.map((talk) => renderFeaturedTalkEntry(talk, paper)).join('')}
        </ul>`;
      section.setAttribute('aria-busy', 'false');
    } catch {
      section.remove();
    }
  }

  function renderRelatedCard(paper) {
    const blogEntry = isBlogPaper(paper);
    const listingPath = getListingPathForPaper(paper);
    const label = `${String(paper.title || '').trim()}${paper.authors && paper.authors.length ? ` by ${paper.authors.map((author) => author.name).join(', ')}` : ''}`;
    const dateOrYear = blogEntry
      ? String(paper._publishedDateLabel || paper._year || 'Unknown date')
      : String(paper._year || 'Unknown year');

    return `
      <article class="talk-card paper-card">
        <a href="papers/paper.html?id=${encodeURIComponent(String(paper.id || '').trim())}&from=${blogEntry ? 'blogs' : 'papers'}" class="card-link-wrap" aria-label="${escapeHtml(label)}">
          <div class="card-body">
            <div class="card-meta">
              <span class="badge ${blogEntry ? 'badge-blog' : 'badge-paper'}">${blogEntry ? 'Blog' : 'Paper'}</span>
              <span class="meeting-label">${escapeHtml(dateOrYear)}</span>
            </div>
            <p class="card-title">${escapeHtml(String(paper.title || '').trim())}</p>
          </div>
        </a>
        ${(paper.authors || []).length
          ? `<p class="card-speakers">${paper.authors.map((author) =>
              `<a href="${buildSpeakerWorkUrl(author.name, paper)}" class="card-speaker-link" aria-label="View talks and papers by ${escapeHtml(author.name)}">${escapeHtml(author.name)}</a>`
            ).join('<span class="speaker-btn-sep">, </span>')}</p>`
          : ''}
        ${getPaperTopics(paper, 8).length
          ? `<div class="card-tags-wrap"><div class="card-tags" aria-label="Key Topics">${getPaperTopics(paper, 8).slice(0, 4).map((topic) =>
              `<a href="${listingPath}?tag=${encodeURIComponent(topic)}" class="card-tag" aria-label="Browse ${getListingLabelForPaper(paper)} for key topic ${escapeHtml(topic)}">${escapeHtml(topic)}</a>`
            ).join('')}</div></div>`
          : ''}
      </article>`;
  }

  function renderNotFound(id, listingContext) {
    const root = document.getElementById('paper-detail-root');
    if (!root) return;
    const context = listingContext && typeof listingContext === 'object'
      ? listingContext
      : { path: PAPERS_PAGE_PATH, label: 'papers', title: 'All Papers' };
    root.innerHTML = `
      <div class="talk-detail">
        <a href="${context.path}" class="back-btn" aria-label="Back to ${context.label}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
          <span aria-hidden="true">${context.title}</span>
        </a>
        <div class="empty-state">
          <div class="empty-state-icon" aria-hidden="true">!</div>
          <h2>Paper not found</h2>
          <p>No paper found with ID <code>${escapeHtml(id || '(none)')}</code>.</p>
        </div>
      </div>`;
  }

  function renderLoadError() {
    const root = document.getElementById('paper-detail-root');
    if (!root) return;
    root.innerHTML = `
      <div class="talk-detail">
        <div class="empty-state" role="alert">
          <div class="empty-state-icon" aria-hidden="true">!</div>
          <h2>Could not load data</h2>
          <p>Ensure <code>papers/index.json</code> and <code>papers/*.json</code> are available and that <code>js/papers-data.js</code> loads first.</p>
        </div>
      </div>`;
  }

  function renderPaperDetail(paper, relatedPool) {
    const root = document.getElementById('paper-detail-root');
    if (!root) return;
    const relatedContext = arguments[2] && typeof arguments[2] === 'object' ? arguments[2] : null;

    const blogEntry = isBlogPaper(paper);
    const listingContext = getListingContextForPaper(paper);
    const listingPath = listingContext.path;
    const listingLabel = listingContext.label;

    const infoParts = [];
    if (blogEntry && paper._publishedDateLabel) infoParts.push(paper._publishedDateLabel);
    else if (paper._year) infoParts.push(paper._year);
    if (paper.publication) infoParts.push(paper.publication);
    if (paper.venue && paper.venue !== paper.publication) infoParts.push(paper.venue);

    const links = [];
    if (paper.paperUrl) {
      links.push(`<a href="${escapeHtml(paper.paperUrl)}" class="link-btn" target="_blank" rel="noopener noreferrer">${blogEntry ? 'Open Repository Post' : 'Open Paper'}</a>`);
    }
    if (paper.sourceUrl && paper.sourceUrl !== paper.paperUrl) {
      links.push(`<a href="${escapeHtml(paper.sourceUrl)}" class="link-btn" target="_blank" rel="noopener noreferrer">${blogEntry ? 'Open Blog' : 'Source Listing'}</a>`);
    }
    const doiHref = sanitizeExternalUrl(doiUrlFromValue(paper.doi));
    if (doiHref) {
      links.push(`<a href="${escapeHtml(doiHref)}" class="link-btn" target="_blank" rel="noopener noreferrer">DOI</a>`);
    }
    if (paper.openalexId) {
      links.push(`<a href="${escapeHtml(paper.openalexId)}" class="link-btn" target="_blank" rel="noopener noreferrer">OpenAlex</a>`);
    }

    const topics = getPaperTopics(paper, 18);
    const topicsHtml = topics.length
      ? `<section class="tags-section" aria-label="Key Topics">
          <div class="section-label" aria-hidden="true">Key Topics</div>
          <div class="detail-tags">
            ${topics.map((topic) =>
              `<a href="${listingPath}?tag=${encodeURIComponent(topic)}" class="detail-tag" aria-label="Browse ${listingLabel} for key topic ${escapeHtml(topic)}">${escapeHtml(topic)}</a>`
            ).join('')}
          </div>
        </section>`
      : '';

    const related = Array.isArray(relatedContext && relatedContext.relatedPapers) && relatedContext.relatedPapers.length
      ? relatedContext.relatedPapers
      : getRelatedPapers(paper, relatedPool);

    root.innerHTML = `
      <div class="talk-detail">
        <a href="${listingPath}" class="back-btn" id="back-btn" aria-label="Back to all ${listingLabel}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
          <span aria-hidden="true">${escapeHtml(listingContext.title)}</span>
        </a>

        <div class="talk-header">
          <div class="talk-header-meta">
            <span class="badge ${blogEntry ? 'badge-blog' : 'badge-paper'}">${blogEntry ? 'Blog' : 'Paper'}</span>
            ${infoParts.length ? `<span class="meeting-info-badge">${escapeHtml(infoParts.join(' · '))}</span>` : ''}
          </div>
          <h1 class="talk-title">${escapeHtml(paper.title)}</h1>
        </div>

        <section class="speakers-section" aria-label="Authors">
          <div class="section-label" aria-hidden="true">Authors</div>
          <div class="speakers-list">${renderAuthors(paper.authors, paper)}</div>
        </section>

        ${links.length ? `<div class="links-bar" aria-label="Resources">${links.join('')}</div>` : ''}

        <section class="abstract-section" aria-label="${blogEntry ? 'Blog post content' : 'Abstract'}">
          <div class="section-label" aria-hidden="true">${blogEntry ? 'Article' : 'Abstract'}</div>
          <div class="abstract-body${blogEntry ? ' blog-content' : ''}">
            ${blogEntry ? renderBlogContent(paper) : renderAbstract(paper.abstract)}
          </div>
        </section>

        ${!blogEntry ? `
        <section class="paper-talk-links-section" id="paper-featured-talks-section" aria-label="Featured talks" aria-busy="true">
          <div class="section-label" aria-hidden="true">Featured Talks</div>
          <p class="paper-talk-links-loading">Loading talks that reference this paper…</p>
        </section>` : ''}

        ${topicsHtml}
      </div>

      ${related.length ? `
      <section class="related-section" aria-label="Related ${blogEntry ? 'content' : 'papers'}">
        <h2>${blogEntry ? 'Related Content' : 'Related Papers'}</h2>
        <div class="related-grid">
          ${related.map((item) => renderRelatedCard(item)).join('')}
        </div>
      </section>` : ''}`;

    const backBtn = document.getElementById('back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', (event) => {
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
    const paperId = String(params.get('id') || '').trim();
    const fallbackListingContext = fallbackListingContextFromUrl();

    setIssueContext({
      pageType: 'Paper',
      itemType: fallbackListingContext.itemType,
      itemId: paperId,
    });

    if (!paperId) {
      renderNotFound(null, fallbackListingContext);
      setIssueContext({
        itemTitle: `Missing ${fallbackListingContext.itemType.toLowerCase()} ID`,
        issueTitle: `[${fallbackListingContext.itemType}] Missing ${fallbackListingContext.itemType.toLowerCase()} ID`,
      });
      initShareMenu();
      return;
    }

    const migratedTalkId = PAPER_TO_TALK_REDIRECTS[paperId];
    if (migratedTalkId) {
      window.location.replace(`../talks/talk.html?id=${encodeURIComponent(migratedTalkId)}`);
      return;
    }

    const context = await loadPaperDetailContextById(paperId);
    if (!context || context.loaded !== true) {
      renderLoadError();
      initShareMenu();
      return;
    }

    const paper = context.paper;
    if (!paper) {
      renderNotFound(paperId, fallbackListingContext);
      const typeLabel = fallbackListingContext.itemType;
      setIssueContext({
        itemTitle: `Unknown ${typeLabel.toLowerCase()} ID: ${paperId}`,
        issueTitle: `[${typeLabel}] Unknown ${typeLabel.toLowerCase()} ID: ${paperId}`,
      });
      initShareMenu();
      return;
    }

    document.title = `${paper.title} — LLVM Research Library`;
    updateSeo(paper);
    renderPaperDetail(paper, context.relatedPool, context.related);
    void populateFeaturedTalks(paper, context.related);
    setIssueContextForPaper(paper);
    initShareMenu();
  }

  init();
})();
