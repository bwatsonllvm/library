/**
 * talk.js - talk detail runtime with related paper linking.
 */

(function () {
  const HubUtils = window.LLVMHubUtils || {};
  const TalkPageConfig = window.LLVMTalkPageConfig && typeof window.LLVMTalkPageConfig === 'object'
    ? window.LLVMTalkPageConfig
    : {};
  const PageShell = typeof HubUtils.createPageShell === 'function'
    ? HubUtils.createPageShell()
    : null;

  const initTheme = PageShell ? () => PageShell.initTheme() : () => {};
  const initTextSize = PageShell ? () => PageShell.initTextSize() : () => {};
  const initCustomizationMenu = PageShell ? () => PageShell.initCustomizationMenu() : () => {};
  const initMobileNavMenu = PageShell ? () => PageShell.initMobileNavMenu() : () => {};
  const initShareMenu = PageShell ? () => PageShell.initShareMenu() : () => {};
  const safeSessionGet = PageShell ? PageShell.safeSessionGet : () => null;

  const TALK_PAPER_LINKS_PATH = String(TalkPageConfig.referenceIndexPath || 'js/data/talk-paper-links.json').trim() || 'js/data/talk-paper-links.json';
  const TALK_LISTING_PATH = String(TalkPageConfig.listingPath || 'talks/').trim() || 'talks/';
  const TALK_LISTING_LABEL = String(TalkPageConfig.listingLabel || 'All Talks').trim() || 'All Talks';
  const TALK_DETAIL_PATH = String(TalkPageConfig.detailPath || 'talks/talk.html').trim() || 'talks/talk.html';
  const TALK_DATA_HINT_HTML = String(
    TalkPageConfig.dataHintHtml
    || 'Ensure <code>devmtg/events/index.json</code> and <code>devmtg/events/*.json</code> are available and that <code>js/events-data.js</code> loads first.'
  ).trim();
  const BLOG_SOURCE_SLUGS = new Set(['llvm-blog-www', 'llvm-www-blog']);
  const DIRECT_PDF_URL_RE = /\.pdf(?:$|[?#])|\/pdf(?:$|[/?#])|[?&](?:format|type|output)=pdf(?:$|[&#])|[?&]filename=[^&#]*\.pdf(?:$|[&#])/i;
  const MATCH_STOPWORDS = new Set([
    'about', 'after', 'against', 'algorithm', 'algorithms', 'among', 'analysis', 'approach',
    'approaches', 'around', 'based', 'being', 'between', 'beyond', 'compiler', 'compilers',
    'design', 'details', 'during', 'each', 'from', 'have', 'into', 'llvm', 'more', 'most',
    'other', 'over', 'part', 'parts', 'paper', 'papers', 'program', 'programs', 'research',
    'results', 'same', 'show', 'shows', 'some', 'study', 'system', 'systems', 'talk', 'their',
    'these', 'this', 'through', 'using', 'with', 'within', 'work',
  ]);

  let talkPaperLinkIndexPromise = null;

  function normalizeTalks(rawTalks) {
    if (typeof HubUtils.normalizeTalks === 'function') return HubUtils.normalizeTalks(rawTalks);
    return Array.isArray(rawTalks) ? rawTalks : [];
  }

  function getTalkTopics(talk, limit = Infinity) {
    if (typeof HubUtils.getTalkKeyTopics === 'function') {
      return HubUtils.getTalkKeyTopics(talk, limit);
    }
    const tags = Array.isArray(talk && talk.tags) ? talk.tags : [];
    return Number.isFinite(limit) ? tags.slice(0, Math.max(0, Math.floor(limit))) : tags;
  }

  function getPaperTopics(paper, limit = Infinity) {
    if (typeof HubUtils.getPaperKeyTopics === 'function') {
      return HubUtils.getPaperKeyTopics(paper, limit);
    }
    const values = [
      ...(Array.isArray(paper && paper.tags) ? paper.tags : []),
      ...(Array.isArray(paper && paper.keywords) ? paper.keywords : []),
      ...(Array.isArray(paper && paper.matchedSubprojects) ? paper.matchedSubprojects : []),
    ];
    const deduped = [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
    return Number.isFinite(limit) ? deduped.slice(0, Math.max(0, Math.floor(limit))) : deduped;
  }

  function formatMeetingDate(value) {
    if (typeof HubUtils.formatMeetingDateUniversal === 'function') {
      return HubUtils.formatMeetingDateUniversal(value);
    }
    return String(value || '').trim();
  }

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

  function stripDiacritics(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function normalizeMatchText(value) {
    return collapseWhitespace(
      stripDiacritics(String(value || '').toLowerCase())
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
    );
  }

  function tokenizeImportantWords(value) {
    return [...new Set(
      normalizeMatchText(value)
        .split(' ')
        .filter((token) => token.length >= 4 && !MATCH_STOPWORDS.has(token))
    )];
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

  function looksLikeTruncatedReferenceSegment(value) {
    const text = collapseWhitespace(value);
    if (!text) return true;
    return ['-', '_', '.'].includes(text[text.length - 1]);
  }

  function buildTalkDetailUrl(talk) {
    const explicit = sanitizeExternalUrl(talk && talk.detailUrl);
    if (explicit) return explicit;
    return `${TALK_DETAIL_PATH}?id=${encodeURIComponent(String(talk && talk.id || '').trim())}`;
  }

  function buildEmbeddedVideoUrl(videoUrl) {
    const normalized = sanitizeExternalUrl(videoUrl);
    if (!normalized) return '';
    const youtubeId = typeof HubUtils.extractYouTubeId === 'function'
      ? HubUtils.extractYouTubeId(normalized)
      : '';
    return youtubeId ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeId)}?rel=0` : '';
  }

  function normalizeTalkResourceActions(talk) {
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

  function parseGitHubReference(value) {
    const href = sanitizeExternalUrl(value);
    if (!href) return null;

    try {
      const parsed = new URL(href);
      const host = String(parsed.hostname || '').toLowerCase().replace(/^www\./, '');
      if (host !== 'github.com') return null;

      const parts = parsed.pathname
        .split('/')
        .map((part) => collapseWhitespace(decodeURIComponent(part)))
        .filter(Boolean);
      if (parts.length < 2) return null;

      const owner = parts[0];
      const repo = parts[1].replace(/\.git$/i, '');
      if (!owner || !repo) return null;
      if (looksLikeTruncatedReferenceSegment(owner) || looksLikeTruncatedReferenceSegment(repo)) {
        return null;
      }

      const resource = String(parts[2] || '').toLowerCase();
      let kind = 'github-repo';
      let fileName = '';
      let filePath = '';
      let referencePath = '';

      if ((resource === 'blob' || resource === 'raw') && parts.length >= 5) {
        kind = 'github-file';
        filePath = parts.slice(4).join('/');
        fileName = parts[parts.length - 1];
        referencePath = filePath;
      } else if (resource === 'tree' && parts.length >= 4) {
        kind = 'github-tree';
        filePath = parts.slice(4).join('/');
        fileName = filePath ? parts[parts.length - 1] : '';
        referencePath = filePath || parts[3];
      } else if (parts.length > 2) {
        kind = ({
          issues: 'github-issue',
          pull: 'github-pull',
          pulls: 'github-pull',
          discussions: 'github-discussion',
          commit: 'github-commit',
          commits: 'github-commit',
          compare: 'github-compare',
          releases: 'github-release',
          wiki: 'github-wiki',
        }[resource]) || 'github-resource';
        referencePath = parts.slice(2).join('/');
      }

      if (kind === 'github-issue' || kind === 'github-pull' || kind === 'github-discussion') {
        if (parts.length < 4 || !/^\d+$/.test(parts[3])) return null;
      } else if (kind === 'github-commit') {
        if (parts.length < 4 || !/^[0-9a-f]{7,40}$/i.test(parts[3])) return null;
      } else if (looksLikeTruncatedReferenceSegment(parts[parts.length - 1])) {
        return null;
      }

      return {
        url: parsed.toString(),
        host: 'github.com',
        kind,
        owner,
        library: repo,
        repository: `${owner}/${repo}`,
        fileName,
        filePath,
        referencePath,
        label: '',
        context: '',
        source: '',
      };
    } catch {
      return null;
    }
  }

  function parseDiscourseReference(value) {
    const href = sanitizeExternalUrl(value);
    if (!href) return null;

    try {
      const parsed = new URL(href);
      const host = String(parsed.hostname || '').toLowerCase().replace(/^www\./, '');
      if (host !== 'discourse.llvm.org') return null;

      const parts = parsed.pathname
        .split('/')
        .map((part) => collapseWhitespace(decodeURIComponent(part)))
        .filter(Boolean);
      if (!parts.length) return null;

      const head = parts[0];
      let kind = '';
      if (head === 't') {
        const hasTopicId = (parts.length >= 2 && /^\d+$/.test(parts[1])) || (parts.length >= 3 && /^\d+$/.test(parts[2]));
        if (!hasTopicId) return null;
        if (parts.length >= 2 && !/^\d+$/.test(parts[1]) && looksLikeTruncatedReferenceSegment(parts[1])) {
          return null;
        }
        kind = 'discourse-topic';
      } else if (head === 'c') {
        if (parts.length < 2) return null;
        if (parts.slice(1).some((part) => looksLikeTruncatedReferenceSegment(part))) return null;
        kind = 'discourse-category';
      } else {
        return null;
      }

      return {
        url: `${parsed.origin}${parsed.pathname}`,
        host: 'discourse.llvm.org',
        kind,
        referencePath: parts.join('/'),
        label: '',
        context: '',
        source: '',
      };
    } catch {
      return null;
    }
  }

  function parseLlvmReviewReference(value) {
    const href = sanitizeExternalUrl(value);
    if (!href) return null;

    try {
      const parsed = new URL(href);
      const host = String(parsed.hostname || '').toLowerCase().replace(/^www\./, '');
      if (host !== 'reviews.llvm.org') return null;
      const parts = parsed.pathname
        .split('/')
        .map((part) => collapseWhitespace(decodeURIComponent(part)))
        .filter(Boolean);
      if (!parts.length) return null;
      return {
        url: `${parsed.origin}${parsed.pathname}`,
        host: 'reviews.llvm.org',
        kind: 'llvm-review',
        referencePath: parts.join('/'),
        label: '',
        context: '',
        source: '',
      };
    } catch {
      return null;
    }
  }

  function parseReferenceItem(value) {
    return parseGitHubReference(value) || parseDiscourseReference(value) || parseLlvmReviewReference(value);
  }

  function normalizeReferenceItem(item) {
    const rawUrl = item && typeof item === 'object' ? item.url : item;
    const parsed = parseReferenceItem(rawUrl);
    if (!parsed) return null;
    const library = collapseWhitespace(item && item.library) || parsed.library || '';
    const repository = collapseWhitespace(item && item.repository) || parsed.repository || '';
    return {
      ...parsed,
      library,
      repository,
      host: collapseWhitespace(item && item.host) || parsed.host || '',
      kind: collapseWhitespace(item && item.kind).toLowerCase() || parsed.kind || '',
      label: collapseWhitespace(item && item.label),
      context: collapseWhitespace(item && item.context),
      source: collapseWhitespace(item && item.source),
      fileName: collapseWhitespace(item && item.fileName) || parsed.fileName || '',
      filePath: collapseWhitespace(item && item.filePath) || parsed.filePath || '',
      referencePath: collapseWhitespace(item && item.referencePath) || parsed.referencePath || '',
    };
  }

  function normalizeReferenceItems(entry) {
    const rawItems = Array.isArray(entry && entry.referenceItems)
      ? entry.referenceItems
      : (Array.isArray(entry && entry.githubReferences) ? entry.githubReferences : []);
    const out = [];
    const seen = new Set();

    for (const rawItem of rawItems) {
      const item = normalizeReferenceItem(rawItem);
      if (!item || seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
    }
    return out;
  }

  function isUsefulReferenceText(value) {
    const text = collapseWhitespace(value);
    if (!text) return false;
    if (text.length > 96) return false;
    if (text.split(/\s+/).filter(Boolean).length > 12) return false;
    if (/[A-Za-z0-9]{20,}/.test(text)) return false;
    if (/\[\d+\]/.test(text)) return false;
    if (/github|discourse|reviews\.llvm|https?:\/\/|\/blob\/|\/tree\//i.test(text)) return false;
    if (/\b\d{4}\.\d{4,6}\b/.test(text)) return false;
    if (/\b(?:upstreaming|white paper)\b/i.test(text)) return false;
    return true;
  }

  function humanizeSlug(value) {
    return collapseWhitespace(String(value || '').replace(/[-_]+/g, ' '));
  }

  function describeReferenceKind(ref) {
    const kind = collapseWhitespace(ref && ref.kind).toLowerCase();
    if (kind === 'github-repo') return 'GitHub repo';
    if (kind === 'github-issue') return 'GitHub issue';
    if (kind === 'github-pull') return 'GitHub pull request';
    if (kind === 'github-discussion') return 'GitHub discussion';
    if (kind === 'github-file') return 'GitHub file';
    if (kind === 'github-tree') return 'GitHub tree';
    if (kind === 'github-commit') return 'GitHub commit';
    if (kind === 'github-compare') return 'GitHub compare';
    if (kind === 'github-release') return 'GitHub release';
    if (kind === 'github-wiki') return 'GitHub wiki';
    if (kind === 'discourse-topic') return 'LLVM Discourse topic';
    if (kind === 'discourse-category') return 'LLVM Discourse category';
    if (kind === 'llvm-review') return 'LLVM review';
    return 'Reference';
  }

  function primaryGithubLabel(ref) {
    const kind = collapseWhitespace(ref && ref.kind).toLowerCase();
    if (kind === 'github-issue') return 'GitHub Issue';
    if (kind === 'github-pull') return 'GitHub PR';
    if (kind === 'github-discussion') return 'GitHub Discussion';
    if (kind === 'github-file') return 'GitHub File';
    if (kind === 'github-tree') return 'GitHub Tree';
    if (kind === 'github-commit') return 'GitHub Commit';
    if (kind === 'github-compare') return 'GitHub Compare';
    if (kind === 'github-release') return 'GitHub Release';
    if (kind === 'github-wiki') return 'GitHub Wiki';
    return 'GitHub';
  }

  function buildReferenceFallbackTitle(ref) {
    if (!ref || typeof ref !== 'object') return '';
    if (ref.kind === 'github-issue') {
      const match = String(ref.referencePath || '').match(/issues\/(\d+)/i);
      return `${ref.repository || ref.library || 'GitHub'} issue${match ? ` #${match[1]}` : ''}`;
    }
    if (ref.kind === 'github-pull') {
      const match = String(ref.referencePath || '').match(/pulls?\/(\d+)/i);
      return `${ref.repository || ref.library || 'GitHub'} PR${match ? ` #${match[1]}` : ''}`;
    }
    if (ref.kind === 'github-discussion') {
      const match = String(ref.referencePath || '').match(/discussions\/(\d+)/i);
      return `${ref.repository || ref.library || 'GitHub'} discussion${match ? ` #${match[1]}` : ''}`;
    }
    if (ref.kind === 'github-file') {
      return ref.fileName ? `${ref.repository || ref.library || 'GitHub'} / ${ref.fileName}` : (ref.repository || ref.url);
    }
    if (ref.kind === 'github-repo') {
      return ref.repository || ref.library || ref.url;
    }
    if (ref.kind === 'llvm-review') {
      const reviewId = String(ref.referencePath || '').split('/').filter(Boolean)[0] || 'Review';
      return `LLVM Review ${reviewId}`;
    }
    if (ref.kind === 'discourse-topic') {
      const parts = String(ref.referencePath || '').split('/').filter(Boolean);
      return humanizeSlug(parts[1] || 'LLVM Discourse Topic') || 'LLVM Discourse Topic';
    }
    if (ref.kind === 'discourse-category') {
      const parts = String(ref.referencePath || '').split('/').filter(Boolean);
      return humanizeSlug(parts.slice(1, -1).join(' / ')) || 'LLVM Discourse Category';
    }
    return ref.repository || ref.library || ref.url;
  }

  function renderReferenceItems(referenceEntry) {
    const refs = normalizeReferenceItems(referenceEntry);
    if (!refs.length) return '';

    return `
      <section class="talk-github-links-section" aria-label="Referenced links">
        <div class="section-label" aria-hidden="true">Referenced Links</div>
        <ul class="talk-github-reference-list">
          ${refs.map((ref) => {
            const title = (isUsefulReferenceText(ref.label) ? ref.label : '')
              || (isUsefulReferenceText(ref.context) ? ref.context : '')
              || buildReferenceFallbackTitle(ref);
            const description = isUsefulReferenceText(ref.context) && ref.context !== title ? ref.context : '';
            const metaBits = [];
            metaBits.push(`Type: ${describeReferenceKind(ref)}`);
            if (ref.library) metaBits.push(`Library: ${ref.library}`);
            if (ref.repository) metaBits.push(`Repository: ${ref.repository}`);
            if (ref.fileName) {
              metaBits.push(`File: ${ref.fileName}`);
            } else if (ref.referencePath) {
              metaBits.push(`Reference: ${ref.referencePath}`);
            }
            if (ref.filePath && ref.filePath !== ref.fileName) {
              metaBits.push(`Path: ${ref.filePath}`);
            }
            if (ref.host && ref.host !== 'github.com') {
              metaBits.push(`Host: ${ref.host}`);
            }
            if (ref.source) {
              metaBits.push(`Source: ${ref.source === 'slides' ? 'Slides' : 'Abstract'}`);
            }
            return `
              <li class="talk-github-reference-item">
                <a href="${escapeHtml(ref.url)}" class="talk-github-reference-link" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>
                ${description ? `<p class="talk-github-reference-description">${escapeHtml(description)}</p>` : ''}
                <p class="talk-github-reference-meta">${escapeHtml(metaBits.join(' · '))}</p>
              </li>`;
          }).join('')}
        </ul>
      </section>`;
  }

  function buildResourceLinks(talk) {
    const resourceActions = normalizeTalkResourceActions(talk);
    const videoUrl = sanitizeExternalUrl(talk && talk.videoUrl);
    const slidesUrl = sanitizeExternalUrl(talk && talk.slidesUrl);
    const posterUrl = sanitizeExternalUrl(talk && talk.posterUrl);
    const sourceUrl = sanitizeExternalUrl(talk && talk.sourceUrl);
    const links = [];
    const seenUrls = new Set();

    function pushLink(url, label) {
      const href = sanitizeExternalUrl(url);
      const text = String(label || '').trim();
      if (!href || !text || seenUrls.has(href)) return;
      seenUrls.add(href);
      links.push(`<a href="${escapeHtml(href)}" class="link-btn" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`);
    }

    const githubCandidates = [];
    const seenGithubUrls = new Set();
    const addGithubCandidate = (value) => {
      const ref = parseGitHubReference(value);
      if (!ref || seenGithubUrls.has(ref.url)) return;
      seenGithubUrls.add(ref.url);
      githubCandidates.push(ref);
    };

    addGithubCandidate(talk && talk.projectGithub);
    for (const action of resourceActions) {
      if (String(action && action.kind || '').trim().toLowerCase() !== 'github') continue;
      addGithubCandidate(action.url);
    }

    const primaryGithubRef = githubCandidates.find((ref) => ref.kind !== 'github-repo') || githubCandidates[0] || null;

    if (videoUrl) pushLink(videoUrl, 'Watch Video');
    if (posterUrl && posterUrl !== slidesUrl) pushLink(posterUrl, 'View Poster');
    if (primaryGithubRef && primaryGithubRef.url) pushLink(primaryGithubRef.url, primaryGithubLabel(primaryGithubRef));
    if (sourceUrl) pushLink(sourceUrl, 'Source Listing');

    for (const action of resourceActions) {
      const kind = String(action && action.kind || '').trim().toLowerCase();
      if (!action.url || kind === 'primary') continue;
      if (kind === 'github') {
        if (primaryGithubRef && sanitizeExternalUrl(action.url) === primaryGithubRef.url) continue;
        continue;
      }
      let label = String(action.label || '').trim();
      if (!label) {
        if (kind === 'slides') label = 'Slides';
        else if (kind === 'recording') label = 'Recording';
        else if (kind === 'event') label = 'Event';
        else if (kind === 'transcript') label = 'Transcript';
        else label = 'Link';
      }
      pushLink(action.url, label);
    }

    return links;
  }

  function buildPrimarySlidesLink(talk) {
    const slidesUrl = sanitizeExternalUrl(talk && talk.slidesUrl);
    if (!slidesUrl) return '';
    const label = String(talk && talk.category || '').trim().toLowerCase() === 'poster'
      ? 'View Poster'
      : 'View Slides';
    return `<a href="${escapeHtml(slidesUrl)}" class="link-btn" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  }

  function normalizePeople(rawPeople) {
    const values = Array.isArray(rawPeople) ? rawPeople : [];
    return values.map((rawPerson) => {
      if (typeof HubUtils.normalizePersonRecord === 'function') {
        const normalized = HubUtils.normalizePersonRecord(rawPerson);
        if (!normalized || !normalized.name) return null;
        return {
          name: String(normalized.name || '').trim(),
          affiliation: String(normalized.affiliation || '').trim(),
        };
      }
      if (!rawPerson || typeof rawPerson !== 'object') return null;
      const name = String(rawPerson.name || '').trim();
      if (!name) return null;
      return {
        name,
        affiliation: String(rawPerson.affiliation || '').trim(),
      };
    }).filter(Boolean);
  }

  function extractDoi(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const match = raw.match(/10\.\d{4,9}\/[\w.()\-;/:%+]+/i);
    return match ? String(match[0]).trim().toLowerCase() : '';
  }

  function doiUrlFromValue(doi) {
    const normalized = extractDoi(doi);
    return normalized ? `https://doi.org/${normalized}` : '';
  }

  function normalizeOpenAlexId(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return sanitizeExternalUrl(raw);
    const cleaned = raw.replace(/^https?:\/\/openalex\.org\//i, '').replace(/^works\//i, '').trim();
    if (!/^W\d+$/i.test(cleaned)) return '';
    return `https://openalex.org/${cleaned.toUpperCase()}`;
  }

  function isDirectPdfUrl(value) {
    return DIRECT_PDF_URL_RE.test(String(value || '').trim());
  }

  function normalizePaperRecord(rawPaper) {
    if (!rawPaper || typeof rawPaper !== 'object') return null;

    const paper = { ...rawPaper };
    paper.id = String(paper.id || '').trim();
    paper.title = String(paper.title || '').trim();
    paper.abstract = String(paper.abstract || '').trim();
    paper.year = String(paper.year || '').trim();
    paper.source = String(paper.source || '').trim();
    paper.type = String(paper.type || '').trim();
    paper.paperUrl = sanitizeExternalUrl(paper.paperUrl || '');
    paper.sourceUrl = sanitizeExternalUrl(paper.sourceUrl || '');
    paper.authors = normalizePeople(paper.authors);
    paper.tags = Array.isArray(paper.tags) ? paper.tags.map((value) => String(value || '').trim()).filter(Boolean) : [];
    paper.keywords = Array.isArray(paper.keywords) ? paper.keywords.map((value) => String(value || '').trim()).filter(Boolean) : [];
    paper.matchedSubprojects = Array.isArray(paper.matchedSubprojects)
      ? paper.matchedSubprojects.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    paper.doi = extractDoi(paper.doi) || extractDoi(paper.paperUrl) || extractDoi(paper.sourceUrl);
    paper.openalexId = normalizeOpenAlexId(paper.openalexId || paper.openAlexId || '');
    paper._isBlog = BLOG_SOURCE_SLUGS.has(String(paper.source || '').trim().toLowerCase())
      || ['blog', 'blog-post'].includes(String(paper.type || '').trim().toLowerCase());
    paper._titleTokens = tokenizeImportantWords(paper.title);
    paper._topicKeys = [...new Set(
      getPaperTopics(paper, Infinity)
        .map((topic) => normalizeMatchText(topic))
        .filter(Boolean)
    )];

    if (!paper.id || !paper.title || paper._isBlog) return null;
    return paper;
  }

  function normalizePapers(rawPapers) {
    if (!Array.isArray(rawPapers)) return [];
    return rawPapers.map(normalizePaperRecord).filter(Boolean);
  }

  function buildPaperDetailUrl(paper) {
    return `papers/paper.html?id=${encodeURIComponent(String(paper && paper.id || '').trim())}&from=papers`;
  }

  function buildRelatedPaperActions(paper) {
    const title = String(paper && paper.title || '').trim() || 'this paper';
    const titleEsc = escapeHtml(title);
    const detailUrl = buildPaperDetailUrl(paper);
    const paperHref = sanitizeExternalUrl(paper && paper.paperUrl || '');
    const sourceHref = sanitizeExternalUrl(paper && paper.sourceUrl || '');
    const paperIsPdf = isDirectPdfUrl(paperHref);
    const sourceIsPdf = isDirectPdfUrl(sourceHref);
    const directPdfHref = paperIsPdf
      ? paperHref
      : (sourceIsPdf ? sourceHref : '');
    const publisherHref = paperHref && paperHref !== directPdfHref ? paperHref : '';
    const sourceListingHref = sourceHref && sourceHref !== directPdfHref && sourceHref !== publisherHref ? sourceHref : '';
    const doiHref = sanitizeExternalUrl(doiUrlFromValue(paper && paper.doi || ''));
    const openAlexHref = normalizeOpenAlexId(paper && (paper.openalexId || paper.openAlexId) || '');

    const actions = [
      `<a href="${escapeHtml(detailUrl)}" class="link-btn" aria-label="Open library page for ${titleEsc}">Paper</a>`,
    ];

    if (directPdfHref) {
      actions.push(`<a href="${escapeHtml(directPdfHref)}" class="link-btn" target="_blank" rel="noopener noreferrer" aria-label="Open PDF for ${titleEsc} (opens in new tab)">PDF</a>`);
    }
    if (publisherHref) {
      actions.push(`<a href="${escapeHtml(publisherHref)}" class="link-btn" target="_blank" rel="noopener noreferrer" aria-label="Open publisher page for ${titleEsc} (opens in new tab)">Publisher</a>`);
    }
    if (sourceListingHref) {
      actions.push(`<a href="${escapeHtml(sourceListingHref)}" class="link-btn" target="_blank" rel="noopener noreferrer" aria-label="Open source listing for ${titleEsc} (opens in new tab)">Source</a>`);
    }
    if (doiHref && doiHref !== publisherHref && doiHref !== sourceListingHref) {
      actions.push(`<a href="${escapeHtml(doiHref)}" class="link-btn" target="_blank" rel="noopener noreferrer" aria-label="Open DOI record for ${titleEsc} (opens in new tab)">DOI</a>`);
    }
    if (openAlexHref) {
      actions.push(`<a href="${escapeHtml(openAlexHref)}" class="link-btn" target="_blank" rel="noopener noreferrer" aria-label="Open OpenAlex record for ${titleEsc} (opens in new tab)">OpenAlex</a>`);
    }

    return actions.join('');
  }

  function buildPaperTitleVariants(title) {
    const variants = [];
    const add = (value) => {
      const normalized = normalizeMatchText(value);
      if (!normalized) return;
      const tokenCount = normalized.split(' ').filter(Boolean).length;
      if (normalized.length < 16 || tokenCount < 3) return;
      if (!variants.includes(normalized)) variants.push(normalized);
    };

    const rawTitle = collapseWhitespace(title);
    if (!rawTitle) return variants;

    add(rawTitle);
    add(rawTitle.replace(/[“”"']/g, ''));

    const splitMatch = rawTitle.split(/\s*(?:[:\-–—])\s*/).map((part) => collapseWhitespace(part)).filter(Boolean);
    if (splitMatch.length > 1) {
      add(splitMatch[0]);
    }

    add(rawTitle.replace(/^(?:a|an|the)\s+/i, ''));
    return variants;
  }

  function hasTitleMention(haystack, titleVariants) {
    const text = ` ${String(haystack || '')} `;
    for (const variant of (Array.isArray(titleVariants) ? titleVariants : [])) {
      if (text.includes(` ${variant} `)) return true;
    }
    return false;
  }

  function countOverlap(values, set) {
    let total = 0;
    for (const value of (Array.isArray(values) ? values : [])) {
      if (set.has(value)) total += 1;
    }
    return total;
  }

  function buildAuthorPaperCountMap(papers) {
    const counts = new Map();
    for (const paper of (Array.isArray(papers) ? papers : [])) {
      for (const author of (paper && paper.authors) || []) {
        const key = typeof HubUtils.normalizePersonKey === 'function'
          ? HubUtils.normalizePersonKey(author && author.name)
          : normalizeMatchText(author && author.name);
        if (!key) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    return counts;
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

  function getTalkReferenceEntry(indexPayload, talk) {
    if (!indexPayload || typeof indexPayload !== 'object') return null;
    const talks = indexPayload.talks;
    if (!talks || typeof talks !== 'object') return null;
    const talkId = String(talk && talk.id || '').trim();
    if (!talkId) return null;
    const entry = talks[talkId];
    if (!entry || typeof entry !== 'object') return null;

    const indexedSlidesUrl = sanitizeExternalUrl(entry.slidesUrl || '');
    const currentSlidesUrl = sanitizeExternalUrl(talk && talk.slidesUrl);
    if (indexedSlidesUrl && currentSlidesUrl && indexedSlidesUrl !== currentSlidesUrl) return null;
    return entry;
  }

  function getSlideReferencedPaperIds(indexPayload, talk) {
    const entry = getTalkReferenceEntry(indexPayload, talk);
    if (!entry) return [];
    return Array.isArray(entry.slidePaperIds)
      ? entry.slidePaperIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
  }

  function getSlideReferencedTalkIds(indexPayload, talk) {
    const entry = getTalkReferenceEntry(indexPayload, talk);
    if (!entry) return [];
    return Array.isArray(entry.slideTalkIds)
      ? entry.slideTalkIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
  }

  function buildRelatedPaperEntries(talk, papers, slideReferenceIndex) {
    if (!talk || typeof talk !== 'object') return [];
    const slidePaperIds = getSlideReferencedPaperIds(slideReferenceIndex, talk);
    if (!slidePaperIds.length) return [];

    const paperById = new Map();
    for (const paper of (Array.isArray(papers) ? papers : [])) {
      if (!paper || typeof paper !== 'object') continue;
      const paperId = String(paper.id || '').trim();
      if (!paperId || paperById.has(paperId)) continue;
      paperById.set(paperId, paper);
    }

    const results = [];
    for (const paperId of slidePaperIds) {
      const paper = paperById.get(String(paperId || '').trim());
      if (!paper) continue;
      results.push({
        paper,
        reasons: ['Referenced in slides'],
      });
    }

    return results;
  }

  function buildReferencedTalkActions(talk) {
    const title = String(talk && talk.title || '').trim() || 'this talk';
    const actions = [
      `<a href="${escapeHtml(buildTalkDetailUrl(talk))}" class="link-btn" aria-label="Open library page for ${escapeHtml(title)}">Talk</a>`,
    ];
    const seen = new Set();

    function push(url, label) {
      const href = sanitizeExternalUrl(url);
      if (!href || seen.has(href)) return;
      seen.add(href);
      actions.push(`<a href="${escapeHtml(href)}" class="link-btn" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
    }

    push(talk && talk.slidesUrl, 'Slides');
    push(talk && talk.videoUrl, 'Video');
    push(talk && talk.sourceUrl, 'Source');
    return actions.join('');
  }

  function renderReferencedTalkEntry(talk) {
    const speakers = Array.isArray(talk && talk.speakers)
      ? talk.speakers.map((speaker) => collapseWhitespace(speaker && speaker.name)).filter(Boolean)
      : [];
    const meeting = collapseWhitespace(talk && (talk.meetingName || talk.meetingDate || talk.meeting));

    return `
      <li class="talk-paper-list-item">
        <div class="talk-paper-title-row">
          <a href="${escapeHtml(buildTalkDetailUrl(talk))}" class="talk-paper-link">${escapeHtml(String(talk && talk.title || '').trim())}</a>
          ${meeting ? `<span class="talk-paper-year">${escapeHtml(meeting)}</span>` : ''}
        </div>
        ${speakers.length ? `<p class="talk-paper-authors">${speakers.map((name) => escapeHtml(name)).join(', ')}</p>` : ''}
        <div class="talk-paper-meta-row">
          <div class="talk-paper-reason-list">
            <span class="detail-tag detail-tag--meta">Referenced in slides</span>
          </div>
        </div>
        <div class="talk-paper-actions">
          ${buildReferencedTalkActions(talk)}
        </div>
      </li>`;
  }

  function renderRelatedPaperEntry(entry) {
    const paper = entry && entry.paper;
    if (!paper) return '';

    const authors = Array.isArray(paper.authors)
      ? paper.authors.map((author) => String(author && author.name || '').trim()).filter(Boolean)
      : [];
    const detailUrl = buildPaperDetailUrl(paper);

    return `
      <li class="talk-paper-list-item">
        <div class="talk-paper-title-row">
          <a href="${escapeHtml(detailUrl)}" class="talk-paper-link">${escapeHtml(String(paper.title || '').trim())}</a>
          ${paper.year ? `<span class="talk-paper-year">${escapeHtml(String(paper.year || '').trim())}</span>` : ''}
        </div>
        ${authors.length ? `<p class="talk-paper-authors">${authors.map((name) => escapeHtml(name)).join(', ')}</p>` : ''}
        <div class="talk-paper-meta-row">
          <div class="talk-paper-reason-list">
            ${(entry.reasons || []).map((reason) => `<span class="detail-tag detail-tag--meta">${escapeHtml(reason)}</span>`).join('')}
          </div>
        </div>
        <div class="talk-paper-actions">
          ${buildRelatedPaperActions(paper)}
        </div>
      </li>`;
  }

  async function populateRelatedPapers(talk) {
    const section = document.getElementById('talk-related-papers-section');
    if (!section) return;

    const relatedContext = arguments[1] && typeof arguments[1] === 'object' ? arguments[1] : null;
    if (relatedContext) {
      const relatedPapers = Array.isArray(relatedContext.referencedPapers) ? relatedContext.referencedPapers : [];
      if (relatedPapers.length) {
        const entries = relatedPapers.map((paper) => ({
          paper,
          reasons: ['Referenced in slides'],
        }));
        section.hidden = false;
        section.removeAttribute('aria-busy');
        section.innerHTML = `
          <div class="section-label" aria-hidden="true">Referenced Papers</div>
          <ul class="talk-paper-list">
            ${entries.map((entry) => renderRelatedPaperEntry(entry)).join('')}
          </ul>`;
        return;
      }
      if (Array.isArray(relatedContext.slidePaperIds) && !relatedContext.slidePaperIds.length) {
        section.remove();
        return;
      }
    }

    if (typeof window.loadPaperData !== 'function') {
      section.remove();
      return;
    }

    try {
      const [paperPayload, slideReferenceIndex] = await Promise.all([
        window.loadPaperData(),
        loadTalkPaperLinkIndex(),
      ]);

      const papers = normalizePapers(paperPayload && paperPayload.papers);
      const entries = buildRelatedPaperEntries(talk, papers, slideReferenceIndex);
      if (!entries.length) {
        section.remove();
        return;
      }

      section.hidden = false;
      section.removeAttribute('aria-busy');
      section.innerHTML = `
        <div class="section-label" aria-hidden="true">Referenced Papers</div>
        <ul class="talk-paper-list">
          ${entries.map((entry) => renderRelatedPaperEntry(entry)).join('')}
        </ul>`;
    } catch {
      section.remove();
    }
  }

  async function populateReferencedTalks(talk) {
    const section = document.getElementById('talk-referenced-talks-section');
    if (!section) return;
    const relatedContext = arguments[1] && typeof arguments[1] === 'object' ? arguments[1] : null;
    if (relatedContext) {
      const referencedTalks = Array.isArray(relatedContext.referencedTalks) ? relatedContext.referencedTalks : [];
      if (referencedTalks.length) {
        section.hidden = false;
        section.removeAttribute('aria-busy');
        section.innerHTML = `
          <div class="section-label" aria-hidden="true">Referenced Talks</div>
          <ul class="talk-paper-list">
            ${referencedTalks.map((entry) => renderReferencedTalkEntry(entry)).join('')}
          </ul>`;
        return;
      }
      if (Array.isArray(relatedContext.slideTalkIds) && !relatedContext.slideTalkIds.length) {
        section.remove();
        return;
      }
    }

    if (typeof window.loadEventData !== 'function') {
      section.remove();
      return;
    }

    try {
      const [talkPayload, slideReferenceIndex] = await Promise.all([
        window.loadEventData(),
        loadTalkPaperLinkIndex(),
      ]);
      const referencedTalkIds = getSlideReferencedTalkIds(slideReferenceIndex, talk);
      if (!referencedTalkIds.length) {
        section.remove();
        return;
      }

      const talks = normalizeTalks(talkPayload && talkPayload.talks);
      const talkById = new Map();
      for (const candidate of talks) {
        const candidateId = String(candidate && candidate.id || '').trim();
        if (!candidateId || talkById.has(candidateId)) continue;
        talkById.set(candidateId, candidate);
      }

      const referencedTalks = referencedTalkIds
        .map((id) => talkById.get(id))
        .filter(Boolean);
      if (!referencedTalks.length) {
        section.remove();
        return;
      }

      section.hidden = false;
      section.removeAttribute('aria-busy');
      section.innerHTML = `
        <div class="section-label" aria-hidden="true">Referenced Talks</div>
        <ul class="talk-paper-list">
          ${referencedTalks.map((entry) => renderReferencedTalkEntry(entry)).join('')}
        </ul>`;
    } catch {
      section.remove();
    }
  }

  async function populateReferencedLinks(talk) {
    const section = document.getElementById('talk-referenced-links-section');
    if (!section) return;

    try {
      const slideReferenceIndex = await loadTalkPaperLinkIndex();
      const entry = getTalkReferenceEntry(slideReferenceIndex, talk);
      const html = renderReferenceItems(entry);
      if (!html) {
        section.remove();
        return;
      }
      section.outerHTML = html;
    } catch {
      section.remove();
    }
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

  function updateSeo(talk) {
    if (!talk || typeof talk !== 'object') return;
    const title = String(talk.title || '').trim();
    if (!title) return;
    const description = String(talk.abstract || '').replace(/\s+/g, ' ').trim().slice(0, 260);
    upsertMeta('name', 'description', description || `${title} talk details`);
    upsertMeta('property', 'og:type', 'article');
    upsertMeta('property', 'og:title', `${title} — LLVM Research Library`);
    upsertMeta('property', 'og:description', description || title);
    upsertMeta('property', 'og:url', window.location.href);
    upsertMeta('name', 'twitter:card', 'summary');
    upsertMeta('name', 'twitter:title', `${title} — LLVM Research Library`);
    upsertMeta('name', 'twitter:description', description || title);
  }

  function setIssueContext(context) {
    if (typeof window.setLibraryIssueContext !== 'function') return;
    if (!context || typeof context !== 'object') return;
    window.setLibraryIssueContext(context);
  }

  function setIssueContextForTalk(talk) {
    if (!talk || typeof talk !== 'object') return;
    setIssueContext({
      pageType: 'Talk',
      itemType: 'Talk',
      itemId: String(talk.id || '').trim(),
      itemTitle: String(talk.title || '').trim(),
      pageTitle: `${String(talk.title || '').trim()} — LLVM Research Library`,
      meeting: String(talk.meeting || '').trim(),
      meetingName: String(talk.meetingName || '').trim(),
      slidesUrl: String(talk.slidesUrl || '').trim(),
      posterUrl: String(talk.posterUrl || '').trim(),
      videoUrl: String(talk.videoUrl || '').trim(),
      sourceUrl: String(talk.sourceUrl || '').trim(),
    });
  }

  async function loadTalkDetailContextById(talkId) {
    const targetId = String(talkId || '').trim();
    if (!targetId) return { loaded: true, talk: null, relatedPool: [], related: null };

    if (typeof window.loadTalkRecordById === 'function') {
      try {
        const payload = await window.loadTalkRecordById(targetId);
        if (!payload || typeof payload !== 'object') {
          return { loaded: true, talk: null, relatedPool: [], related: null };
        }
        const normalizedTalk = normalizeTalks([payload.talk]);
        const talk = normalizedTalk.length ? normalizedTalk[0] : null;
        const relatedPool = Array.isArray(payload && payload.related && payload.related.relatedTalks)
          ? normalizeTalks(payload.related.relatedTalks)
          : normalizeTalks(payload.talks);
        return {
          loaded: true,
          talk,
          relatedPool: Array.isArray(relatedPool) ? relatedPool : [],
          related: payload.related && typeof payload.related === 'object' ? payload.related : null,
        };
      } catch {
        // Fallback below.
      }
    }

    if (typeof window.loadEventData !== 'function') {
      return { loaded: false, talk: null, relatedPool: [], related: null };
    }

    try {
      const payload = await window.loadEventData();
      const talks = normalizeTalks(payload && payload.talks);
      const talk = talks.find((candidate) => String(candidate && candidate.id || '') === targetId) || null;
      return { loaded: true, talk, relatedPool: talks, related: null };
    } catch {
      return { loaded: false, talk: null, relatedPool: [], related: null };
    }
  }

  function renderAbstract(text) {
    const normalized = String(text || '').trim();
    if (!normalized) return '<p><em>No abstract available.</em></p>';
    return normalized
      .split(/\n{2,}|\r\n\r\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => {
        const lines = paragraph
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (lines.length >= 2 && lines.every((line) => /^\d+\.\s+/.test(line))) {
          const items = lines
            .map((line) => line.replace(/^\d+\.\s+/, '').trim())
            .filter(Boolean)
            .map((line) => `<li>${escapeHtml(line)}</li>`)
            .join('');
          return `<ol>${items}</ol>`;
        }
        return `<p>${escapeHtml(paragraph.replace(/\n/g, ' '))}</p>`;
      })
      .join('\n');
  }

  function buildSpeakerWorkUrl(name) {
    const speaker = String(name || '').trim();
    if (!speaker) return 'work.html';
    return `work.html?kind=speaker&value=${encodeURIComponent(speaker)}&from=talks`;
  }

  function renderSpeakers(speakers) {
    const values = Array.isArray(speakers) ? speakers : [];
    if (!values.length) {
      return '<p style="color: var(--color-text-muted); font-size: var(--font-size-sm);">Speaker information not available.</p>';
    }

    return values.map((speaker) => {
      const name = String(speaker && speaker.name || '').trim();
      if (!name) return '';
      const affiliation = String(speaker && speaker.affiliation || '').trim();
      return `
        <div class="speaker-chip">
          <div>
            <a href="${buildSpeakerWorkUrl(name)}" class="speaker-name-link" aria-label="View talks and papers by ${escapeHtml(name)}">${escapeHtml(name)}</a>
            ${affiliation ? `<br><span class="speaker-affiliation">${escapeHtml(affiliation)}</span>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  function buildAbstractPreview(text, maxLength = 300) {
    const raw = collapseWhitespace(text);
    if (!raw) return '';
    if (raw.length <= maxLength) return raw;
    const hardSlice = raw.slice(0, maxLength).trim();
    const softSlice = hardSlice.replace(/\s+\S*$/, '').trim();
    return `${softSlice || hardSlice}...`;
  }

  function formatCardTalkSpeakers(speakers) {
    return Array.isArray(speakers)
      ? speakers.map((speaker) => collapseWhitespace(speaker && speaker.name)).filter(Boolean)
      : [];
  }

  function categoryLabel(category) {
    const key = collapseWhitespace(category).toLowerCase();
    return ({
      keynote: 'Keynote',
      'technical-talk': 'Technical Talk',
      tutorial: 'Tutorial',
      panel: 'Panel',
      'quick-talk': 'Quick Talk',
      'lightning-talk': 'Lightning Talk',
      'student-talk': 'Student Talk',
      'llvm-foundation': 'LLVM Foundation',
      'open-design-meeting': 'Open Design Meeting',
      bof: 'BoF',
      poster: 'Poster',
      workshop: 'Workshop',
      other: 'Other',
    }[key]) || (key ? key.replace(/-/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase()) : 'Other');
  }

  function sourceNameFromHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
    if (!host) return 'External Source';
    if (host === 'youtu.be' || host.endsWith('youtube.com')) return 'YouTube';
    if (host === 'devimages.apple.com') return 'Apple Developer';
    return host;
  }

  function isAppleDeveloperVideoUrl(videoUrl) {
    if (!videoUrl) return false;
    try {
      const host = new URL(videoUrl).hostname.toLowerCase().replace(/^www\./, '');
      return host === 'devimages.apple.com';
    } catch {
      return false;
    }
  }

  function getVideoLinkMeta(videoUrl, titleEsc) {
    const fallback = {
      text: 'Watch',
      ariaLabel: `Watch video: ${titleEsc} (opens in new tab)`,
      icon: 'play',
    };
    if (!videoUrl) return fallback;

    try {
      const url = new URL(videoUrl);
      const sourceName = sourceNameFromHost(url.hostname);
      const isYouTube = sourceName === 'YouTube';
      const isDownload =
        /\.(mov|m4v|mp4|mkv|avi|wmv|webm)$/i.test(url.pathname) ||
        /download/i.test(url.pathname) ||
        /download/i.test(url.search);

      if (isDownload) {
        const sourceText = isYouTube ? '' : ` (${sourceName})`;
        return {
          text: `Download${sourceText}`,
          ariaLabel: `Download video${isYouTube ? '' : ` from ${sourceName}`}: ${titleEsc} (opens in new tab)`,
          icon: sourceName === 'Apple Developer' ? 'tv' : 'download',
        };
      }

      if (!isYouTube) {
        return {
          text: `Watch on ${sourceName}`,
          ariaLabel: `Watch on ${sourceName}: ${titleEsc} (opens in new tab)`,
          icon: 'play',
        };
      }

      return {
        text: 'Watch',
        ariaLabel: `Watch on YouTube: ${titleEsc} (opens in new tab)`,
        icon: 'play',
      };
    } catch {
      return fallback;
    }
  }

  const CARD_SVG_DOC = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
  const CARD_SVG_SLIDES = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="14" height="10" rx="1.8"/><path d="M7 9h8"/><path d="M7 12h5"/><path d="M9 19h11a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1"/></svg>`;
  const CARD_SVG_POSTER = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="3" width="12" height="14" rx="1.5"/><path d="M9 7h6"/><path d="M9 10h6"/><path d="M12 17v4"/><path d="M9.5 21h5"/></svg>`;
  const CARD_SVG_TOOL = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;
  const CARD_SVG_CHAT = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
  const CARD_SVG_TV = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="2" ry="2"/><line x1="8" y1="20" x2="16" y2="20"/><line x1="12" y1="17" x2="12" y2="20"/><polygon points="10 9 15 11 10 13 10 9" fill="currentColor" stroke="none"/></svg>`;

  function placeholderSvgForCategory(category) {
    const key = collapseWhitespace(category).toLowerCase();
    return ({ workshop: CARD_SVG_TOOL, panel: CARD_SVG_CHAT, bof: CARD_SVG_CHAT, 'open-design-meeting': CARD_SVG_CHAT }[key]) || CARD_SVG_DOC;
  }

  function mediaPlaceholderForTalk(talk) {
    const videoHref = sanitizeExternalUrl(talk && talk.videoUrl);
    const slidesHref = sanitizeExternalUrl(talk && talk.slidesUrl);
    const posterHref = sanitizeExternalUrl(talk && talk.posterUrl);
    const category = collapseWhitespace(talk && talk.category).toLowerCase();

    if (!videoHref) {
      if (category === 'poster' || posterHref) {
        return { svg: CARD_SVG_POSTER, label: 'Poster' };
      }
      if (slidesHref) {
        return { svg: CARD_SVG_SLIDES, label: 'Slides' };
      }
    }

    if (isAppleDeveloperVideoUrl(videoHref)) {
      return { svg: CARD_SVG_TV, label: 'Video' };
    }
    return { svg: placeholderSvgForCategory(category), label: '' };
  }

  function renderTalkCardSpeakerLinks(talk) {
    const speakers = formatCardTalkSpeakers(talk && talk.speakers);
    if (!speakers.length) return '';
    return `
      <p class="card-speakers">
        ${speakers.map((name) =>
          `<a href="${buildSpeakerWorkUrl(name)}" class="speaker-btn" aria-label="View talks and papers by ${escapeHtml(name)}">${escapeHtml(name)}</a>`
        ).join('<span class="speaker-btn-sep">, </span>')}
      </p>`;
  }

  function renderTalkCardTags(talk) {
    const tags = getTalkTopics(talk, 8);
    if (!tags.length) return '';
    const shown = tags.slice(0, 4);
    return `
      <div class="card-tags-wrap">
        <div class="card-tags" aria-label="Key Topics">
          ${shown.map((tag) =>
            `<a href="talks/?tag=${encodeURIComponent(tag)}" class="card-tag" aria-label="Browse talks for key topic ${escapeHtml(tag)}">${escapeHtml(tag)}</a>`
          ).join('')}
          ${tags.length > shown.length ? `<span class="card-tag card-tag--more" aria-hidden="true">+${tags.length - shown.length}</span>` : ''}
        </div>
      </div>`;
  }

  function renderTalkCardActions(talk) {
    const title = collapseWhitespace(talk && talk.title) || 'Untitled talk';
    const titleEsc = escapeHtml(title);
    const videoHref = sanitizeExternalUrl(talk && talk.videoUrl);
    const posterHref = sanitizeExternalUrl(talk && talk.posterUrl);
    const slidesHref = sanitizeExternalUrl(talk && talk.slidesUrl) || posterHref;
    const githubHref = sanitizeExternalUrl(talk && talk.projectGithub);
    const videoMeta = getVideoLinkMeta(videoHref, titleEsc);
    const videoIcon = videoMeta.icon === 'download'
      ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/></svg>`
      : videoMeta.icon === 'tv'
        ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="2" ry="2"/><line x1="8" y1="20" x2="16" y2="20"/><line x1="12" y1="17" x2="12" y2="20"/></svg>`
        : `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
    const videoLinkHtml = videoHref
      ? `<a href="${escapeHtml(videoHref)}" class="card-link-btn card-link-btn--video" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(videoMeta.ariaLabel)}">${videoIcon}<span aria-hidden="true">${escapeHtml(videoMeta.text)}</span></a>`
      : '';
    const slidesLabel = collapseWhitespace(talk && talk.category).toLowerCase() === 'poster' || posterHref ? 'Poster' : 'Slides';
    const slidesLinkHtml = slidesHref
      ? `<a href="${escapeHtml(slidesHref)}" class="card-link-btn" target="_blank" rel="noopener noreferrer" aria-label="View ${escapeHtml(slidesLabel.toLowerCase())}: ${titleEsc} (opens in new tab)"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span aria-hidden="true">${escapeHtml(slidesLabel)}</span></a>`
      : '';
    const githubLinkHtml = githubHref
      ? `<a href="${escapeHtml(githubHref)}" class="card-link-btn" target="_blank" rel="noopener noreferrer" aria-label="GitHub repository: ${titleEsc} (opens in new tab)"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg><span aria-hidden="true">GitHub</span></a>`
      : '';
    const actions = [videoLinkHtml, slidesLinkHtml, githubLinkHtml].filter(Boolean);
    return actions.length ? `<div class="card-footer">${actions.join('')}</div>` : '';
  }

  function getRelatedTalks(talk, relatedPool) {
    const values = Array.isArray(relatedPool) ? relatedPool : [];
    const targetId = String(talk && talk.id || '').trim();
    if (!targetId || !values.length) return [];

    if (typeof HubUtils.getRelatedTalkCandidates === 'function') {
      return HubUtils.getRelatedTalkCandidates(talk, values, { limit: 6 });
    }
    return [];
  }

  function renderRelatedCard(talk) {
    const title = collapseWhitespace(talk && talk.title) || 'Untitled talk';
    const titleEsc = escapeHtml(title);
    const speakerNames = formatCardTalkSpeakers(talk && talk.speakers);
    const speakerLabel = speakerNames.length ? ` by ${speakerNames.join(', ')}` : '';
    const meetingLabel = collapseWhitespace(talk && (talk.meetingName || talk._year || talk.meeting));
    const categoryKey = collapseWhitespace(talk && talk.category).toLowerCase() || 'other';
    const badgeCls = `badge badge-${escapeHtml(categoryKey)}`;
    const thumbnailUrl = collapseWhitespace(talk && talk.videoId)
      ? `https://img.youtube.com/vi/${encodeURIComponent(String(talk.videoId || '').trim())}/hqdefault.jpg`
      : '';
    const placeholder = mediaPlaceholderForTalk(talk);
    const placeholderHtml = `<div class="card-thumbnail-placeholder">${placeholder.svg}${placeholder.label ? `<span class="card-thumbnail-placeholder-label">${escapeHtml(placeholder.label)}</span>` : ''}</div>`;
    const thumbnailHtml = thumbnailUrl
      ? `<img src="${escapeHtml(thumbnailUrl)}" alt="" loading="lazy" data-thumbnail-category="${escapeHtml(categoryKey)}">`
      : placeholderHtml;
    const abstractPreview = buildAbstractPreview(talk && talk.abstract, 300);

    return `
      <article class="talk-card">
        <a href="${escapeHtml(buildTalkDetailUrl(talk))}" class="card-link-wrap" aria-label="${titleEsc}${escapeHtml(speakerLabel)}">
          <div class="card-thumbnail" aria-hidden="true">
            ${thumbnailHtml}
            ${thumbnailUrl ? `<div class="play-overlay" aria-hidden="true"><div class="play-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg></div></div>` : ''}
          </div>
          <div class="card-body">
            <div class="card-meta">
              <span class="${badgeCls}">${escapeHtml(categoryLabel(categoryKey))}</span>
              ${meetingLabel ? `<span class="meeting-label">${escapeHtml(meetingLabel)}</span>` : ''}
            </div>
            <p class="card-title">${titleEsc}</p>
            ${abstractPreview ? `<p class="card-abstract">${escapeHtml(abstractPreview)}</p>` : ''}
          </div>
        </a>
        ${renderTalkCardSpeakerLinks(talk)}
        ${renderTalkCardTags(talk)}
        ${renderTalkCardActions(talk)}
      </article>`;
  }

  function renderNotFound(id) {
    const root = document.getElementById('talk-detail-root');
    if (!root) return;
    root.innerHTML = `
      <div class="talk-detail">
        <a href="${escapeHtml(TALK_LISTING_PATH)}" class="back-btn" aria-label="Back to ${escapeHtml(TALK_LISTING_LABEL)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
          <span aria-hidden="true">${escapeHtml(TALK_LISTING_LABEL)}</span>
        </a>
        <div class="empty-state">
          <div class="empty-state-icon" aria-hidden="true">!</div>
          <h2>Talk not found</h2>
          <p>No talk found with ID <code>${escapeHtml(id || '(none)')}</code>.</p>
          <p><a href="${escapeHtml(TALK_LISTING_PATH)}">Browse ${escapeHtml(TALK_LISTING_LABEL)} →</a></p>
        </div>
      </div>`;
  }

  function renderLoadError() {
    const root = document.getElementById('talk-detail-root');
    if (!root) return;
    root.innerHTML = `
      <div class="talk-detail">
        <div class="empty-state" role="alert">
          <div class="empty-state-icon" aria-hidden="true">!</div>
          <h2>Could not load data</h2>
          <p>${TALK_DATA_HINT_HTML}</p>
        </div>
      </div>`;
  }

  function renderTalkDetail(talk, relatedPool) {
    const root = document.getElementById('talk-detail-root');
    if (!root) return;
    const relatedContext = arguments[2] && typeof arguments[2] === 'object' ? arguments[2] : null;

    const title = String(talk.title || '').trim();
    const meetingDate = formatMeetingDate(talk.meetingDate);
    const meetingLocation = String(talk.meetingLocation || '').trim();
    const meetingMeta = [meetingDate, meetingLocation].filter(Boolean).join(' · ');

    const videoUrl = sanitizeExternalUrl(talk.videoUrl);
    const embeddedVideoUrl = buildEmbeddedVideoUrl(videoUrl);
    const primarySlidesLink = buildPrimarySlidesLink(talk);
    const links = buildResourceLinks(talk);

    const topics = getTalkTopics(talk, 18);
    const topicsHtml = topics.length
      ? `<section class="tags-section" aria-label="Key Topics">
          <div class="section-label" aria-hidden="true">Key Topics</div>
          <div class="detail-tags">
            ${topics.map((topic) =>
              `<a href="talks/?tag=${encodeURIComponent(topic)}" class="detail-tag" aria-label="Browse talks for key topic ${escapeHtml(topic)}">${escapeHtml(topic)}</a>`
            ).join('')}
          </div>
        </section>`
      : '';

    const related = Array.isArray(relatedContext && relatedContext.relatedTalks) && relatedContext.relatedTalks.length
      ? relatedContext.relatedTalks
      : getRelatedTalks(talk, relatedPool);

    root.innerHTML = `
      <div class="talk-detail">
        <a href="${escapeHtml(TALK_LISTING_PATH)}" class="back-btn" id="back-btn" aria-label="Back to ${escapeHtml(TALK_LISTING_LABEL)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
          <span aria-hidden="true">${escapeHtml(TALK_LISTING_LABEL)}</span>
        </a>

        <div class="talk-header">
          <div class="talk-header-meta">
            ${meetingMeta ? `<span class="meeting-info-badge">${escapeHtml(meetingMeta)}</span>` : ''}
          </div>
          <h1 class="talk-title">${escapeHtml(title)}</h1>
        </div>

        <section class="speakers-section" aria-label="Speakers">
          <div class="section-label" aria-hidden="true">Speakers</div>
          <div class="speakers-list">${renderSpeakers(talk.speakers)}</div>
        </section>

        <section class="abstract-section" aria-label="Abstract">
          <div class="section-label" aria-hidden="true">Abstract</div>
          <div class="abstract-body">${renderAbstract(talk.abstract)}</div>
        </section>

        ${primarySlidesLink ? `<div class="links-bar" aria-label="Slides">${primarySlidesLink}</div>` : ''}

        <section class="talk-paper-links-section" id="talk-related-papers-section" aria-label="Referenced papers" aria-busy="true">
          <div class="section-label" aria-hidden="true">Referenced Papers</div>
          <p class="talk-paper-links-loading">Loading slide-referenced papers…</p>
        </section>

        <section class="talk-paper-links-section" id="talk-referenced-talks-section" aria-label="Referenced talks" aria-busy="true">
          <div class="section-label" aria-hidden="true">Referenced Talks</div>
          <p class="talk-paper-links-loading">Loading slide-referenced talks…</p>
        </section>

        <section class="talk-github-links-section" id="talk-referenced-links-section" aria-label="Referenced links" aria-busy="true">
          <div class="section-label" aria-hidden="true">Referenced Links</div>
          <p class="talk-paper-links-loading">Loading referenced links…</p>
        </section>

        ${links.length ? `<div class="links-bar" aria-label="Resources">${links.join('')}</div>` : ''}

        ${embeddedVideoUrl ? `
        <section class="video-section" aria-label="Video player">
          <div class="section-label" aria-hidden="true">Video</div>
          <div class="video-embed">
            <iframe
              src="${escapeHtml(embeddedVideoUrl)}"
              title="${escapeHtml(title || 'Talk video')}"
              loading="lazy"
              referrerpolicy="strict-origin-when-cross-origin"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowfullscreen
            ></iframe>
          </div>
        </section>` : ''}

        ${topicsHtml}
      </div>

      ${related.length ? `
      <section class="related-section" aria-label="Related talks">
        <h2>Related Talks</h2>
        <div class="related-grid">
          ${related.map((item) => renderRelatedCard(item)).join('')}
        </div>
      </section>` : ''}`;

    const backBtn = document.getElementById('back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', (event) => {
        if (safeSessionGet('llvm-hub-search-state')) return;
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
    const talkId = String(params.get('id') || '').trim();

    setIssueContext({
      pageType: 'Talk',
      itemType: 'Talk',
      itemId: talkId,
    });

    if (!talkId) {
      renderNotFound(null);
      setIssueContext({ itemTitle: 'Missing talk ID', issueTitle: '[Talk] Missing talk ID' });
      initShareMenu();
      return;
    }

    const context = await loadTalkDetailContextById(talkId);
    if (!context || context.loaded !== true) {
      renderLoadError();
      initShareMenu();
      return;
    }

    const talk = context.talk;
    if (!talk) {
      renderNotFound(talkId);
      setIssueContext({ itemTitle: `Unknown talk ID: ${talkId}`, issueTitle: `[Talk] Unknown talk ID: ${talkId}` });
      initShareMenu();
      return;
    }

    document.title = `${String(talk.title || '').trim()} — LLVM Research Library`;
    updateSeo(talk);
    renderTalkDetail(talk, context.relatedPool, context.related);
    void populateRelatedPapers(talk, context.related);
    void populateReferencedTalks(talk, context.related);
    void populateReferencedLinks(talk);
    setIssueContextForTalk(talk);
    initShareMenu();
  }

  init();
})();
