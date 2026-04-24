#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const repoRoot = process.cwd();
const catalogPath = path.join(repoRoot, 'js/data/talks-catalog.json');
const defaultOutputPath = path.join(repoRoot, 'js/data/youtube-view-counts.json');

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

const refresh = args.get('refresh') === 'true';
const limit = Number(args.get('limit') || 0);
const concurrency = Math.max(1, Math.min(8, Number(args.get('concurrency') || 4)));
const timeoutMs = Math.max(5000, Number(args.get('timeout-ms') || 20000));
const delayMs = Math.max(0, Number(args.get('delay-ms') || 100));
const outputPath = path.resolve(repoRoot, args.get('output') || defaultOutputPath);

function isYouTubeVideoId(value) {
  return /^[A-Za-z0-9_-]{11}$/.test(String(value || '').trim());
}

function extractViewCount(html) {
  const patterns = [
    /"viewCount"\s*:\s*"(\d+)"/,
    /"viewCount"\s*:\s*(\d+)/,
    /"view_count"\s*:\s*"(\d+)"/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;
    const count = Number(match[1]);
    if (Number.isFinite(count) && count >= 0) return Math.round(count);
  }
  return 0;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeOutput(counts, failures) {
  const generatedAt = new Date().toISOString();
  const payload = {
    generatedAt,
    source: 'YouTube viewCount snapshot',
    counts: Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b))),
    failures: Object.fromEntries([...failures.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchReturnYouTubeDislikeViewCount(videoId) {
  const url = `https://returnyoutubedislikeapi.com/votes?videoId=${encodeURIComponent(videoId)}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      'accept': 'application/json',
      'user-agent': 'Mozilla/5.0 (compatible; LLVMResearchLibrary/1.0; +https://llvm.org/)',
    },
  });
  if (!response.ok) throw new Error(`returnyoutubedislikeapi HTTP ${response.status}`);
  const payload = await response.json();
  const viewCount = Number(payload && payload.viewCount);
  if (!Number.isFinite(viewCount) || viewCount <= 0) {
    throw new Error('returnyoutubedislikeapi viewCount not found');
  }
  return {
    viewCount: Math.round(viewCount),
    fetchedAt: new Date().toISOString(),
    source: 'returnyoutubedislikeapi viewCount',
    sourceUrl: url,
  };
}

async function fetchYouTubeWatchPageViewCount(videoId) {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (compatible; LLVMResearchLibrary/1.0; +https://llvm.org/)',
    },
  });
  if (!response.ok) throw new Error(`youtube watch page HTTP ${response.status}`);
  const html = await response.text();
  const viewCount = extractViewCount(html);
  if (!viewCount) throw new Error('youtube watch page viewCount not found');
  return {
    viewCount,
    fetchedAt: new Date().toISOString(),
    source: 'YouTube watch page viewCount',
    sourceUrl: url,
  };
}

async function fetchViewCount(videoId) {
  const errors = [];
  for (const fetcher of [fetchReturnYouTubeDislikeViewCount, fetchYouTubeWatchPageViewCount]) {
    try {
      return await fetcher(videoId);
    } catch (err) {
      errors.push(String(err && err.message || err));
    }
  }
  throw new Error(errors.join('; '));
}

async function main() {
  const catalog = await readJson(catalogPath, {});
  const talks = Array.isArray(catalog) ? catalog : Array.isArray(catalog.talks) ? catalog.talks : [];
  const videoIds = [...new Set(talks.map((talk) => String(talk && talk.videoId || '').trim()).filter(isYouTubeVideoId))];
  const existing = await readJson(outputPath, { counts: {}, failures: {} });
  const counts = new Map(Object.entries(existing.counts || {}));
  const failures = new Map(Object.entries(existing.failures || {}));

  let pending = refresh
    ? videoIds
    : videoIds.filter((videoId) => {
        const entry = counts.get(videoId);
        return !(entry && Number(entry.viewCount || entry) > 0);
      });
  if (limit > 0) pending = pending.slice(0, limit);

  console.log(`YouTube IDs: ${videoIds.length}. Fetching: ${pending.length}. Concurrency: ${concurrency}.`);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < pending.length) {
      const videoId = pending[nextIndex];
      nextIndex += 1;
      try {
        const entry = await fetchViewCount(videoId);
        counts.set(videoId, entry);
        failures.delete(videoId);
      } catch (err) {
        failures.set(videoId, String(err && err.message || err));
      }
      completed += 1;
      if (completed % 25 === 0 || completed === pending.length) {
        await writeOutput(counts, failures);
        console.log(`Fetched ${completed}/${pending.length}; counts: ${counts.size}; failures: ${failures.size}`);
      }
      await delay(delayMs);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  await writeOutput(counts, failures);
  console.log(`Done. Counts: ${counts.size}. Failures: ${failures.size}. Wrote ${path.relative(repoRoot, outputPath)}.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
