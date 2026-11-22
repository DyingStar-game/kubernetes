'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Translations of everything the WINDOW shows.
 *
 * The rule that keeps this simple: what goes to the log is English, always (a log is searched,
 * pasted into bug reports and read by scripts); what goes on screen is translated. So the texts
 * a state push carries (the steps of the chain, the detail behind a status light) come through
 * t(), and a log.note() never does.
 *
 * One flat JSON file per language in src/i18n/, same keys in each (a test checks it). A text
 * may hold {placeholders}. A missing key falls back to English, then to the key itself: a
 * forgotten translation shows up as an odd word, never as a crash.
 */
const DIR = path.join(__dirname, '..', 'i18n');
const LANGUAGES = ['en', 'fr'];

const tables = {};
for (const lang of LANGUAGES) {
  try {
    tables[lang] = JSON.parse(fs.readFileSync(path.join(DIR, lang + '.json'), 'utf8'));
  } catch {
    tables[lang] = {};
  }
}

let current = 'en';

function setLanguage(lang) {
  current = LANGUAGES.includes(lang) ? lang : 'en';
}

function language() {
  return current;
}

function format(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

/** The text for [key] in the current language, with {placeholders} filled from [vars]. */
function t(key, vars) {
  const text = tables[current][key] !== undefined ? tables[current][key]
    : tables.en[key] !== undefined ? tables.en[key]
    : key;
  return format(text, vars);
}

/** The whole table of one language (what the window is handed at load). */
function tableFor(lang) {
  return { ...tables.en, ...(tables[lang] || {}) };
}

module.exports = { LANGUAGES, setLanguage, language, t, tableFor, format };
