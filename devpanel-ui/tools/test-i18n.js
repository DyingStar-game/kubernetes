'use strict';

/*
 * Translations: both languages hold the same keys with the same placeholders, and every key the
 * code or the page asks for exists.
 *
 *   node tools/test-i18n.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const en = JSON.parse(read('src/i18n/en.json'));
const fr = JSON.parse(read('src/i18n/fr.json'));

let passed = 0;
let failed = 0;

function test(title, fn) {
  try {
    fn();
    passed += 1;
    console.log('  OK    ' + title);
  } catch (err) {
    failed += 1;
    console.log('  FAIL  ' + title);
    console.log('        ' + (err && err.message));
  }
}

const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('both languages hold exactly the same keys', () => {
  const onlyEn = Object.keys(en).filter((k) => !(k in fr));
  const onlyFr = Object.keys(fr).filter((k) => !(k in en));
  assert.deepStrictEqual({ onlyEn, onlyFr }, { onlyEn: [], onlyFr: [] });
});

test('no text is empty, and a text uses the same placeholders in both languages', () => {
  for (const key of Object.keys(en)) {
    assert.ok(String(en[key]).trim() && String(fr[key]).trim(), key + ' is empty');
    assert.deepStrictEqual(placeholders(fr[key]), placeholders(en[key]), key + ': placeholders differ');
  }
});

test('every key the page asks for exists', () => {
  const html = read('src/renderer/index.html');
  const keys = [...html.matchAll(/data-i18n(?:-html|-title|-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 40, 'the page should carry its keys');
  const missing = [...new Set(keys)].filter((k) => !(k in en));
  assert.deepStrictEqual(missing, []);
});

test('every key the code asks for exists', () => {
  const files = ['src/renderer/app.js', 'src/renderer/setup.js', 'src/main/main.js', 'src/main/services.js',
    'src/main/probes.js', 'src/main/npc.js', 'src/main/telepresence.js', 'src/main/network.js'];
  const missing = [];
  let seen = 0;
  for (const file of files) {
    for (const m of read(file).matchAll(/\bt\('([A-Za-z0-9_.-]+)'/g)) {
      seen += 1;
      // A key built at run time ("step." + id) ends with its dot; the test below covers those.
      if (m[1].endsWith('.')) continue;
      if (!(m[1] in en)) missing.push(file + ': ' + m[1]);
    }
  }
  assert.ok(seen > 80, 'expected many t() calls, saw ' + seen);
  assert.deepStrictEqual(missing, []);
});

test('every step of the start chain has a name', () => {
  const { STEPS } = require('../src/main/services');
  for (const step of STEPS) assert.ok(('step.' + step.id) in en, 'step.' + step.id);
});

test('nothing is translated that is never used', () => {
  const sources = ['src/renderer/app.js', 'src/renderer/setup.js', 'src/renderer/index.html',
    'src/renderer/i18n.js', 'src/main/main.js',
    'src/main/services.js', 'src/main/probes.js', 'src/main/npc.js', 'src/main/telepresence.js',
    'src/main/network.js']
    .map(read).join('\n');
  const unused = Object.keys(en).filter((k) => !k.startsWith('step.') && !k.startsWith('set.') && !sources.includes(k));
  assert.deepStrictEqual(unused, []);
});

test('every set of services has its name and its help, in both languages', () => {
  const { SET_IDS } = require('../src/main/modules');
  for (const id of SET_IDS) {
    for (const part of ['name', 'help']) {
      assert.ok(('set.' + id + '.' + part) in en && ('set.' + id + '.' + part) in fr, 'set.' + id + '.' + part);
    }
  }
});

test('t() fills placeholders and never throws on a missing key', () => {
  const i18n = require('../src/main/i18n');
  i18n.setLanguage('fr');
  assert.strictEqual(i18n.t('probe.podsReady', { ready: 3, total: 5 }), '3/5 prêts');
  i18n.setLanguage('en');
  assert.strictEqual(i18n.t('probe.podsReady', { ready: 3, total: 5 }), '3/5 ready');
  assert.strictEqual(i18n.t('no.such.key'), 'no.such.key');
  i18n.setLanguage('zz');
  assert.strictEqual(i18n.language(), 'en', 'an unknown language falls back to English');
});

console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed.');
process.exit(failed ? 1 : 0);
