#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const repoRoot = process.cwd();
const defaultCatalogPath = path.join(repoRoot, 'js/data/talks-catalog.json');
const defaultOutputPath = path.join(repoRoot, '_site/api/youtube-view-counts.json');
const youtubeVideosEndpoint = 'https://www.googleapis.com/youtube/v3/videos';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const [key, inlineValue] = arg.slice(2).split('=', 2);
  if (inlineValue !== undefined) {
    args.set(key, inlineValue);
  } else if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    args.set(key, process.argv[i + 1]);
    i += 1;
  } else {
    args.set(key, 'true');
  }
}

const apiKey = String(args.get('api-key') || process.env.YOUTUBE_API_KEY || '').trim();
const catalogPath = path.resolve(repoRoot, args.get('catalog') || defaultCatalogPath);
const outputPath = path.resolve(repoRoot, args.get('output') || defaultOutputPath);
const batchSize = Math.max(1, Math.min(50, Number(args.get('batch-size') || 50)));
const timeoutMs = Math.max(5000, Number(args.get('timeout-ms') || 20000));
const delayMs = Math.max(0, Number(args.get('delay-ms') || 0));
const cacheMaxAgeSeconds = Math.max(300, Number(args.get('cache-max-age') || 21600));

function isYouTubeVideoId(value) {
  return /^[A-Za-z0-9_-]{11}$/.test(String(value || '').trim());
}

function extractYouTubeId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (isYouTubeVideoId(raw)) return raw;

  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0] || '';
      return isYouTubeVideoId(id) ? id : '';
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com') {
      const watchId = url.searchParams.get('v') || '';
      if (isYouTubeVideoId(watchId)) return watchId;

      const parts = url.pathname.split('/').filter(Boolean);
      const markerIndex = parts.findIndex((part) => ['embed', 'shorts', 'live'].includes(part));
      const id = markerIndex >= 0 ? parts[markerIndex + 1] || '' : '';
      return isYouTubeVideoId(id) ? id : '';
    }
  } catch {
    return '';
  }

  return '';
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function collectYouTubeIds(talks) {
  const ids = new Set();
  for (const talk of talks || []) {
    const explicitId = extractYouTubeId(talk && talk.videoId);
    if (explicitId) ids.add(explicitId);

    const videoUrlId = extractYouTubeId(talk && talk.videoUrl);
    if (videoUrlId) ids.add(videoUrlId);

    for (const action of talk && Array.isArray(talk.resourceActions) ? talk.resourceActions : []) {
      const actionId = extractYouTubeId(action && (action.url || action.href));
      if (actionId) ids.add(actionId);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'LLVMResearchLibrary/1.0 (+https://llvm.org/devmtg/)',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYouTubeStatisticsBatch(videoIds) {
  const url = new URL(youtubeVideosEndpoint);
  url.searchParams.set('part', 'statistics');
  url.searchParams.set('id', videoIds.join(','));
  url.searchParams.set('fields', 'items(id,statistics/viewCount)');
  url.searchParams.set('key', apiKey);

  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`YouTube Data API HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`);
  }

  const payload = await response.json();
  const counts = new Map();
  for (const item of Array.isArray(payload && payload.items) ? payload.items : []) {
    const id = String(item && item.id || '').trim();
    const viewCount = Number(item && item.statistics && item.statistics.viewCount);
    if (isYouTubeVideoId(id) && Number.isFinite(viewCount) && viewCount >= 0) {
      counts.set(id, Math.round(viewCount));
    }
  }
  return counts;
}

async function writeEndpointPayload({ counts, failures, totalVideoIds }) {
  const generatedAt = new Date().toISOString();
  const countEntries = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));

  const payload = {
    generatedAt,
    source: 'YouTube Data API v3 videos.list statistics',
    cache: {
      recommendedMaxAgeSeconds: cacheMaxAgeSeconds,
    },
    totalVideoIds,
    countVideoIds: counts.size,
    counts: Object.fromEntries(countEntries),
    failures: Object.fromEntries([...failures.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  if (!apiKey) {
    throw new Error('YOUTUBE_API_KEY is required to build the YouTube view-count endpoint');
  }

  const catalog = await readJson(catalogPath);
  const talks = Array.isArray(catalog) ? catalog : Array.isArray(catalog && catalog.talks) ? catalog.talks : [];
  const videoIds = collectYouTubeIds(talks);
  const counts = new Map();
  const failures = new Map();
  const batches = chunk(videoIds, batchSize);

  console.log(`YouTube IDs: ${videoIds.length}. Batches: ${batches.length}.`);

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    try {
      const batchCounts = await fetchYouTubeStatisticsBatch(batch);
      for (const [videoId, count] of batchCounts.entries()) counts.set(videoId, count);
      for (const videoId of batch) {
        if (!batchCounts.has(videoId)) failures.set(videoId, 'not returned by YouTube Data API');
      }
    } catch (err) {
      const message = String(err && err.message || err);
      for (const videoId of batch) failures.set(videoId, message);
    }

    if ((i + 1) % 10 === 0 || i + 1 === batches.length) {
      console.log(`Fetched ${i + 1}/${batches.length} batches; counts: ${counts.size}; failures: ${failures.size}`);
    }
    if (delayMs && i + 1 < batches.length) await delay(delayMs);
  }

  await writeEndpointPayload({ counts, failures, totalVideoIds: videoIds.length });
  console.log(`Wrote ${path.relative(repoRoot, outputPath)}.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
