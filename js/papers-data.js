/**
 * papers-data.js - canonical paper data loader with bundle + by-id access.
 */

(function () {
  const root = typeof window !== 'undefined' ? window : globalThis;
  const MANIFEST_JSON_CANDIDATES = ['../papers/index.json', 'papers/index.json', './papers/index.json'];
  const VIEWER_ARTIFACTS_MANIFEST_PATH = 'js/data/viewer-artifacts.json?v=74dcceb75eac';

  let manifestCache = null;
  let manifestLoadPromise = null;
  let fullDataCache = null;
  let fullDataVersion = '';

  const bundleCache = new Map();
  const bundleLoadPromises = new Map();
  let viewerCatalogCache = null;
  let viewerCatalogLoadPromise = null;
  let viewerRelatedCache = null;
  let viewerRelatedLoadPromise = null;

  function uniquePaths(paths) {
    return [...new Set((Array.isArray(paths) ? paths : []).map((p) => String(p || '').trim()).filter(Boolean))];
  }

  function resolveUrl(ref, baseRef) {
    const raw = String(ref || '').trim();
    if (!raw) return '';
    try {
      return new URL(raw, baseRef || document.baseURI || window.location.href).toString();
    } catch {
      return raw;
    }
  }

  function normalizeManifest(payload, manifestRef) {
    const label = String(manifestRef || 'papers/index.json');
    if (!payload || typeof payload !== 'object') {
      throw new Error(`${label}: expected JSON object`);
    }

    const dataVersion = String(payload.dataVersion || '').trim();
    if (!dataVersion) {
      throw new Error(`${label}: missing \"dataVersion\"`);
    }

    const files = Array.isArray(payload.paperFiles)
      ? payload.paperFiles
      : (Array.isArray(payload.files) ? payload.files : []);
    if (!files.length) {
      throw new Error(`${label}: missing non-empty \"paperFiles\"`);
    }

    const manifestUrl = new URL(label, document.baseURI || window.location.href);
    const paperRefs = files
      .map((file) => String(file || '').trim())
      .filter(Boolean)
      .map((file) => {
        let normalized = file;
        if (normalized.startsWith('../papers/')) normalized = normalized.slice('../papers/'.length);
        else if (normalized.startsWith('papers/')) normalized = normalized.slice('papers/'.length);
        return new URL(normalized, manifestUrl).toString();
      });

    for (const ref of paperRefs) {
      if (!new URL(ref, window.location.href).pathname.toLowerCase().endsWith('.json')) {
        throw new Error(`${label}: paperFiles must reference .json files (${ref})`);
      }
    }

    return { dataVersion, paperRefs };
  }

  function normalizePaperBundle(payload, sourcePath) {
    if (!payload || typeof payload !== 'object') {
      throw new Error(`${sourcePath}: expected JSON object`);
    }
    if (!Array.isArray(payload.papers)) {
      throw new Error(`${sourcePath}: missing \"papers\" array`);
    }
    return {
      source: payload.source || null,
      papers: payload.papers,
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

  function computeShardKey(id, shardCount) {
    const text = String(id || '').trim();
    const count = Number.parseInt(String(shardCount || ''), 10);
    if (!text || !Number.isFinite(count) || count <= 0) return '';
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash * 31) + text.charCodeAt(index)) >>> 0;
    }
    return (hash % count).toString(16).padStart(2, '0');
  }

  function ensureViewerArtifactHelpers() {
    if (
      typeof root.loadViewerArtifactsManifest === 'function'
      && typeof root.loadViewerArtifactJson === 'function'
      && typeof root.resolveViewerArtifactShardUrl === 'function'
    ) {
      return;
    }

    const state = root.__LLVMViewerArtifactsState || (root.__LLVMViewerArtifactsState = {
      manifestCache: null,
      manifestPromise: null,
      jsonCache: new Map(),
      jsonPromises: new Map(),
    });

    root.loadViewerArtifactsManifest = async function loadViewerArtifactsManifest() {
      if (state.manifestCache) return state.manifestCache;
      if (state.manifestPromise) return state.manifestPromise;
      state.manifestPromise = (async () => {
        const payload = await fetchJson(VIEWER_ARTIFACTS_MANIFEST_PATH);
        if (!payload || typeof payload !== 'object') {
          throw new Error(`${VIEWER_ARTIFACTS_MANIFEST_PATH}: expected JSON object`);
        }
        if (!payload.files || typeof payload.files !== 'object') {
          throw new Error(`${VIEWER_ARTIFACTS_MANIFEST_PATH}: missing "files" object`);
        }
        if (!payload.shards || typeof payload.shards !== 'object') {
          throw new Error(`${VIEWER_ARTIFACTS_MANIFEST_PATH}: missing "shards" object`);
        }
        state.manifestCache = payload;
        return payload;
      })();

      try {
        return await state.manifestPromise;
      } finally {
        state.manifestPromise = null;
      }
    };

    root.loadViewerArtifactJson = async function loadViewerArtifactJson(key) {
      const artifactKey = String(key || '').trim();
      if (!artifactKey) throw new Error('Artifact key is required');
      if (state.jsonCache.has(artifactKey)) return state.jsonCache.get(artifactKey);
      if (state.jsonPromises.has(artifactKey)) return state.jsonPromises.get(artifactKey);

      const promise = (async () => {
        const manifest = await root.loadViewerArtifactsManifest();
        const ref = manifest && manifest.files ? manifest.files[artifactKey] : '';
        if (!ref) throw new Error(`viewer-artifacts.json: missing file entry "${artifactKey}"`);
        const payload = await fetchJson(ref);
        state.jsonCache.set(artifactKey, payload);
        return payload;
      })();

      state.jsonPromises.set(artifactKey, promise);
      try {
        return await promise;
      } finally {
        state.jsonPromises.delete(artifactKey);
      }
    };

    root.resolveViewerArtifactShardUrl = async function resolveViewerArtifactShardUrl(group, id) {
      const shardGroup = String(group || '').trim();
      const recordId = String(id || '').trim();
      if (!shardGroup || !recordId) return '';
      const manifest = await root.loadViewerArtifactsManifest();
      const shardConfig = manifest && manifest.shards ? manifest.shards[shardGroup] : null;
      if (!shardConfig || typeof shardConfig !== 'object') {
        throw new Error(`viewer-artifacts.json: missing shard entry "${shardGroup}"`);
      }
      const shardKey = computeShardKey(recordId, shardConfig.shardCount);
      if (!shardKey) return '';
      return String(shardConfig.template || '').replace('{shard}', shardKey);
    };
  }

  ensureViewerArtifactHelpers();

  async function fetchJsonWithMeta(path) {
    const resp = await fetch(path, { cache: 'default' });
    if (!resp.ok) {
      throw new Error(`${path}: HTTP ${resp.status}`);
    }
    try {
      return { payload: await resp.json(), url: String(resp.url || path) };
    } catch (err) {
      throw new Error(`${path}: invalid JSON (${err.message})`);
    }
  }

  function resetCachesForVersionChange() {
    fullDataCache = null;
    fullDataVersion = '';
    bundleCache.clear();
    bundleLoadPromises.clear();
  }

  async function loadViewerPaperCatalog() {
    if (viewerCatalogCache) return viewerCatalogCache;
    if (viewerCatalogLoadPromise) return viewerCatalogLoadPromise;

    viewerCatalogLoadPromise = (async () => {
      const payload = await root.loadViewerArtifactJson('papersCatalog');
      if (!payload || typeof payload !== 'object') return null;
      viewerCatalogCache = {
        papers: Array.isArray(payload.papers) ? payload.papers : [],
        sources: Array.isArray(payload.sources) ? payload.sources : [],
        filters: payload.filters && typeof payload.filters === 'object' ? payload.filters : {},
        autocomplete: payload.autocomplete && typeof payload.autocomplete === 'object' ? payload.autocomplete : {},
        dataVersion: String(payload.dataVersion || '').trim(),
      };
      return viewerCatalogCache;
    })();

    try {
      return await viewerCatalogLoadPromise;
    } finally {
      viewerCatalogLoadPromise = null;
    }
  }

  async function loadViewerPaperRelatedIndex() {
    if (viewerRelatedCache) return viewerRelatedCache;
    if (viewerRelatedLoadPromise) return viewerRelatedLoadPromise;

    viewerRelatedLoadPromise = (async () => {
      const payload = await root.loadViewerArtifactJson('paperRelated');
      const byPaperId = payload && typeof payload === 'object' && payload.byPaperId && typeof payload.byPaperId === 'object'
        ? payload.byPaperId
        : {};
      viewerRelatedCache = byPaperId;
      return byPaperId;
    })();

    try {
      return await viewerRelatedLoadPromise;
    } finally {
      viewerRelatedLoadPromise = null;
    }
  }

  async function loadManifest() {
    if (manifestCache) return manifestCache;
    if (manifestLoadPromise) return manifestLoadPromise;

    manifestLoadPromise = (async () => {
      const candidates = uniquePaths(MANIFEST_JSON_CANDIDATES);
      const failures = [];
      const baseRef = document.baseURI || window.location.href;

      for (const manifestRef of candidates) {
        try {
          const manifestUrl = resolveUrl(manifestRef, baseRef);
          const { payload, url } = await fetchJsonWithMeta(manifestUrl || manifestRef);
          const manifest = normalizeManifest(payload, url || manifestUrl || manifestRef);
          if (fullDataVersion && fullDataVersion !== manifest.dataVersion) {
            resetCachesForVersionChange();
          }
          manifestCache = manifest;
          return manifest;
        } catch (err) {
          failures.push(String(err && err.message ? err.message : err));
        }
      }

      throw new Error(`Could not load papers manifest from ${candidates.join(', ')} (${failures.join(' | ')})`);
    })();

    try {
      return await manifestLoadPromise;
    } finally {
      manifestLoadPromise = null;
    }
  }

  async function loadPaperBundle(path) {
    const key = String(path || '').trim();
    if (!key) return null;
    if (bundleCache.has(key)) return bundleCache.get(key);
    if (bundleLoadPromises.has(key)) return bundleLoadPromises.get(key);

    const promise = (async () => {
      const payload = await fetchJson(key);
      const bundle = normalizePaperBundle(payload, key);
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

  function findPaperById(papers, paperId) {
    const target = String(paperId || '').trim();
    if (!target || !Array.isArray(papers)) return null;
    for (const paper of papers) {
      if (!paper || typeof paper !== 'object') continue;
      if (String(paper.id || '').trim() === target) return paper;
    }
    return null;
  }

  function scoreRefForPaperId(path, paperId) {
    const ref = String(path || '').toLowerCase();
    const id = String(paperId || '').trim().toLowerCase();
    if (!id) return 0;
    if (id.startsWith('blog-') && ref.includes('blog')) return 300;
    if ((id.startsWith('manual-') || id.startsWith('doi-')) && ref.includes('manual')) return 280;
    if (id.startsWith('pubs-') && ref.includes('pubs')) return 260;
    if (id.startsWith('openalex-') && ref.includes('openalex')) return 240;
    if (ref.includes('combined-all-papers-deduped')) return 220;
    if (ref.includes('combined')) return 200;
    return 0;
  }

  function orderRefsForPaperId(paperRefs, paperId) {
    const refs = Array.isArray(paperRefs) ? [...paperRefs] : [];
    refs.sort((a, b) => {
      const scoreDiff = scoreRefForPaperId(b, paperId) - scoreRefForPaperId(a, paperId);
      if (scoreDiff !== 0) return scoreDiff;
      return String(a).localeCompare(String(b));
    });
    return refs;
  }

  async function loadPaperData() {
    try {
      const catalog = await loadViewerPaperCatalog();
      if (catalog && fullDataCache && fullDataVersion === catalog.dataVersion) {
        return fullDataCache;
      }
      if (catalog) {
        fullDataCache = {
          papers: catalog.papers,
          sources: catalog.sources,
          filters: catalog.filters,
          autocomplete: catalog.autocomplete,
        };
        fullDataVersion = catalog.dataVersion;
        return fullDataCache;
      }
    } catch {
      // Fall back to canonical raw manifests below.
    }

    const manifest = await loadManifest();
    if (fullDataCache && fullDataVersion === manifest.dataVersion) {
      return fullDataCache;
    }

    const bundles = await Promise.all(
      manifest.paperRefs.map(async (ref) => {
        const bundle = await loadPaperBundle(ref);
        return bundle || { source: null, papers: [] };
      })
    );

    const papers = [];
    const sources = [];
    for (const bundle of bundles) {
      papers.push(...(Array.isArray(bundle.papers) ? bundle.papers : []));
      if (bundle.source) sources.push(bundle.source);
    }

    fullDataCache = { papers, sources };
    fullDataVersion = manifest.dataVersion;
    return fullDataCache;
  }

  async function loadPaperRecordById(paperId) {
    const target = String(paperId || '').trim();
    if (!target) return null;

    try {
      const detailRef = await root.resolveViewerArtifactShardUrl('paperDetails', target);
      if (detailRef) {
        const payload = await fetchJson(detailRef);
        const papers = payload && payload.papers && typeof payload.papers === 'object' ? payload.papers : {};
        const entry = papers[target];
        if (entry && typeof entry === 'object' && entry.paper && typeof entry.paper === 'object') {
          let related = null;
          try {
            const relatedIndex = await loadViewerPaperRelatedIndex();
            related = relatedIndex && relatedIndex[target] && typeof relatedIndex[target] === 'object'
              ? relatedIndex[target]
              : null;
          } catch {
            related = null;
          }
          return {
            paper: entry.paper,
            papers: [entry.paper],
            source: entry.paper.source || null,
            dataVersion: String(payload && payload.dataVersion || '').trim(),
            related,
          };
        }
      }
    } catch {
      // Fall back to canonical raw manifests below.
    }

    const manifest = await loadManifest();

    if (fullDataCache && fullDataVersion === manifest.dataVersion) {
      const cached = findPaperById(fullDataCache.papers, target);
      if (cached) {
        return {
          paper: cached,
          papers: fullDataCache.papers,
          source: null,
          dataVersion: manifest.dataVersion,
        };
      }
    }

    const orderedRefs = orderRefsForPaperId(manifest.paperRefs, target);
    for (const ref of orderedRefs) {
      const bundle = await loadPaperBundle(ref);
      if (!bundle) continue;
      const match = findPaperById(bundle.papers, target);
      if (match) {
        return {
          paper: match,
          papers: bundle.papers,
          source: bundle.source || null,
          dataVersion: manifest.dataVersion,
        };
      }
    }

    return null;
  }

  root.loadPaperData = loadPaperData;
  root.loadPaperRecordById = loadPaperRecordById;
})();
