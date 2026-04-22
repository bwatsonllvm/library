/**
 * events-data.js - canonical talks loader with bundle + by-id access.
 */

(function () {
  const MANIFEST_JSON_PATH = 'devmtg/events/index.json';
  const EVENTS_PREFIX = 'devmtg/events/';
  const TALK_REFERENCE_JSON_PATH = 'js/data/talk-paper-links.json';

  let manifestCache = null;
  let manifestLoadPromise = null;
  let fullDataCache = null;
  let fullDataVersion = '';
  let talkReferenceCache = null;
  let talkReferenceLoadPromise = null;

  const bundleCache = new Map();
  const bundleLoadPromises = new Map();

  function normalizeManifest(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error(`${MANIFEST_JSON_PATH}: expected JSON object`);
    }

    const dataVersion = String(payload.dataVersion || '').trim();
    if (!dataVersion) {
      throw new Error(`${MANIFEST_JSON_PATH}: missing \"dataVersion\"`);
    }

    const files = Array.isArray(payload.eventFiles)
      ? payload.eventFiles
      : (Array.isArray(payload.events) ? payload.events.map((event) => event.file || event.path || '') : []);
    if (!files.length) {
      throw new Error(`${MANIFEST_JSON_PATH}: missing non-empty \"eventFiles\"`);
    }

    const eventRefs = files
      .map((file) => String(file || '').trim())
      .filter(Boolean)
      .map((file) => {
        const normalized = file.replace(/^\/+/, '');
        if (normalized.startsWith(EVENTS_PREFIX)) return normalized;
        if (normalized.startsWith('events/')) return `${EVENTS_PREFIX}${normalized.slice('events/'.length)}`;
        return `${EVENTS_PREFIX}${normalized}`;
      });

    for (const ref of eventRefs) {
      if (!ref.toLowerCase().endsWith('.json')) {
        throw new Error(`${MANIFEST_JSON_PATH}: eventFiles must reference .json files (${ref})`);
      }
    }

    return { dataVersion, eventRefs };
  }

  function normalizeEventBundle(payload, sourcePath) {
    if (!payload || typeof payload !== 'object') {
      throw new Error(`${sourcePath}: expected JSON object`);
    }
    if (!Array.isArray(payload.talks)) {
      throw new Error(`${sourcePath}: missing \"talks\" array`);
    }
    return {
      meeting: payload.meeting || null,
      talks: payload.talks,
    };
  }

  async function fetchJson(path) {
    const resp = await fetch(path, { cache: 'default' });
    if (!resp.ok) {
      throw new Error(`${path}: HTTP ${resp.status}`);
    }
    try {
      return await resp.json();
    } catch (err) {
      throw new Error(`${path}: invalid JSON (${err.message})`);
    }
  }

  function normalizeHttpUrl(value) {
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

  async function loadTalkReferenceIndex() {
    if (talkReferenceCache) return talkReferenceCache;
    if (talkReferenceLoadPromise) return talkReferenceLoadPromise;

    talkReferenceLoadPromise = (async () => {
      try {
        const payload = await fetchJson(TALK_REFERENCE_JSON_PATH);
        const talks = payload && typeof payload === 'object' && payload.talks && typeof payload.talks === 'object'
          ? payload.talks
          : {};
        talkReferenceCache = talks;
        return talks;
      } catch {
        talkReferenceCache = {};
        return talkReferenceCache;
      }
    })();

    try {
      return await talkReferenceLoadPromise;
    } finally {
      talkReferenceLoadPromise = null;
    }
  }

  function normalizeGithubRepoUrls(entry) {
    const detailed = Array.isArray(entry && entry.githubReferences)
      ? entry.githubReferences
      : [];
    const detailedUrls = detailed
      .map((item) => normalizeHttpUrl(item && item.url))
      .filter(Boolean);
    if (detailedUrls.length) return [...new Set(detailedUrls)];
    return Array.isArray(entry && entry.githubRepoUrls)
      ? entry.githubRepoUrls.map((value) => normalizeHttpUrl(value)).filter(Boolean)
      : [];
  }

  function normalizeGithubReferenceItems(entry) {
    const rawItems = Array.isArray(entry && entry.githubReferences)
      ? entry.githubReferences
      : [];
    if (rawItems.length) {
      return rawItems
        .map((item) => ({
          url: normalizeHttpUrl(item && item.url),
          source: String(item && item.source || '').trim(),
          label: String(item && item.label || '').trim(),
          context: String(item && item.context || '').trim(),
          library: String(item && item.library || '').trim(),
          repository: String(item && item.repository || '').trim(),
          fileName: String(item && item.fileName || '').trim(),
          filePath: String(item && item.filePath || '').trim(),
          referencePath: String(item && item.referencePath || '').trim(),
        }))
        .filter((item) => item.url);
    }
    return normalizeGithubRepoUrls(entry).map((url) => ({
      url,
      source: '',
      label: '',
      context: '',
      library: '',
      repository: '',
      fileName: '',
      filePath: '',
      referencePath: '',
    }));
  }

  function mergeGithubResourceActions(existingActions, githubUrls) {
    const base = Array.isArray(existingActions)
      ? existingActions
          .map((action) => ({
            kind: String(action && action.kind || '').trim(),
            label: String(action && action.label || '').trim(),
            url: normalizeHttpUrl(action && action.url),
          }))
          .filter((action) => action.url)
      : [];
    const seenUrls = new Set(base.map((action) => action.url));
    let githubCount = 0;
    for (const value of (Array.isArray(githubUrls) ? githubUrls : [])) {
      const url = normalizeHttpUrl(value);
      if (!url || seenUrls.has(url)) continue;
      githubCount += 1;
      seenUrls.add(url);
      base.push({
        kind: 'github',
        label: githubCount === 1 ? 'GitHub' : `GitHub ${githubCount}`,
        url,
      });
    }
    return base;
  }

  function applyReferenceMetadataToTalk(talk, referenceIndex) {
    if (!talk || typeof talk !== 'object') return talk;
    const talkId = normalizeTalkId(talk.id);
    if (!talkId || !referenceIndex || typeof referenceIndex !== 'object') return talk;
    const referenceEntry = referenceIndex[talkId];
    const githubReferenceItems = normalizeGithubReferenceItems(referenceEntry);
    const githubUrls = normalizeGithubRepoUrls(referenceEntry);
    if (!githubUrls.length && !githubReferenceItems.length) return talk;

    const enriched = { ...talk };
    if (!String(enriched.projectGithub || '').trim()) {
      enriched.projectGithub = githubUrls[0];
    }
    enriched.githubReferences = githubUrls;
    enriched.githubReferenceItems = githubReferenceItems;
    const mergedActions = mergeGithubResourceActions(enriched.resourceActions, githubUrls);
    if (mergedActions.length) {
      enriched.resourceActions = mergedActions;
    }
    return enriched;
  }

  function resetCachesForVersionChange() {
    fullDataCache = null;
    fullDataVersion = '';
    bundleCache.clear();
    bundleLoadPromises.clear();
  }

  async function loadManifest() {
    if (manifestCache) return manifestCache;
    if (manifestLoadPromise) return manifestLoadPromise;

    manifestLoadPromise = (async () => {
      const payload = await fetchJson(MANIFEST_JSON_PATH);
      const manifest = normalizeManifest(payload);
      if (fullDataVersion && fullDataVersion !== manifest.dataVersion) {
        resetCachesForVersionChange();
      }
      manifestCache = manifest;
      return manifest;
    })();

    try {
      return await manifestLoadPromise;
    } finally {
      manifestLoadPromise = null;
    }
  }

  async function loadEventBundle(path) {
    const key = String(path || '').trim();
    if (!key) return null;
    if (bundleCache.has(key)) return bundleCache.get(key);
    if (bundleLoadPromises.has(key)) return bundleLoadPromises.get(key);

    const promise = (async () => {
      const payload = await fetchJson(key);
      const bundle = normalizeEventBundle(payload, key);
      bundleCache.set(key, bundle);
      return bundle;
    })();

    bundleLoadPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      bundleLoadPromises.delete(key);
    }
  }

  function normalizeTalkId(value) {
    return String(value || '').trim();
  }

  function findTalkById(talks, talkId) {
    const target = normalizeTalkId(talkId);
    if (!target || !Array.isArray(talks)) return null;
    for (const talk of talks) {
      if (!talk || typeof talk !== 'object') continue;
      if (normalizeTalkId(talk.id) === target) return talk;
    }
    return null;
  }

  function resolveRefByTalkId(talkId, eventRefs) {
    const id = normalizeTalkId(talkId);
    if (!id) return '';
    const match = id.match(/^(\d{4}-\d{2})-\d+$/);
    if (!match) return '';
    const candidate = `${EVENTS_PREFIX}${match[1]}.json`;
    return Array.isArray(eventRefs) && eventRefs.includes(candidate) ? candidate : '';
  }

  async function loadEventData() {
    const manifest = await loadManifest();
    if (fullDataCache && fullDataVersion === manifest.dataVersion) {
      return fullDataCache;
    }
    const talkReferenceIndex = await loadTalkReferenceIndex();

    const bundles = await Promise.all(
      manifest.eventRefs.map(async (ref) => {
        const bundle = await loadEventBundle(ref);
        return bundle || { meeting: null, talks: [] };
      })
    );

    const talks = [];
    const meetings = [];
    for (const bundle of bundles) {
      const bundleTalks = Array.isArray(bundle.talks)
        ? bundle.talks.map((talk) => applyReferenceMetadataToTalk(talk, talkReferenceIndex))
        : [];
      talks.push(...bundleTalks);
      if (bundle.meeting) meetings.push(bundle.meeting);
    }

    fullDataCache = { talks, meetings };
    fullDataVersion = manifest.dataVersion;
    return fullDataCache;
  }

  async function loadTalkRecordById(talkId) {
    const target = normalizeTalkId(talkId);
    if (!target) return null;

    const manifest = await loadManifest();
    const talkReferenceIndex = await loadTalkReferenceIndex();

    if (fullDataCache && fullDataVersion === manifest.dataVersion) {
      const cached = findTalkById(fullDataCache.talks, target);
      if (cached) {
        return {
          talk: cached,
          talks: fullDataCache.talks,
          meeting: null,
          dataVersion: manifest.dataVersion,
        };
      }
    }

    const refs = Array.isArray(manifest.eventRefs) ? manifest.eventRefs : [];
    const prioritized = resolveRefByTalkId(target, refs);
    const orderedRefs = prioritized ? [prioritized, ...refs.filter((ref) => ref !== prioritized)] : refs;

    for (const ref of orderedRefs) {
      const bundle = await loadEventBundle(ref);
      if (!bundle) continue;
      const bundleTalks = Array.isArray(bundle.talks)
        ? bundle.talks.map((talk) => applyReferenceMetadataToTalk(talk, talkReferenceIndex))
        : [];
      const match = findTalkById(bundleTalks, target);
      if (match) {
        return {
          talk: match,
          talks: bundleTalks,
          meeting: bundle.meeting || null,
          dataVersion: manifest.dataVersion,
        };
      }
    }

    return null;
  }

  window.loadEventData = loadEventData;
  window.loadTalkRecordById = loadTalkRecordById;
})();
