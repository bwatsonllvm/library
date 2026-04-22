/**
 * mlir-talks.js - adapts MLIR upstream talk metadata to the core talks index runtime.
 */

(function () {
  const DATA_PATH = 'sub-projects/mlir/data/talks.json';
  const HubUtils = window.LLVMHubUtils || {};
  const MONTH_LOOKUP = Object.freeze({
    jan: '01', january: '01',
    feb: '02', february: '02',
    mar: '03', march: '03',
    apr: '04', april: '04',
    may: '05',
    jun: '06', june: '06',
    jul: '07', july: '07',
    aug: '08', august: '08',
    sep: '09', sept: '09', september: '09',
    oct: '10', october: '10',
    nov: '11', november: '11',
    dec: '12', december: '12',
  });
  const SECTION_CATEGORY_MAP = Object.freeze({
    tutorials: 'tutorial',
    'tech-talks': 'technical-talk',
    'open-design-meeting-presentations': 'bof',
    'upcoming-talks-or-presentations': 'technical-talk',
    'past-conferences-and-workshops': 'workshop',
  });
  const EXCLUDED_SECTION_KEYS = new Set([
    'upcoming-talks-or-presentations',
    'past-conferences-and-workshops',
  ]);
  const GENERIC_GROUP_KEYS = new Set([
    '',
    'past-editions',
    'past-editions:',
  ]);
  const RESOURCE_ONLY_RE = /\b(?:slides?|recordings?|recording|transcript|talk|talks|event|events|part\s+\d+|additional slides?)\b/gi;

  let talksPromise = null;

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

  function slugify(value) {
    return collapseWhitespace(value)
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function uniqueStrings(values) {
    const out = [];
    const seen = new Set();
    for (const value of (Array.isArray(values) ? values : [])) {
      const text = collapseWhitespace(value);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out;
  }

  function cleanTopicLabel(value) {
    const text = collapseWhitespace(value).replace(/:$/, '');
    const key = slugify(text);
    if (!text || GENERIC_GROUP_KEYS.has(key)) return '';
    return text;
  }

  function cleanTalkTitle(value) {
    let title = collapseWhitespace(value);
    if (!title) return '';

    title = title
      .replace(/\s*\((?:slides?|recordings?|recording|transcript)\s*$/i, '')
      .replace(/\s*[-;:]\s*(?:slides?|recordings?|recording|transcript|additional slides?)\s*$/i, '')
      .replace(/\s+(?:slides?|recordings?|recording|transcript)\s*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/[(:;\-]+$/g, '')
      .trim();

    return title;
  }

  function pad2(value) {
    return String(value || '').padStart(2, '0');
  }

  function parseDateFromTitle(title) {
    const match = collapseWhitespace(title).match(/^(\d{4})-(\d{2})-(\d{2})(?:\b|[:\s-])/);
    if (!match) return null;
    return {
      sortKey: `${match[1]}-${match[2]}-${match[3]}`,
      label: `${match[1]}-${match[2]}-${match[3]}`,
      year: match[1],
    };
  }

  function parseDateFromText(text) {
    const match = collapseWhitespace(text).match(
      /\b(January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sept|Sep|October|Oct|November|Nov|December|Dec)\s+(\d{1,2})(?:\s*[-/]\s*(\d{1,2}))?,?\s+((?:19|20)\d{2})\b/i
    );
    if (!match) return null;
    const month = MONTH_LOOKUP[String(match[1] || '').toLowerCase()];
    if (!month) return null;
    return {
      sortKey: `${match[4]}-${month}-${pad2(match[2])}`,
      label: collapseWhitespace(match[0]),
      year: String(match[4]),
    };
  }

  function parseDateFromUrls(urls) {
    for (const url of (Array.isArray(urls) ? urls : [])) {
      const text = String(url || '');
      const exact = text.match(/\/((?:19|20)\d{2})-(\d{2})-(\d{2})(?:[^\d]|$)/);
      if (exact) {
        return {
          sortKey: `${exact[1]}-${exact[2]}-${exact[3]}`,
          label: `${exact[1]}-${exact[2]}-${exact[3]}`,
          year: exact[1],
        };
      }
      const monthMatch = text.match(/\/((?:19|20)\d{2})-(\d{2})(?:[^\d]|$)/);
      if (monthMatch) {
        return {
          sortKey: `${monthMatch[1]}-${monthMatch[2]}-00`,
          label: `${monthMatch[1]}-${monthMatch[2]}`,
          year: monthMatch[1],
        };
      }
      const yearMatch = text.match(/\/((?:19|20)\d{2})(?:[^\d]|$)/);
      if (yearMatch) {
        return {
          sortKey: `${yearMatch[1]}-00-00`,
          label: yearMatch[1],
          year: yearMatch[1],
        };
      }
    }
    return null;
  }

  function parseDateInfo(entry, actions) {
    const fromTitle = parseDateFromTitle(entry && entry.title);
    if (fromTitle) return fromTitle;

    const fromText = parseDateFromText(entry && (entry.summary || entry.text));
    if (fromText) return fromText;

    const fromUrls = parseDateFromUrls((actions || []).map((action) => action && action.url));
    if (fromUrls) return fromUrls;

    const fallbackYear = collapseWhitespace(entry && (entry.summary || entry.text || entry.title)).match(/\b((?:19|20)\d{2})\b/);
    if (fallbackYear) {
      return {
        sortKey: `${fallbackYear[1]}-00-00`,
        label: fallbackYear[1],
        year: fallbackYear[1],
      };
    }

    return {
      sortKey: '0000-00-00',
      label: '',
      year: '',
    };
  }

  function cleanEventName(value) {
    return collapseWhitespace(value)
      .replace(/\.$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function inferMeetingName(entry, sectionTitle, groupTitle, actions) {
    const summary = collapseWhitespace(entry && entry.summary);
    const text = collapseWhitespace(entry && entry.text);
    const title = collapseWhitespace(entry && entry.title);

    if (summary.includes(' @ ')) {
      return cleanEventName(summary.split(' @ ').pop());
    }
    if (text.includes(' @ ')) {
      return cleanEventName(text.split(' @ ').pop());
    }

    const prefixMatch = title.match(/^([^:]+):/);
    if (prefixMatch && /\b((?:19|20)\d{2})\b/.test(prefixMatch[1])) {
      return cleanEventName(
        prefixMatch[1]
          .replace(/\b(Keynote|Talk|Tutorial|Presentation|Workshop)\b/gi, '')
          .replace(/\s{2,}/g, ' ')
      );
    }

    if (slugify(sectionTitle) === 'open-design-meeting-presentations') {
      return 'MLIR Open Design Meeting';
    }

    const eventAction = (actions || []).find((action) => action && action.kind === 'event' && collapseWhitespace(action.label).toLowerCase() !== 'event');
    if (eventAction) return cleanEventName(eventAction.label);

    return cleanTopicLabel(groupTitle) || collapseWhitespace(sectionTitle) || 'MLIR Talk';
  }

  function normalizeSpeakerName(value) {
    const normalized = typeof HubUtils.normalizePersonRecord === 'function'
      ? HubUtils.normalizePersonRecord({ name: value })
      : null;
    const name = collapseWhitespace(normalized && normalized.name ? normalized.name : value);
    return name
      .replace(/\((?:filling in for|moderator|host)[^)]+\)/gi, '')
      .replace(/\b(?:filling in for|moderator|host)\b.*$/gi, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[,;:]+|[,;:]+$/g, '')
      .trim();
  }

  function looksLikePersonName(value) {
    const text = normalizeSpeakerName(value);
    if (!text || /\d/.test(text)) return false;
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 6) return false;
    if (tokens.some((token) => ['by', 'of', 'for', 'in', 'to'].includes(token.toLowerCase()))) return false;
    return tokens.every((token) => {
      const cleaned = token.replace(/^[.'’()-]+|[.'’()-]+$/g, '');
      if (!cleaned) return false;
      return /^[A-Za-zÀ-ÖØ-öø-ÿ]+(?:[.'’-][A-Za-zÀ-ÖØ-öø-ÿ]+)*$/.test(cleaned);
    });
  }

  function looksLikeSpeakerList(value) {
    const text = collapseWhitespace(value);
    if (!text) return false;
    const parts = text.split(/\s*(?:,| and |\/|;)\s*/i).map((part) => normalizeSpeakerName(part)).filter(Boolean);
    if (!parts.length || parts.length > 6) return false;
    return parts.every((part) => looksLikePersonName(part));
  }

  function extractSpeakers(entry, actions) {
    if (Array.isArray(entry && entry.speakers) && entry.speakers.length) {
      return entry.speakers
        .map((speaker) => ({ name: normalizeSpeakerName(speaker && speaker.name), affiliation: collapseWhitespace(speaker && speaker.affiliation) }))
        .filter((speaker) => looksLikePersonName(speaker.name));
    }

    const rawCandidates = [];
    for (const source of [entry && entry.summary, entry && entry.text]) {
      let candidate = collapseWhitespace(source);
      if (!candidate) continue;
      if (candidate.includes(' @ ')) candidate = candidate.split(' @ ')[0];
      if (candidate.includes(';')) candidate = candidate.split(';').pop();
      candidate = candidate
        .replace(/\b(?:slides?|recordings?|recording|transcript|event|talk|part\s+\d+|additional slides?)\b/gi, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (candidate) rawCandidates.push(candidate);
    }
    for (const action of (Array.isArray(actions) ? actions : [])) {
      const label = normalizeSpeakerName(action && action.label);
      if (looksLikePersonName(label)) rawCandidates.push(label);
    }

    const speakers = [];
    const seen = new Set();
    for (const candidate of rawCandidates) {
      const names = candidate.split(/\s*(?:,| and |\/)\s*/i);
      for (const rawName of names) {
        const name = normalizeSpeakerName(rawName);
        const key = name.toLowerCase();
        if (!looksLikePersonName(name) || seen.has(key)) continue;
        seen.add(key);
        speakers.push({ name, affiliation: '' });
      }
      if (speakers.length) break;
    }

    return speakers;
  }

  function stripTalkMetadata(value) {
    return collapseWhitespace(value)
      .replace(/\s+@\s+.+$/, '')
      .replace(RESOURCE_ONLY_RE, ' ')
      .replace(/\s*[-;:,/]\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function buildAbstract(entry, speakers) {
    const explicit = collapseWhitespace(entry && entry.abstract);
    if (explicit) return explicit;

    const title = cleanTalkTitle(entry && entry.title);
    const titleLower = title.toLowerCase();
    const rawCandidates = [
      collapseWhitespace(entry && entry.summary),
      collapseWhitespace(entry && entry.text),
    ];

    for (const raw of rawCandidates) {
      if (!raw) continue;
      let candidate = raw;
      if (title && candidate.toLowerCase().startsWith(titleLower)) {
        candidate = candidate.slice(title.length).trim();
      }
      candidate = stripTalkMetadata(candidate);
      if (!candidate) continue;
      if (looksLikeSpeakerList(candidate)) continue;
      if (Array.isArray(speakers) && speakers.length) {
        const speakerNames = speakers.map((speaker) => normalizeSpeakerName(speaker && speaker.name).toLowerCase());
        if (speakerNames.includes(candidate.toLowerCase())) continue;
      }
      if (candidate.split(/\s+/).length < 4) continue;
      return candidate;
    }

    return '';
  }

  function pickFirstAction(actions, predicate) {
    return (Array.isArray(actions) ? actions : []).find((action) => action && predicate(action)) || null;
  }

  function buildTalkRecord(entry, sectionTitle, groupTitle, fallbackUrl) {
    const actions = Array.isArray(entry && entry.actions)
      ? entry.actions
          .map((action) => ({
            kind: collapseWhitespace(action && action.kind).toLowerCase(),
            label: collapseWhitespace(action && action.label),
            url: sanitizeExternalUrl(action && action.url),
          }))
          .filter((action) => action.url)
      : [];

    const primaryAction = pickFirstAction(actions, (action) => action.kind === 'primary')
      || pickFirstAction(actions, (action) => action.kind === 'slides')
      || pickFirstAction(actions, (action) => action.kind === 'recording')
      || pickFirstAction(actions, (action) => action.kind === 'event')
      || pickFirstAction(actions, (action) => action.kind === 'link')
      || actions[0]
      || null;

    const detailUrl = collapseWhitespace(primaryAction && primaryAction.url) || fallbackUrl;
    const videoAction = pickFirstAction(actions, (action) => action.kind === 'recording')
      || (primaryAction && (primaryAction.kind === 'recording' || typeof HubUtils.extractYouTubeId === 'function' && HubUtils.extractYouTubeId(primaryAction.url))
        ? primaryAction
        : null);
    const slidesAction = pickFirstAction(actions, (action) => action.kind === 'slides');
    const githubAction = pickFirstAction(actions, (action) => /github\.com/i.test(action.url));

    const cleanedTitle = cleanTalkTitle(entry && entry.title) || 'Untitled MLIR Talk';
    const speakers = extractSpeakers(entry, actions);
    const abstract = buildAbstract({ ...entry, title: cleanedTitle }, speakers);
    const meetingName = inferMeetingName({ ...entry, title: cleanedTitle }, sectionTitle, groupTitle, actions);
    const dateInfo = parseDateInfo(entry, actions);
    const sortSuffix = slugify(meetingName || cleanedTitle || entry && entry.id || '').slice(0, 48);
    const meeting = sortSuffix
      ? `${dateInfo.sortKey}-${sortSuffix}`
      : dateInfo.sortKey;

    const topics = uniqueStrings([
      cleanTopicLabel(groupTitle),
      ...(slugify(sectionTitle) === 'open-design-meeting-presentations' ? ['Open Design Meeting'] : []),
    ]);

    return {
      id: collapseWhitespace(entry && entry.id) || slugify(entry && entry.title) || slugify(detailUrl),
      title: cleanedTitle,
      abstract,
      speakers,
      category: SECTION_CATEGORY_MAP[slugify(sectionTitle)] || 'other',
      tags: topics,
      meeting,
      meetingName,
      meetingDate: dateInfo.label,
      meetingLocation: '',
      videoUrl: collapseWhitespace(videoAction && videoAction.url),
      slidesUrl: collapseWhitespace(slidesAction && slidesAction.url),
      projectGithub: collapseWhitespace(githubAction && githubAction.url),
      sourceUrl: detailUrl,
      detailUrl,
      mlirSection: collapseWhitespace(sectionTitle),
      mlirGroup: cleanTopicLabel(groupTitle),
    };
  }

  function transformPayload(payload) {
    const fallbackUrl = sanitizeExternalUrl(payload && payload.sourceUrl);
    const talks = [];

    for (const section of (Array.isArray(payload && payload.sections) ? payload.sections : [])) {
      const sectionTitle = collapseWhitespace(section && section.title);
      const sectionKey = slugify(sectionTitle);
      if (EXCLUDED_SECTION_KEYS.has(sectionKey)) continue;
      for (const group of (Array.isArray(section && section.groups) ? section.groups : [])) {
        const groupTitle = collapseWhitespace(group && group.title);
        for (const entry of (Array.isArray(group && group.entries) ? group.entries : [])) {
          if (!entry || typeof entry !== 'object') continue;
          talks.push(buildTalkRecord(entry, sectionTitle, groupTitle, fallbackUrl));
        }
      }
    }

    return talks.filter((talk) => talk.id && talk.title);
  }

  async function loadMLIRTalks() {
    if (talksPromise) return talksPromise;

    talksPromise = (async () => {
      const response = await fetch(DATA_PATH, { cache: 'default' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      return transformPayload(payload);
    })();

    return talksPromise;
  }

  window.loadEventData = async function loadEventData() {
    return { talks: await loadMLIRTalks() };
  };
})();
