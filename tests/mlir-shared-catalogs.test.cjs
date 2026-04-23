const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

function loadJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'));
}

function hasMlirTopic(record) {
  const values = [
    ...(Array.isArray(record && record.tags) ? record.tags : []),
    ...(Array.isArray(record && record.keywords) ? record.keywords : []),
    ...(Array.isArray(record && record.matchedSubprojects) ? record.matchedSubprojects : []),
  ];
  return values.some((value) => String(value || '').trim().toLowerCase() === 'mlir');
}

test('shared talks catalog includes curated MLIR-only talks', () => {
  const talksCatalog = loadJson('js/data/talks-catalog.json');
  const workSearchCorpus = loadJson('js/data/work-search-corpus.json');
  const title = 'How to Build your own MLIR Dialect';

  const talk = (Array.isArray(talksCatalog.talks) ? talksCatalog.talks : [])
    .find((entry) => String(entry && entry.title || '').trim() === title);

  assert.ok(talk, `Expected "${title}" in js/data/talks-catalog.json`);
  assert.equal(hasMlirTopic(talk), true, 'Curated MLIR talk should carry an MLIR topic tag');
  assert.equal(
    (Array.isArray(workSearchCorpus.talks) ? workSearchCorpus.talks : []).some((entry) => String(entry && entry.id || '').trim() === String(talk.id || '').trim()),
    true,
    'Curated MLIR talk should be present in js/data/work-search-corpus.json'
  );
});

test('shared papers catalog keeps MLIR publications in universal search data', () => {
  const papersCatalog = loadJson('js/data/papers-catalog.json');
  const workSearchCorpus = loadJson('js/data/work-search-corpus.json');
  const title = 'MLIR: Scaling Compiler Infrastructure for Domain Specific Computation';

  const paper = (Array.isArray(papersCatalog.papers) ? papersCatalog.papers : [])
    .find((entry) => String(entry && entry.title || '').trim() === title);

  assert.ok(paper, `Expected "${title}" in js/data/papers-catalog.json`);
  assert.equal(hasMlirTopic(paper), true, 'MLIR publication should carry an MLIR topic tag');
  assert.equal(
    (Array.isArray(workSearchCorpus.papers) ? workSearchCorpus.papers : []).some((entry) => String(entry && entry.id || '').trim() === String(paper.id || '').trim()),
    true,
    'MLIR publication should be present in js/data/work-search-corpus.json'
  );
});
