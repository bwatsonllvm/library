/**
 * report-issue.js - prefill public GitHub issue links with page/item context.
 */

(function () {
  const ISSUE_BASE_URL = 'https://github.com/bwatsonllvm/library/issues/new';
  const PUBLIC_SITE_BASE_URL = 'https://bwatsonllvm.github.io/library/';
  const DEFAULT_PROMPT = '<!-- Please describe what should be corrected or added. -->';

  const issueButton = document.getElementById('report-issue-btn');
  if (!issueButton) return;

  function normalizeText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function truncateText(value, maxLength) {
    const text = normalizeText(value);
    if (!text) return '';
    if (!Number.isFinite(maxLength) || maxLength <= 0) return text;
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
  }

  function safeUrl(value) {
    try {
      return new URL(String(value || ''), window.location.href);
    } catch {
      return null;
    }
  }

  function normalizeLibraryPath(url) {
    let path = String((url && url.pathname) || '').replace(/^\/+/, '');
    if (path === 'library' || path === 'devmtg' || path === '_site') {
      return '';
    }

    const devmtgIndex = path.indexOf('devmtg/');
    if (devmtgIndex !== -1) {
      return path.slice(devmtgIndex + 'devmtg/'.length);
    }

    const libraryIndex = path.indexOf('library/');
    if (libraryIndex !== -1) {
      path = path.slice(libraryIndex + 'library/'.length);
    }

    if (path.startsWith('_site/')) {
      path = path.slice('_site/'.length);
    }
    return path;
  }

  function toPublicUrl(inputUrl) {
    const parsed = safeUrl(inputUrl || window.location.href);
    if (!parsed) return PUBLIC_SITE_BASE_URL;

    const path = normalizeLibraryPath(parsed);
    const query = parsed.search || '';
    const hash = parsed.hash || '';
    return `${PUBLIC_SITE_BASE_URL}${path}${query}${hash}`;
  }

  function pushContextLine(lines, label, value) {
    const text = normalizeText(value);
    if (!text) return;
    lines.push(`- ${label}: ${text}`);
  }

  function deriveIssueTitle(context) {
    const explicit = normalizeText(context.issueTitle);
    if (explicit) return truncateText(explicit, 120);

    const itemType = normalizeText(context.itemType || context.pageType || 'Page');
    const itemTitle = normalizeText(context.itemTitle || context.pageTitle || document.title || 'LLVM Research Library');
    return truncateText(`[${itemType}] ${itemTitle}`, 120);
  }

  function deriveBody(context, publicUrl) {
    const lines = [
      '## What should be updated?',
      DEFAULT_PROMPT,
      '',
      '## Context',
    ];

    pushContextLine(lines, 'Page', context.pageTitle || document.title || 'LLVM Research Library');
    pushContextLine(lines, 'Public URL', publicUrl);

    const currentUrl = normalizeText(window.location.href);
    if (currentUrl && currentUrl !== publicUrl) {
      pushContextLine(lines, 'Current URL', currentUrl);
    }

    pushContextLine(lines, 'Item type', context.itemType || context.pageType);
    pushContextLine(lines, 'Item ID', context.itemId);
    pushContextLine(lines, 'Item title', context.itemTitle);
    pushContextLine(lines, 'Year', context.year);
    pushContextLine(lines, 'Meeting', context.meetingName || context.meeting);
    pushContextLine(lines, 'Query', context.query);
    pushContextLine(lines, 'Paper URL', context.paperUrl);
    pushContextLine(lines, 'Source URL', context.sourceUrl);
    pushContextLine(lines, 'Slides URL', context.slidesUrl);
    pushContextLine(lines, 'Video URL', context.videoUrl);
    pushContextLine(lines, 'DOI', context.doi);
    pushContextLine(lines, 'OpenAlex', context.openalexId);

    if (Array.isArray(context.extraLinks) && context.extraLinks.length) {
      lines.push('- Related links:');
      for (const entry of context.extraLinks) {
        if (!entry || typeof entry !== 'object') continue;
        const label = normalizeText(entry.label);
        const url = normalizeText(entry.url);
        if (!label || !url) continue;
        lines.push(`  - ${label}: ${url}`);
      }
    }

    lines.push('');
    lines.push('## Notes');
    lines.push('<!-- Optional: include references, screenshots, or corrected links. -->');

    return lines.join('\n');
  }

  function applyIssueButtonHref() {
    const context = (window.LLVM_LIBRARY_ISSUE_CONTEXT && typeof window.LLVM_LIBRARY_ISSUE_CONTEXT === 'object')
      ? window.LLVM_LIBRARY_ISSUE_CONTEXT
      : {};
    const publicUrl = normalizeText(context.pageUrl) || toPublicUrl(window.location.href);
    const params = new URLSearchParams();
    params.set('title', deriveIssueTitle(context));
    params.set('body', deriveBody(context, publicUrl));

    issueButton.href = `${ISSUE_BASE_URL}?${params.toString()}`;
    issueButton.setAttribute('target', '_blank');
    issueButton.setAttribute('rel', 'noopener noreferrer');
  }

  window.setLibraryIssueContext = function setLibraryIssueContext(nextContext) {
    if (!nextContext || typeof nextContext !== 'object') return;

    const previous = (window.LLVM_LIBRARY_ISSUE_CONTEXT && typeof window.LLVM_LIBRARY_ISSUE_CONTEXT === 'object')
      ? window.LLVM_LIBRARY_ISSUE_CONTEXT
      : {};
    window.LLVM_LIBRARY_ISSUE_CONTEXT = { ...previous, ...nextContext };
    applyIssueButtonHref();
  };

  window.setLibraryIssueContext({
    pageType: 'Page',
    pageTitle: normalizeText(document.title) || 'LLVM Research Library',
    pageUrl: toPublicUrl(window.location.href),
  });
})();
