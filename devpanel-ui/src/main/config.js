'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  SCHEMA, SECTIONS, DEAD_KEYS, RENAMED_KEYS, RESERVED_KEYS, CONFIG_VERSION,
} = require('./settings-schema');
const { expandHome, isFile, isDir } = require('./detect');

/**
 * The panel's configuration.
 *
 * Four layers, weakest first:
 *
 *   the schema's defaults      same for everyone (settings-schema.js)
 *   what detection found       this machine's repositories, Godot, Docker (detect.js)
 *   the profile's settings     what the chosen profile prefers (modules.js)
 *   config.json                what the user actually chose -- and nothing else
 *
 * config.json is SPARSE: it only holds the values the user set. A full dump would freeze today's
 * defaults into every install, and a default fixed later would never reach anyone.
 *
 * The effective configuration is one plain object, `store.config`, shaped like the keys
 * ("paths.godotExe" -> config.paths.godotExe). It is rebuilt IN PLACE when a setting changes, so
 * every module holding a reference to it sees the new value at its next use.
 */

// --- small object helpers ---------------------------------------------------

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function getAt(obj, key) {
  let cur = obj;
  for (const part of key.split('.')) {
    if (!isPlainObject(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setAt(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

/** { a: { b: 1 }, c: [2] } -> { 'a.b': 1, c: [2] }. Arrays are values, not containers. */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? prefix + '.' + k : k;
    if (isPlainObject(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function unflatten(flat) {
  const out = {};
  for (const [key, value] of Object.entries(flat)) setAt(out, key, value);
  return out;
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Read a JSON file, tolerating the UTF-8 BOM that Notepad and Windows PowerShell 5.1 prepend. */
function readJsonFile(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return JSON.parse(text);
}

// --- the schema, indexed ----------------------------------------------------

const BY_KEY = new Map(SCHEMA.map((entry) => [entry.key, entry]));

/** The two families of systems the settings distinguish: Windows, and everything POSIX. */
function familyOf(platform) {
  return platform === 'win32' ? 'win32' : 'linux';
}

function appliesTo(entry, platform) {
  return !entry.platforms || entry.platforms.includes(familyOf(platform));
}

function defaultOf(entry, platform) {
  const d = entry.default;
  if (isPlainObject(d) && ('win32' in d || 'linux' in d)) return clone(d[familyOf(platform)]);
  return clone(d);
}

/**
 * Turn a raw value into a valid one for its entry.
 * Returns { ok: true, value } or { ok: false, error }. An empty text means "not set".
 */
function coerce(entry, raw) {
  switch (entry.type) {
    case 'file':
    case 'directory':
    case 'string': {
      if (typeof raw !== 'string') return { ok: false, error: 'expected a text value' };
      const value = raw.trim();
      if (entry.pattern && value !== '' && !new RegExp(entry.pattern).test(value)) {
        return { ok: false, error: 'does not look like a valid value' };
      }
      return { ok: true, value };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: 'expected a whole number' };
      if (entry.min !== undefined && n < entry.min) return { ok: false, error: 'minimum is ' + entry.min };
      if (entry.max !== undefined && n > entry.max) return { ok: false, error: 'maximum is ' + entry.max };
      return { ok: true, value: n };
    }
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true' || raw === 'false') return { ok: true, value: raw === 'true' };
      return { ok: false, error: 'expected true or false' };
    }
    case 'list': {
      const items = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(/\r?\n/) : null);
      if (!items || items.some((x) => typeof x !== 'string')) return { ok: false, error: 'expected a list of texts' };
      return { ok: true, value: items.map((x) => x.trim()).filter(Boolean) };
    }
    case 'enum': {
      if (!entry.options.includes(raw)) return { ok: false, error: 'expected one of ' + entry.options.join(', ') };
      return { ok: true, value: raw };
    }
    default:
      return { ok: false, error: 'unknown setting type ' + entry.type };
  }
}

function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

/**
 * Bring a config.json written by an earlier version up to date: dead keys go, renamed keys
 * move, and a value identical to the current default is dropped (it was only ever a copy of
 * the defaults of its day). Everything the user really chose is kept as it is.
 */
function importLegacy(raw, platform) {
  const out = {};
  for (const [key, value] of Object.entries(flatten(raw))) {
    if (DEAD_KEYS.some((dead) => key === dead || key.startsWith(dead + '.'))) continue;
    const renamed = RENAMED_KEYS[key] || key;
    const entry = BY_KEY.get(renamed);
    if (entry && !entry.detect && same(value, defaultOf(entry, platform))) continue;
    out[renamed] = value;
  }
  return out;
}

class ConfigStore {
  /**
   * @param {string} file        config.json in the data directory
   * @param {function} detect    (known user values) -> { detectorName: value | null }
   */
  constructor({ file, platform = process.platform, detect = () => ({}) }) {
    this.file = file;
    this.platform = platform;
    this._detect = detect;

    this.config = {};        // effective values; the SAME object for the panel's whole life
    this.user = {};          // flat: only what the user chose, as they typed it
    this.extra = {};         // flat: keys we do not know, kept untouched
    this.reserved = {};      // top-level keys that are not settings (profile, modules)
    this.detected = {};
    this.profileSettings = {};   // flat: what the chosen profile prefers
    this.problems = [];      // [{ level: 'error'|'warn', key?, message }]
    this.importedLegacy = false;
    this._broken = false;
  }

  /** Read config.json (when there is one) and build the effective configuration. */
  load() {
    this.problems = [];
    let raw = null;

    if (fs.existsSync(this.file)) {
      try {
        raw = readJsonFile(this.file);
        if (!isPlainObject(raw)) throw new Error('not a JSON object');
      } catch (err) {
        // A broken file must not stop the panel from opening -- but it must be said, loudly,
        // and the file is set aside before anything is written over it.
        this._broken = true;
        raw = null;
        this.problems.push({
          level: 'error',
          message: 'config.json could not be read (' + String(err && err.message)
            + '): the defaults are used and your settings are ignored.',
        });
      }
    }

    if (raw) {
      const legacy = raw.configVersion === undefined;
      const reserved = {};
      for (const key of RESERVED_KEYS) {
        if (key in raw) reserved[key] = raw[key];
      }
      const body = { ...raw };
      for (const key of RESERVED_KEYS) delete body[key];
      const flat = legacy ? importLegacy(body, this.platform) : flatten(body);
      this.reserved = reserved;
      this._ingest(flat);
      if (legacy) {
        this.importedLegacy = true;
        this._backup('.bak');
        this.save();
      }
    }

    this._rebuild();
    return this;
  }

  /** Sort flat values into known settings, unknown keys, and problems. */
  _ingest(flat) {
    this.user = {};
    this.extra = {};
    for (const [key, value] of Object.entries(flat)) {
      const entry = BY_KEY.get(key);
      if (!entry) {
        this.extra[key] = value;
        this.problems.push({ level: 'warn', key, message: 'unknown setting "' + key + '" (kept, ignored)' });
        continue;
      }
      if (isEmpty(value)) continue;
      const result = coerce(entry, value);
      if (!result.ok) {
        this.problems.push({
          level: 'error', key,
          message: 'setting "' + key + '" is invalid (' + result.error + '): the default is used',
        });
        continue;
      }
      if (!isEmpty(result.value)) this.user[key] = result.value;
    }
  }

  /** Recompute the effective configuration, in place. */
  _rebuild() {
    try {
      this.detected = this._detect({ ...this.user }) || {};
    } catch (err) {
      this.detected = {};
      this.problems.push({ level: 'warn', message: 'detection failed: ' + String(err && err.message) });
    }

    const next = {};
    for (const entry of SCHEMA) {
      if (!appliesTo(entry, this.platform)) continue;
      setAt(next, entry.key, this._effective(entry).value);
    }
    next.profile = this.reserved.profile || null;
    next.modules = clone(this.reserved.modules) || {};

    // In place: every module was handed this object once, at start.
    for (const key of Object.keys(this.config)) delete this.config[key];
    Object.assign(this.config, next);
  }

  /** Run detection again (something was just cloned or downloaded) and rebuild the configuration. */
  refreshDetection() {
    this._rebuild();
  }

  /** The value a setting takes, and where it comes from. */
  _effective(entry) {
    const pathLike = entry.type === 'file' || entry.type === 'directory';
    const finish = (value, source) => ({ value: pathLike ? expandHome(value) : value, source });

    if (entry.key in this.user) return finish(clone(this.user[entry.key]), 'user');
    if (entry.key in this.profileSettings) return finish(clone(this.profileSettings[entry.key]), 'profile');
    const found = entry.detect ? this.detected[entry.detect] : null;
    if (!isEmpty(found)) return finish(found, 'detected');
    return finish(defaultOf(entry, this.platform), 'default');
  }

  /**
   * The settings the chosen profile prefers ({ "godot.clientCount": 1 }). They sit above the
   * defaults and detection, below the user's own choices. Invalid or unknown ones are skipped
   * and returned as messages: a profile file is hand-written.
   */
  setProfileSettings(settings) {
    const next = {};
    const skipped = [];
    for (const [key, raw] of Object.entries(flatten(settings || {}))) {
      const entry = BY_KEY.get(key);
      if (!entry) { skipped.push('unknown setting "' + key + '"'); continue; }
      const result = coerce(entry, raw);
      if (!result.ok) { skipped.push('"' + key + '": ' + result.error); continue; }
      if (!isEmpty(result.value)) next[key] = result.value;
    }
    this.profileSettings = next;
    this._rebuild();
    return skipped;
  }

  /**
   * Everything the settings screen needs, in display order.
   * @param {string} lang 'en' or 'fr'
   */
  describe(lang = 'en') {
    const text = (t) => (t && (t[lang] || t.en)) || '';
    const sections = SECTIONS.map((section) => ({
      id: section.id,
      label: text(section.label),
      entries: SCHEMA
        .filter((entry) => entry.section === section.id && appliesTo(entry, this.platform))
        .map((entry) => this._describeEntry(entry, text)),
    })).filter((section) => section.entries.length > 0);
    return { sections, missing: this.missingRequired(), problems: this.problems, file: this.file };
  }

  _describeEntry(entry, text) {
    const effective = this._effective(entry);
    const out = {
      key: entry.key,
      type: entry.type,
      label: text(entry.label),
      help: text(entry.help),
      value: effective.value,
      source: effective.source,
      // What the field falls back to when the user's own value is removed.
      fallback: this._fallback(entry),
      required: !!entry.required,
      restart: !!entry.restart,
      advanced: !!entry.advanced,
    };
    if (entry.options) out.options = entry.options;
    if (entry.min !== undefined) out.min = entry.min;
    if (entry.max !== undefined) out.max = entry.max;
    if (entry.type === 'file' || entry.type === 'directory') {
      out.exists = isEmpty(effective.value) ? false
        : (entry.type === 'file' ? isFile(effective.value) : isDir(effective.value));
    }
    return out;
  }

  _fallback(entry) {
    if (entry.key in this.profileSettings) return { value: clone(this.profileSettings[entry.key]), source: 'profile' };
    const found = entry.detect ? this.detected[entry.detect] : null;
    if (!isEmpty(found)) return { value: found, source: 'detected' };
    return { value: defaultOf(entry, this.platform), source: 'default' };
  }

  /** Required settings that are empty, or that point at something that is not there. */
  missingRequired() {
    const out = [];
    for (const entry of SCHEMA) {
      if (!entry.required || !appliesTo(entry, this.platform)) continue;
      const { value } = this._effective(entry);
      const there = isEmpty(value) ? false
        : entry.type === 'file' ? isFile(value)
        : entry.type === 'directory' ? isDir(value)
        : true;
      if (!there) out.push(entry.key);
    }
    return out;
  }

  /**
   * Change settings. `patch` maps keys to new values; null (or an empty text) removes the
   * user's value, so the setting goes back to automatic.
   *
   * All or nothing: one invalid value and nothing is saved.
   * Returns { ok, errors: { key: message }, changed: [keys], restart: [keys] }.
   */
  apply(patch) {
    const errors = {};
    const nextUser = { ...this.user };

    for (const [key, raw] of Object.entries(patch || {})) {
      const entry = BY_KEY.get(key);
      if (!entry || !appliesTo(entry, this.platform)) {
        errors[key] = 'unknown setting';
        continue;
      }
      if (isEmpty(raw)) {
        delete nextUser[key];
        continue;
      }
      const result = coerce(entry, raw);
      if (!result.ok) {
        errors[key] = result.error;
        continue;
      }
      // A plain setting put back to its default is no longer "chosen". A detected one stays
      // chosen even when it matches what detection finds today: tomorrow detection may find
      // something else, and the user did pick this.
      if (isEmpty(result.value) || (!entry.detect && same(result.value, defaultOf(entry, this.platform)))) {
        delete nextUser[key];
      } else {
        nextUser[key] = result.value;
      }
    }

    if (Object.keys(errors).length) return { ok: false, errors, changed: [], restart: [] };

    const before = flatten(this.config);
    this.user = nextUser;
    this.save();
    this._rebuild();
    const after = flatten(this.config);

    const changed = SCHEMA.map((e) => e.key).filter((key) => !same(before[key], after[key]));
    const restart = changed.filter((key) => BY_KEY.get(key).restart);
    return { ok: true, errors: {}, changed, restart };
  }

  /** Change a top-level key that is not a setting (profile, modules). */
  setReserved(key, value) {
    if (!RESERVED_KEYS.includes(key) || key === 'configVersion') throw new Error('not a reserved key: ' + key);
    if (value === null || value === undefined) delete this.reserved[key];
    else this.reserved[key] = clone(value);
    this.save();
    this._rebuild();
  }

  /** Write config.json: only what the user chose, through a temporary file so a crash cannot truncate it. */
  save() {
    if (this._broken) {
      this._backup('.broken');
      this._broken = false;
    }
    const body = unflatten({ ...this.extra, ...this.user });
    const doc = { configVersion: CONFIG_VERSION, ...this.reserved, ...body };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** Copy the current file aside once (never overwrites an existing copy). */
  _backup(suffix) {
    const target = this.file + suffix;
    try {
      if (fs.existsSync(this.file) && !fs.existsSync(target)) fs.copyFileSync(this.file, target);
    } catch { /* a backup that cannot be written must not block the panel */ }
  }
}

module.exports = {
  ConfigStore, coerce, importLegacy, flatten, unflatten, getAt, setAt, defaultOf, appliesTo, readJsonFile,
};
