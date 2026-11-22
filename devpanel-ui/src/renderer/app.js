'use strict';

/* DyingStar dev panel - renderer.
 *
 * The log list is virtualised: a busy stack emits thousands of lines a minute and
 * putting them all in the DOM would freeze the window. Only the rows currently on
 * screen exist as elements; everything else is arithmetic on scrollTop. */

const ROW_H = 19; // must stay in sync with --row-h in style.css
const MAX_ENTRIES = 60000;
const OVERSCAN = 8;

const $ = (id) => document.getElementById(id);
// Every text shown comes from src/i18n/ through t() (see i18n.js, loaded before this file).
const t = window.t;

const el = {
  lights: $('lights'), chain: $('chain'), procs: $('procs'), pods: $('pods'),
  podsSummary: $('podsSummary'), buildTargets: $('buildTargets'), apiHint: $('apiHint'),
  tabs: $('tabs'), search: $("search"), searchCount: $("searchCount"), searchClear: $("searchClear"),
  levels: $('levels'), viewport: $('viewport'), spacer: $('spacer'),
  rows: $('rows'), empty: $('empty'), detail: $('detail'),
};

/* ── state ─────────────────────────────────────────────────────────────── */

let entries = [];                // every log line received, capped at MAX_ENTRIES
let view = [];                   // entries currently displayed (after all filters)
let matches = [];                // indices into `view` that match the query
let currentMatch = -1;
let selectedIndex = -1;

const ui = {
  source: '*',
  query: '',
  mode: 'filter',                // 'filter' | 'highlight'
  regex: false,
  caseSensitive: false,
  levels: new Set(),             // empty = no level filter
  follow: true,
};

let lastState = null;
let portForwardOn = false;

/* ── source colours ────────────────────────────────────────────────────── */

// Stable per-source colour so a service keeps the same hue across sessions.
const SOURCE_COLORS = [
  '#ffba08', '#7fd1b9', '#89b4fa', '#f06595', '#c3a6ff',
  '#8ec07c', '#ffa94d', '#74c0fc', '#ffd43b', '#ff8787',
];

const colorCache = new Map();
function sourceColor(name) {
  if (colorCache.has(name)) return colorCache.get(name);
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const c = SOURCE_COLORS[h % SOURCE_COLORS.length];
  colorCache.set(name, c);
  return c;
}

/* ── helpers ───────────────────────────────────────────────────────────── */

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function timeOf(ts) {
  const d = new Date(ts);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
}

/** Build the matcher used both for filtering and for highlighting. */
function buildMatcher() {
  if (!ui.query) return null;
  const flags = ui.caseSensitive ? 'g' : 'gi';
  const body = ui.regex ? ui.query : escapeRegExp(ui.query);
  try {
    return new RegExp(body, flags);
  } catch {
    return 'invalid';
  }
}

/* ── log ingestion ─────────────────────────────────────────────────────── */

/* Performance note, learned the hard way: the first version re-filtered all 60 000
 * entries AND rescanned them again for the tab counters on every incoming batch --
 * roughly 16 times a second under a busy stack + the Godot server. That is two full
 * scans per batch to discover that a handful of lines were appended at the bottom.
 *
 * Now:
 *   - arriving lines are tested individually and appended (O(batch), not O(total));
 *   - per-source counters are maintained as lines arrive, never rescanned;
 *   - a full rebuild happens only when a filter actually changes;
 *   - painting is throttled, because the screen cannot show 60 updates a second
 *     of a list that scrolls past anyway. */

const RENDER_MS = 90;          // at most ~11 repaints a second while streaming
const TRIM_SLACK = 5000;       // trim in chunks so splice() is rare, not per batch

const counts = new Map();      // src -> { n, err }, kept incrementally
let matcher = null;            // compiled query, or 'invalid'

function setMatcher() {
  matcher = buildMatcher();
}

/** Does this entry survive the source/level/mode filters? */
function passes(e) {
  if (ui.source !== '*' && e.src !== ui.source) return false;
  if (ui.levels.size > 0 && !ui.levels.has(e.lvl || 'AUTRE')) return false;
  if (ui.query && matcher && matcher !== 'invalid' && ui.mode === 'filter') {
    matcher.lastIndex = 0;
    return matcher.test(e.text);
  }
  return true;
}

function isMatch(e) {
  if (!matcher || matcher === 'invalid') return false;
  matcher.lastIndex = 0;
  return matcher.test(e.text);
}

function bumpCount(e, delta) {
  const c = counts.get(e.src) || { n: 0, err: 0 };
  c.n += delta;
  if (e.lvl === 'ERROR') c.err += delta;
  if (c.n <= 0) counts.delete(e.src); else counts.set(e.src, c);
}

function addEntries(batch) {
  for (const e of batch) {
    entries.push(e);
    bumpCount(e, 1);
    if (passes(e)) {
      view.push(e);
      if (isMatch(e)) matches.push(view.length - 1);
    }
  }

  // Drop the oldest lines in one chunk rather than shifting the array every batch.
  if (entries.length > MAX_ENTRIES + TRIM_SLACK) {
    entries.splice(0, entries.length - MAX_ENTRIES);
    counts.clear();
    for (const e of entries) bumpCount(e, 1);
    rebuildView();
  }

  scheduleRender();
}

/**
 * Drop lines the main process just cleared (a relaunch, or the Vider button).
 * `info.all` wipes everything; otherwise only the named sources go.
 */
function applyCleared(info) {
  const all = info && info.all;
  const set = new Set((info && info.sources) || []);
  if (!all && set.size === 0) return;

  entries = all ? [] : entries.filter((e) => !set.has(e.src));
  counts.clear();
  for (const e of entries) bumpCount(e, 1);

  // The cleared tab may no longer exist: fall back to the combined view.
  if (!all && ui.source !== '*' && set.has(ui.source)) ui.source = '*';
  if (all) ui.source = '*';

  currentMatch = -1;
  selectedIndex = -1;
  tabSignature = '';
  el.detail.innerHTML = '<span class="detail-hint">' + escapeHtml(t('ui.detailHint')) + '</span>';

  rebuildView();
  saveUi();
  scheduleRender(true);
}

/** Full rebuild of `view` / `matches`. Only for filter changes and after a trim. */
function rebuildView() {
  view = [];
  matches = [];
  for (const e of entries) {
    if (passes(e)) {
      view.push(e);
      if (isMatch(e)) matches.push(view.length - 1);
    }
  }
  if (currentMatch >= matches.length) currentMatch = matches.length - 1;
}

/** Called by every filter control: recompile the query, rebuild, repaint now. */
function recompute() {
  setMatcher();
  rebuildView();
  saveUi();
  scheduleRender(true);
}

/* Hot reload replaces the page, so the active tab, the query and the filters would
 * be lost on every save. Parking them in sessionStorage (which survives a reload)
 * makes reloading invisible: you come back exactly where you were. */

const UI_KEY = 'ds-devpanel-ui';

function saveUi() {
  try {
    sessionStorage.setItem(UI_KEY, JSON.stringify({
      source: ui.source, query: ui.query, mode: ui.mode,
      regex: ui.regex, caseSensitive: ui.caseSensitive,
      levels: [...ui.levels], follow: ui.follow,
    }));
  } catch { /* storage unavailable: not worth failing over */ }
}

function restoreUi() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(UI_KEY) || 'null'); } catch { saved = null; }
  if (!saved) return;

  ui.source = saved.source || '*';
  ui.query = saved.query || '';
  ui.mode = saved.mode === 'highlight' ? 'highlight' : 'filter';
  ui.regex = !!saved.regex;
  ui.caseSensitive = !!saved.caseSensitive;
  ui.levels = new Set(Array.isArray(saved.levels) ? saved.levels : []);
  ui.follow = saved.follow !== false;

  el.search.value = ui.query;
  $('chkFollow').checked = ui.follow;
  $('btnRegex').classList.toggle('active', ui.regex);
  $('btnCase').classList.toggle('active', ui.caseSensitive);
  [...$('modeSeg').children].forEach((c) => c.classList.toggle('active', c.dataset.mode === ui.mode));
  [...el.levels.children].forEach((c) => c.classList.toggle('on', ui.levels.has(c.dataset.level)));
}

let renderPending = false;
let lastRenderAt = 0;
let renderTimer = null;

function scheduleRender(immediate = false) {
  if (immediate) {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    renderPending = false;
    paint();
    return;
  }
  if (renderPending) return;
  renderPending = true;
  const wait = Math.max(0, RENDER_MS - (Date.now() - lastRenderAt));
  // Paints straight from the timer, deliberately NOT through requestAnimationFrame:
  // rAF only fires while the window is actually being composited, so a panel sitting
  // behind the Godot window (or minimised) would stop updating its log entirely and
  // only catch up when brought back to the front. The 90 ms throttle already keeps
  // this smooth; correctness should not depend on the compositor.
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderPending = false;
    paint();
  }, wait);
}

function paint() {
  lastRenderAt = Date.now();
  updateSearchCount(matcher === 'invalid');
  renderTabs();
  render();          // follows to the bottom itself when "suivre" is on
}

function updateSearchCount(invalid) {
  if (invalid) {
    el.searchCount.textContent = 'regex ?';
    el.searchCount.classList.add('none');
    return;
  }
  if (!ui.query) {
    el.searchCount.textContent = view.length ? t('ui.count.lines', { n: view.length }) : '';
    el.searchCount.classList.remove('none');
    return;
  }
  const n = ui.mode === 'filter' ? view.length : matches.length;
  el.searchCount.textContent = n === 0
    ? '0'
    : (currentMatch >= 0 ? (currentMatch + 1) + '/' + n : t('ui.count.found', { n }));
  el.searchCount.classList.toggle('none', n === 0);
}

/**
 * Wrap every match in <mark>.
 *
 * The search runs on the RAW text and the slices are escaped afterwards. Doing it
 * the other way round (escaping first, then searching) silently breaks any query
 * containing <, > or & -- the text would already read "&lt;" by then.
 */
function highlight(text, matcher) {
  matcher.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  let guard = 0;
  while ((m = matcher.exec(text)) !== null) {
    if (guard++ > 800) break;                       // pathological regex safety net
    if (m.index > last) out += escapeHtml(text.slice(last, m.index));
    out += '<mark>' + escapeHtml(m[0]) + '</mark>';
    last = m.index + m[0].length;
    if (m[0].length === 0) matcher.lastIndex++;     // zero-width match would loop forever
  }
  out += escapeHtml(text.slice(last));
  return out;
}

/* ── virtual list rendering ────────────────────────────────────────────── */

let inRender = false;

function render() {
  if (inRender) return;          // scrollTop writes below re-enter through 'scroll'
  inRender = true;

  const total = view.length;

  /* Order matters, and getting it wrong showed up as a blank list.
   *
   * 1. Set the spacer height FIRST, so the scroll range matches the new content.
   * 2. Only then follow to the bottom.
   * 3. Compute the visible window from the settled scrollTop.
   *
   * Doing (3) before (1)/(2) meant that switching from a big tab to a smaller one
   * computed `start` from the old, far larger scroll offset -- past the end of the
   * new content, so nothing was drawn. And because the browser had already clamped
   * scrollTop when the spacer shrank, no scroll event followed to fix it: the list
   * stayed empty until the user scrolled by hand. */
  el.spacer.style.height = (total * ROW_H) + 'px';
  el.empty.classList.toggle('hidden', total > 0);

  const vpHeight = el.viewport.clientHeight;

  /* Compute the bottom arithmetically instead of reading scrollHeight.
   * scrollHeight cannot be trusted at this point: .log-rows is absolutely positioned
   * and still carries the PREVIOUS view's translateY, so it inflates the scrollable
   * area far past the new content until its rows are rewritten a few lines below.
   * Reading it here made a tab switch land past the end of the list. */
  const maxScroll = Math.max(0, total * ROW_H - vpHeight);
  if (ui.follow) el.viewport.scrollTop = maxScroll;

  const scrollTop = Math.min(el.viewport.scrollTop, maxScroll);

  // Clamp: scrollTop can still be stale (a filter that shrank the list), and a
  // negative `count` would silently render nothing.
  let start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  if (start > total - 1) start = Math.max(0, total - 1);
  const count = Math.max(0, Math.min(total - start, Math.ceil(vpHeight / ROW_H) + OVERSCAN * 2));

  el.rows.style.transform = 'translateY(' + (start * ROW_H) + 'px)';

  // Uses the module-level compiled matcher: recompiling a RegExp on every repaint
  // was pure waste, and only the ~70 visible rows are highlighted anyway.
  const useMark = matcher && matcher !== 'invalid';
  const currentViewIdx = currentMatch >= 0 ? matches[currentMatch] : -1;

  const html = [];
  for (let i = 0; i < count; i++) {
    const idx = start + i;
    const e = view[idx];
    if (!e) break;

    const txt = useMark ? highlight(e.text, matcher) : escapeHtml(e.text);

    const cls = ['log-row'];
    if (idx === selectedIndex) cls.push('selected');
    if (idx === currentViewIdx) cls.push('current-match');
    if (e.lvl === 'ERROR') cls.push('is-error');
    else if (e.lvl === 'WARN') cls.push('is-warn');

    html.push(
      '<div class="' + cls.join(' ') + '" data-idx="' + idx + '">' +
        '<span class="ts">' + timeOf(e.t) + '</span>' +
        (ui.source === '*'
          ? '<span class="src" style="color:' + sourceColor(e.src) + '">' + escapeHtml(e.src) + '</span>'
          : '') +
        '<span class="lvl ' + (e.lvl || '') + '">' + (e.lvl || '') + '</span>' +
        '<span class="txt">' + txt + '</span>' +
      '</div>'
    );
  }

  el.rows.innerHTML = html.join('');
  inRender = false;
}

/** Only for the "suivre" checkbox: render() already follows on its own. */
function scrollToBottom() {
  ui.follow = true;
  render();
}

el.viewport.addEventListener('scroll', () => {
  // Turn following off as soon as the user scrolls away, back on at the bottom -
  // the behaviour of a modern terminal. Uses the same arithmetic bottom as render(),
  // not scrollHeight, for the reason explained there.
  const maxScroll = Math.max(0, view.length * ROW_H - el.viewport.clientHeight);
  const atBottom = maxScroll - el.viewport.scrollTop < 24;
  if (ui.follow !== atBottom) {
    ui.follow = atBottom;
    $('chkFollow').checked = atBottom;
  }
  render();
});

new ResizeObserver(() => render()).observe(el.viewport);

el.viewport.addEventListener('click', (ev) => {
  const row = ev.target.closest('.log-row');
  if (!row) return;
  selectedIndex = Number(row.dataset.idx);
  showDetail(view[selectedIndex]);
  render();
});

function showDetail(e) {
  if (!e) return;
  el.detail.innerHTML =
    '<span class="d-meta">' + timeOf(e.t) + '  [' + escapeHtml(e.src) + ']' +
    (e.lvl ? '  ' + e.lvl : '') + '</span>\n' + escapeHtml(e.text);
}

/* ── search navigation ─────────────────────────────────────────────────── */

function gotoMatch(delta) {
  const list = ui.mode === 'filter'
    ? view.map((_, i) => i)   // in filter mode every visible row is a hit
    : matches;
  if (!list.length) return;

  currentMatch = currentMatch < 0
    ? (delta > 0 ? 0 : list.length - 1)
    : (currentMatch + delta + list.length) % list.length;

  const viewIdx = ui.mode === 'filter' ? currentMatch : matches[currentMatch];
  ui.follow = false;
  $('chkFollow').checked = false;

  // Centre the hit rather than just scrolling it barely into view.
  const target = viewIdx * ROW_H - el.viewport.clientHeight / 2;
  el.viewport.scrollTop = Math.max(0, target);

  selectedIndex = viewIdx;
  showDetail(view[viewIdx]);
  updateSearchCount(false);
  render();
}

/* ── sidebar rendering ─────────────────────────────────────────────────── */

function light(label, ok, detail, warn = false) {
  const cls = ok ? 'ok' : (warn ? 'warn' : 'bad');
  return '<div class="light ' + cls + '" title="' + escapeHtml(detail || '') + '">' +
    '<span class="dot"></span>' + escapeHtml(label) + '</div>';
}

/* ── buttons that reflect the current state ─────────────────── */

/**
 * Turn a "start" button green while the thing it starts is already up.
 *
 * The dedicated server reads its state from the PORT, not from the panel's process
 * list: a server started with F5 in the editor belongs to nobody here, yet clicking
 * the button anyway is exactly the mistake worth preventing.
 */
function renderButtonStates(state) {
  const procs = state.procs || [];
  const pr = state.probes || {};
  const running = (id) => procs.some((x) => x.id === id && x.status === 'running');
  const gsPort = state.config?.ports?.gameServer || 8980;

  /*
   * The "on" label is not decoration: a green button still reading "Démarrer"
   * contradicts itself. Each label states what is true, and they differ on purpose --
   * clicking "Lancer les clients" while clients run really does add more, so a past
   * participle there would be a lie. The other four are refused by the main process,
   * so theirs describe the situation instead.
   */
  const marks = [
    ['[data-action="start-editor"]', running('godot-editor'),
      t('ui.on.editor'), t('ui.on.editor.tip')],
    ['[data-action="start-godot-server"]', !!pr.gameServer?.ok,
      t('ui.on.server'), t('ui.on.server.tip', { port: gsPort })],
    ['#btnClients', procs.some((x) => x.id.startsWith('godot-client-') && x.status === 'running'),
      t('ui.on.clients'), t('ui.on.clients.tip')],
    ['[data-action="start-stack"]', running('stack'),
      t('ui.on.stack'), t('ui.on.stack.tip')],
  ];

  for (const [sel, on, onLabel, why] of marks) {
    const btn = document.querySelector(sel);
    if (!btn) continue;
    btn.classList.toggle('is-on', !!on);
    // Remember the resting label and tooltip so both come back when it stops.
    if (btn.dataset.baseLabel === undefined) btn.dataset.baseLabel = btn.textContent.trim();
    if (btn.dataset.baseTitle === undefined) btn.dataset.baseTitle = btn.title || '';
    btn.textContent = on ? onLabel : btn.dataset.baseLabel;
    btn.title = on ? why : btn.dataset.baseTitle;
  }

  /*
   * And a button whose preconditions are not met is GREYED OUT, not merely explained.
   *
   * Telling someone "the click will do nothing" and then letting them click anyway puts the
   * refusal in a log they are not reading. Worse, some of these refusals are silent on purpose --
   * the start guard turns down a server that is already up so it cannot kill the one you launched
   * with F5 -- so from the outside the panel just looks broken. The tooltip now says what is
   * MISSING, which is the only thing worth knowing while the button is unusable.
   */
  const clusterReady = !!pr.pods?.ok;

  /*
   * Launching a client onto a half-built stack is the costliest mistake the panel can let you
   * make: you spawn, the world is there, and you simply cannot move -- which reads as a game bug
   * and sends you debugging the wrong thing for an hour. Each of the three conditions below is a
   * way that has actually happened, and the tooltip names the CONSEQUENCE, not the plumbing.
   */
  renderSets(pr.sets);
  // The hosts file by hand, for a machine without the system's graphical prompt.
  const hostsCmd = p_net(pr).hostsCommand || '';
  $('hostsCmdBox').hidden = !hostsCmd;
  $('hostsCmd').textContent = hostsCmd;
  const hzPort = state.config?.ports?.horizon || 7040;
  // Each condition only counts when the module that watches it is on: a panel that does not run
  // the cluster has no opinion about horizon, and must not grey the button out over it.
  const watches = (id) => modOn(state, id);
  let clientsMissing = '';
  if (watches('horizon') && !pr.horizonRoute?.ok) {
    clientsMissing = pr.horizonRoute?.detail || t('ui.need.horizon');
  } else if (watches('gameServer') && !pr.gameServer?.ok) {
    clientsMissing = t('ui.need.server');
  } else if (watches('gameServer') && pr.gameServer?.alive === false) {
    clientsMissing = t('ui.need.serverAlive');
  } else if (watches('relink') && !pr.gameServer?.linked) {
    clientsMissing = t('ui.need.link');
  } else if (watches('relink') && state.relink?.worldDelivered === false) {
    clientsMissing = t('ui.need.world');
  }

  const gates = [
    ['#btnClients', clientsMissing === '', clientsMissing],
    ['[data-action="start-godot-server"]', !pr.gameServer?.ok, t('ui.gate.serverUp', { port: gsPort })],
    ['[data-action="stop-godot-server"]', running('godot-server'), t('ui.gate.notOurs')],
    ['#btnRestartServer', running('godot-server'), t('ui.gate.notOurs')],
    // Not merely "listening": a relink against a FIGE server rolls horizon for nothing, and horizon
    // then hands it a world and players it will never create. That was today's lost hour.
    ['[data-action="relink-now"]', clusterReady && !!pr.gameServer?.ok && pr.gameServer?.alive !== false,
      pr.gameServer?.alive === false ? t('ui.gate.relinkFrozen') : t('ui.gate.relinkNeeds', { port: gsPort })],
    ['#btnPurge', clusterReady, t('ui.gate.purge')],
    ['#btnPortFwd', clusterReady, t('ui.gate.relay')],
    // "Démarrer la stack" is not gated on minikube: creating the cluster when there is none is
    // precisely that script's job.
    ['#btnDeleteCluster', !!pr.docker?.ok, t('ui.gate.delete')],
    ['[data-action="network-repair"]', p_net(pr).mode !== 'tunnel' && p_net(pr).relaysOk === false,
      p_net(pr).mode === 'tunnel' ? t('ui.gate.netTunnel') : t('ui.gate.netOk')],
    ['[data-action="network-hosts"]', p_net(pr).mode !== 'tunnel' && p_net(pr).hostsOk === false,
      p_net(pr).mode === 'tunnel' ? t('ui.gate.netTunnel') : t('ui.gate.hostsOk')],
    ['[data-action="telepresence-connect"]', pr.telepresence?.installed !== false && !pr.telepresence?.connected,
      pr.telepresence?.installed === false ? t('ui.gate.tpMissing') : t('ui.gate.tpConnected')],
    ['[data-action="telepresence-intercept"]', !!pr.telepresence?.connected, t('ui.gate.tpNeedsConnect')],
    ['[data-action="telepresence-leave"]', !!pr.telepresence?.connected, t('ui.gate.tpNeedsConnect')],
    ['[data-action="telepresence-quit"]', !!pr.telepresence?.connected, t('ui.gate.tpNeedsConnect')],
  ];

  for (const [sel, allowed, missing] of gates) {
    const btn = document.querySelector(sel);
    // A button in the middle of its own action owns its disabled state; do not fight it.
    if (!btn || btn.dataset.busy === '1') continue;
    btn.disabled = !allowed;
    if (!allowed) btn.title = missing;
    else if (btn.dataset.baseTitle !== undefined && !btn.classList.contains('is-on')) {
      btn.title = btn.dataset.baseTitle;
    }
  }
}

/* The interface hot-reloads from its files while the process behind it keeps running the code it
 * started with. When the page needs something that process does not offer yet, say so instead of
 * leaving buttons that silently do nothing. */
const REQUIRED_API_LEVEL = 4;
let settingsAutoOpened = false;

/** The card of the sets of services: what runs, and a button to add or remove each one. */
function renderSets(sets) {
  const box = $('setsList');
  if (!box) return;
  const list = (sets && sets.ok && sets.sets) || [];
  box.replaceChildren();
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'set-row' + (s.deployed ? '' : ' absent');
    const info = document.createElement('div');
    info.className = 'set-info';
    const name = document.createElement('div');
    name.className = 'set-name';
    name.textContent = t('set.' + s.id + '.name') + ' \u2014 ' + (s.deployed
      ? t('ui.sets.deployed') + (s.health && s.health !== 'Healthy' ? ' (' + s.health + ')' : '')
      : t('ui.sets.absent'));
    const help = document.createElement('div');
    help.className = 'set-help';
    help.textContent = t('set.' + s.id + '.help');
    info.append(name, help);
    row.append(info);
    // core is always there; the two game server sets exclude each other, so one is switched TO,
    // never removed.
    const isServer = s.id === 'server' || s.id === 'server-idle';
    if (s.id !== 'core' && !(isServer && s.deployed)) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost';
      btn.dataset.setAction = s.deployed ? 'set-remove' : 'set-add';
      btn.dataset.set = s.id;
      btn.textContent = s.deployed ? t('ui.sets.remove') : (isServer ? t('ui.sets.use') : t('ui.sets.add'));
      row.append(btn);
    }
    box.append(row);
  }
}

/** The network part of the probes, never undefined. */
function p_net(probes) {
  return (probes && probes.network) || {};
}

/** Is this module on? Everything is, for a process too old to say. */
function modOn(state, id) {
  return !state || !state.modules || state.modules[id] !== false;
}

/**
 * Show only what belongs to a module that is on. An element names its module(s) in data-module;
 * with several, it stays as long as one of them is on (a card shared by two modules).
 */
let moduleSignature = null;
function applyModules(state) {
  document.querySelectorAll('[data-module]').forEach((node) => {
    const ids = node.dataset.module.split(/\s+/).filter(Boolean);
    node.classList.toggle('mod-off', !ids.some((id) => modOn(state, id)));
  });
  // The build list is asked from the main process, which refuses while the module is off.
  const signature = JSON.stringify(state.modules || null);
  if (signature !== moduleSignature) {
    moduleSignature = signature;
    if (modOn(state, 'build')) loadBuildTargets();
  }
}

function renderSettingsState(state) {
  $('staleBanner').classList.toggle('hidden', (state.apiLevel || 1) >= REQUIRED_API_LEVEL);

  const missing = (state.settings && state.settings.missing) || [];
  const pending = (state.settings && state.settings.restartPending) || [];
  // No profile chosen yet is worth a glance too: the panel shows everything until one is.
  const noProfile = state.modules !== undefined && !state.profile;
  $('btnSettings').classList.toggle('attention', missing.length > 0 || pending.length > 0 || noProfile);

  // Something required is not set: nothing useful can be done before it is, so open the screen
  // that can FETCH it -- once, and only once: a screen that reopens itself each time it is closed
  // is a trap.
  $('btnSetup').classList.toggle('attention', missing.length > 0);
  if (missing.length > 0 && !settingsAutoOpened) {
    settingsAutoOpened = true;
    if (window.setupScreen) window.setupScreen.open();
    else if (window.settingsScreen) window.settingsScreen.open();
  }
}

function renderState(state) {
  lastState = state;
  const p = state.probes || {};
  renderSettingsState(state);
  applyModules(state);

  // One light per thing watched, each owned by a module: [module, html].
  el.lights.innerHTML = [
    ['docker', light('Docker', p.docker?.ok, p.docker?.detail)],
    ['cluster', light('minikube', p.minikube?.ok, p.minikube?.detail)],
    ['cluster', light(t('ui.light.context', { name: p.kubeContext?.detail || '?' }), p.kubeContext?.ok,
      t('ui.light.expected', { name: p.kubeContext?.expected || '' }))],
    ['cluster', light(t('ui.light.pods', { detail: p.pods?.detail || '' }), p.pods?.ok, p.pods?.detail, true)],
    ['network', light(t('ui.light.network'), p.network?.ok, p.network?.detail, true)],
    ['horizon', light('horizon', p.horizonRoute?.ok, p.horizonRoute?.detail)],
    ['gameServer', light(t('ui.light.server', { port: state.config?.ports?.gameServer || '' }),
      p.gameServer?.ok, p.gameServer?.detail, true)],
    ['relink', light(t('ui.light.link'), p.gameServer?.linked,
      t('ui.light.linkDetail', { n: p.gameServer?.established ?? 0 }), true)],
    ['npc', light(t('ui.light.npc'), p.npc?.ok, p.npc?.detail || t('ui.light.npcDetail'), true)],
    // Amber while simply not connected (nothing is wrong), red only for a version mismatch.
    ['telepresence', light(t('ui.light.telepresence'), p.telepresence?.ok, p.telepresence?.detail,
      !p.telepresence?.warn)],
  ].filter(([module]) => modOn(state, module)).map(([, html]) => html).join('');

  el.apiHint.textContent = state.config?.apiUrl || '';
  renderButtonStates(state);

  // start chain
  const chain = state.chain || { steps: [] };
  $('chainCard').classList.toggle('mod-off', chain.steps.length === 0);
  el.chain.innerHTML = chain.steps.map((s) =>
    '<li class="' + s.state + '">' +
      '<span class="step-dot"></span>' +
      '<span><span class="step-label">' + escapeHtml(s.label) + '</span>' +
      (s.message ? '<br><span class="step-msg">' + escapeHtml(s.message) + '</span>' : '') +
      '</span></li>'
  ).join('');

  $('btnAbort').classList.toggle('hidden', !chain.running);
  $('btnStartAll').disabled = !!chain.running;

  // processes
  const procs = state.procs || [];
  el.procs.innerHTML = procs.length
    ? procs.map((pr) =>
        '<div class="proc-row">' +
          '<span class="state-dot ' + pr.status + '"></span>' +
          '<span class="name" title="' + escapeHtml(pr.label) + '">' + escapeHtml(pr.label) + '</span>' +
          (pr.pid ? '<span class="pid">' + pr.pid + '</span>' : '') +
          (pr.status === 'running'
            ? '<button class="kill-btn" data-stop="' + escapeHtml(pr.id) + '" title="' + escapeHtml(t('ui.procs.stop')) + '">&times;</button>'
            : '') +
        '</div>'
      ).join('')
    : '<div class="hint">' + escapeHtml(t('ui.procs.none')) + '</div>';

  // pods
  const pods = p.pods?.pods || [];
  el.podsSummary.textContent = p.pods?.detail || '';
  el.pods.innerHTML = pods.length
    ? pods.map((pod) =>
        '<div class="pod-row">' +
          // A finished job's pod (CNPG initdb, bootstrap) is neither up nor broken: no colour.
          '<span class="state-dot ' + (pod.done ? '' : pod.allReady ? 'running' : 'crashed') + '"></span>' +
          '<span class="name" title="' + escapeHtml(pod.name) + '">' + escapeHtml(pod.name) + '</span>' +
          (pod.restarts ? '<span class="restarts" title="' + escapeHtml(t('ui.pods.restarts')) + '">' + pod.restarts + 'x</span>' : '') +
          '<span class="badge' + (pod.allReady || pod.done ? '' : ' bad') + '">' + escapeHtml(pod.phase) + '</span>' +
          '<button class="kill-btn" data-pod="' + escapeHtml(pod.name) + '" title="' + escapeHtml(t('ui.pods.delete')) + '">&times;</button>' +
        '</div>'
      ).join('')
    : '<div class="hint">' + escapeHtml(t('ui.pods.none')) + '</div>';

  if (state.config && typeof state.config.clearOnRestart === 'boolean') {
    $('chkClearOnRestart').checked = state.config.clearOnRestart;
  }
  portForwardOn = procs.some((pr) => pr.id === 'port-forward' && pr.status === 'running');
  $('btnPortFwd').textContent = portForwardOn ? t('ui.relay.cut') : t('ui.relay');
}

/* ── tabs ──────────────────────────────────────────────────────────────── */

let tabSignature = '';

function renderTabs() {
  // Reads the incrementally maintained counters instead of rescanning every entry.
  const names = [...counts.keys()].sort();
  const sig = ui.source + '|' + names.map((n) => {
    const c = counts.get(n);
    return n + ':' + c.n + ':' + c.err;
  }).join(',');
  if (sig === tabSignature) return;
  tabSignature = sig;

  const tab = (id, label, n, hasErr, color) =>
    '<span class="tab' + (ui.source === id ? ' active' : '') + (hasErr ? ' has-error' : '') +
      '" data-src="' + escapeHtml(id) + '">' +
      (color ? '<span class="swatch" style="background:' + color + '"></span>' : '') +
      escapeHtml(label) + '<span class="n">' + n + '</span>' +
      '<span class="tab-x" data-clear="' + escapeHtml(id) + '" title="' + escapeHtml(t('ui.tabs.clear')) + '">&times;</span>' +
    '</span>';

  el.tabs.innerHTML =
    tab('*', t('ui.tabs.all'), entries.length, false, null) +
    names.map((n) => {
      const c = counts.get(n);
      return tab(n, n, c.n, c.err > 0, sourceColor(n));
    }).join('');
}

/* ── events ────────────────────────────────────────────────────────────── */

el.tabs.addEventListener('click', (ev) => {
  // The little cross must clear, not switch tabs -- check it before the tab itself.
  const x = ev.target.closest('[data-clear]');
  if (x) {
    ev.stopPropagation();
    window.panel.action('clear-logs', { source: x.dataset.clear });
    return;
  }

  const t = ev.target.closest('.tab');
  if (!t) return;
  ui.source = t.dataset.src;
  currentMatch = -1;
  selectedIndex = -1;
  tabSignature = '';
  ui.follow = true;
  $('chkFollow').checked = true;
  recompute();
});

let searchTimer = null;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    ui.query = el.search.value;
    currentMatch = -1;
    recompute();
  }, 120);
});

el.search.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    gotoMatch(ev.shiftKey ? -1 : 1);
  } else if (ev.key === 'Escape') {
    el.search.value = '';
    ui.query = '';
    currentMatch = -1;
    recompute();
  }
});

$('modeSeg').addEventListener('click', (ev) => {
  const b = ev.target.closest('.seg-btn');
  if (!b) return;
  ui.mode = b.dataset.mode;
  [...$('modeSeg').children].forEach((c) => c.classList.toggle('active', c === b));
  currentMatch = -1;
  recompute();
});

$('btnRegex').addEventListener('click', (ev) => {
  ui.regex = !ui.regex;
  ev.currentTarget.classList.toggle('active', ui.regex);
  recompute();
});

$('btnCase').addEventListener('click', (ev) => {
  ui.caseSensitive = !ui.caseSensitive;
  ev.currentTarget.classList.toggle('active', ui.caseSensitive);
  recompute();
});

$('btnPrev').addEventListener('click', () => gotoMatch(-1));
$('btnNext').addEventListener('click', () => gotoMatch(1));

// level filter chips
const LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG'];
el.levels.innerHTML = LEVELS.map((l) => '<button class="lvl-btn" data-level="' + l + '">' + l + '</button>').join('');
el.levels.addEventListener('click', (ev) => {
  const b = ev.target.closest('.lvl-btn');
  if (!b) return;
  const l = b.dataset.level;
  if (ui.levels.has(l)) ui.levels.delete(l); else ui.levels.add(l);
  b.classList.toggle('on', ui.levels.has(l));
  recompute();
});

$('chkFollow').addEventListener('change', (ev) => {
  ui.follow = ev.target.checked;
  saveUi();
  if (ui.follow) scrollToBottom();
});

$('btnCopy').addEventListener('click', async () => {
  const text = view.map((e) => new Date(e.t).toISOString() + ' [' + e.src + '] ' + e.text).join('\n');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // navigator.clipboard needs a secure context, which a file:// page is not always
    // considered to be. Fall back to the old execCommand path.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  flash($('btnCopy'), t('ui.copy.done', { n: view.length }));
});

$('btnCopyHostsCmd').addEventListener('click', async () => {
  const text = $('hostsCmd').textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  flash($('btnCopyHostsCmd'), t('ui.net.copied'));
});

$('btnOpenLogs').addEventListener('click', () => window.panel.action('open-logs-folder'));

// Clears the tab you are looking at; on "Tout", clears everything (with a confirm,
// since that one throws away every service's history at once).
$('btnClear').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  if (ui.source === '*') {
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = t('ui.clear.all');
      setTimeout(() => {
        if (btn.dataset.armed === '1') { btn.dataset.armed = '0'; btn.textContent = t('ui.clear'); }
      }, 4000);
      return;
    }
    btn.dataset.armed = '0';
    btn.textContent = t('ui.clear');
  }
  await window.panel.action('clear-logs', { source: ui.source });
});

$('chkClearOnRestart').addEventListener('change', (ev) => {
  window.panel.action('set-clear-on-restart', { on: ev.target.checked });
});

function flash(button, message) {
  const old = button.textContent;
  button.textContent = message;
  setTimeout(() => { button.textContent = old; }, 1600);
}

// global keyboard shortcuts
window.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') {
    ev.preventDefault();
    el.search.focus();
    el.search.select();
  } else if (ev.key === 'F3') {
    ev.preventDefault();
    gotoMatch(ev.shiftKey ? -1 : 1);
  }
});

/* ── sidebar actions ───────────────────────────────────────────────────── */

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-action]');
  if (btn) {
    btn.disabled = true;
    try { await window.panel.action(btn.dataset.action); } finally { btn.disabled = false; }
    return;
  }
  const setBtn = ev.target.closest('[data-set-action]');
  if (setBtn) {
    const set = setBtn.dataset.set;
    const remove = setBtn.dataset.setAction === 'set-remove';
    if (remove && !window.confirm(t('ui.sets.confirmRemove', { name: t('set.' + set + '.name') }))) return;
    setBtn.disabled = true;
    try { await window.panel.action(setBtn.dataset.setAction, { set, confirm: remove ? true : undefined }); } finally { setBtn.disabled = false; }
    return;
  }
  const stop = ev.target.closest('[data-stop]');
  if (stop) { await window.panel.action('stop-proc', { id: stop.dataset.stop }); return; }

  const pod = ev.target.closest('[data-pod]');
  if (pod) { await window.panel.action('delete-pod', { name: pod.dataset.pod }); return; }
});

$('btnStartAll').addEventListener('click', () => {
  const clients = $('chkClients').checked ? Number($('numClients').value) || 0 : 0;
  window.panel.action('start-all', { clients });
});

$('btnStopAll').addEventListener('click', async () => {
  const btn = $('btnStopAll');
  btn.disabled = true;
  try { await window.panel.action('stop-all'); } finally { btn.disabled = false; }
});

$('btnAbort').addEventListener('click', () => window.panel.action('abort'));

$('btnClients').addEventListener('click', () => {
  window.panel.action('start-clients', { count: Number($('numClients').value) || 2 });
});

$('btnPortFwd').addEventListener('click', () => {
  window.panel.action('port-forward', { on: !portForwardOn });
});

/** Pause, so a message the user must read is not wiped by the next line of code. */
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a condition against the pushed state: the panel sends state, it never answers questions. */
function waitFor(cond, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (cond()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 400);
    };
    tick();
  });
}

/**
 * Restart the dedicated server.
 *
 * The panel could only START one, and that start is refused while something already holds the
 * port -- so picking up a change to the server code meant killing the process by hand. Stop and
 * start both existed as actions already; what was missing is the WAIT between them, because
 * starting again before the port is free is exactly what the start guard turns down.
 */
$('btnRestartServer').addEventListener('click', async () => {
  const btn = $('btnRestartServer');
  const label = t('ui.server.restart');
  // Claim the button for the whole sequence: renderButtonStates runs on every state push and
  // would otherwise re-enable it under our feet, mid-restart.
  btn.dataset.busy = '1';
  btn.disabled = true;
  try {
    btn.textContent = t('ui.restart.stopping');
    await window.panel.action('stop-godot-server');

    btn.textContent = t('ui.restart.waiting');
    const freed = await waitFor(() => !(lastState && lastState.probes && lastState.probes.gameServer
      && lastState.probes.gameServer.ok), 20000);
    if (!freed) {
      // Someone else holds the port -- an F5 from the editor, which the panel cannot stop. Say so
      // rather than fire a start that would only be refused.
      btn.textContent = t('ui.restart.busy');
      await sleepMs(5000);
      return;
    }

    btn.textContent = t('ui.restart.starting');
    await window.panel.action('start-godot-server');
  } catch (err) {
    // A button that stays greyed out on "Arrêt du serveur…" forever is worse than a failed
    // restart: it looks like the panel is frozen, and the only way out is closing the window.
    btn.textContent = t('ui.restart.failed');
    console.error('Server restart:', err);
    await sleepMs(5000);
  } finally {
    btn.textContent = label;
    btn.disabled = false;
    delete btn.dataset.busy;
  }
});

// Two screens share the space under the top bar: opening one closes the other.
$('btnSettings').addEventListener('click', () => {
  if (!window.settingsScreen) return;
  if (window.setupScreen && window.setupScreen.isOpen()) window.setupScreen.close();
  if (window.settingsScreen.isOpen()) window.settingsScreen.close(); else window.settingsScreen.open();
});

$('btnSetup').addEventListener('click', () => {
  if (!window.setupScreen) return;
  if (window.settingsScreen && window.settingsScreen.isOpen()) window.settingsScreen.close();
  if (window.setupScreen.isOpen()) window.setupScreen.close(); else window.setupScreen.open();
});

if (window.panel.onOpen) {
  window.panel.onOpen((what) => {
    if (what === 'settings' && window.settingsScreen) window.settingsScreen.open();
    if (what === 'setup' && window.setupScreen) window.setupScreen.open();
  });
}

/* Deleting the cluster destroys every database in it. One click must never be enough: the button
 * only reveals a field, and the delete button stays off until the cluster's name is typed. */
const DELETE_WORD = 'minikube';
$('btnDeleteCluster').addEventListener('click', () => {
  const row = $('deleteClusterConfirm');
  row.classList.toggle('hidden');
  $('deleteClusterWord').value = '';
  $('btnDeleteClusterGo').disabled = true;
  if (!row.classList.contains('hidden')) $('deleteClusterWord').focus();
});
$('deleteClusterWord').addEventListener('input', (ev) => {
  $('btnDeleteClusterGo').disabled = ev.target.value.trim() !== DELETE_WORD;
});
$('btnDeleteClusterGo').addEventListener('click', async () => {
  if ($('deleteClusterWord').value.trim() !== DELETE_WORD) return;
  $('deleteClusterConfirm').classList.add('hidden');
  await window.panel.action('delete-cluster', { confirm: true });
});

$('btnPurge').addEventListener('click', async () => {
  const btn = $('btnPurge');
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = t('ui.purge.confirm');
    setTimeout(() => {
      if (btn.dataset.armed === '1') { btn.dataset.armed = '0'; btn.textContent = t('ui.purge'); }
    }, 4000);
    return;
  }
  btn.dataset.armed = '0';
  btn.textContent = t('ui.purge');
  await window.panel.action('purge-scylla');
});

/* ── build an image (dev-projects.yaml) ────────────────────────────────
   One list, read from the repository: every target it declares can be built from its sources. */

async function loadBuildTargets() {
  const res = await window.panel.action('read-build-targets');
  if (!res || !res.ok) {
    el.buildTargets.innerHTML = '<div class="hint">'
      + escapeHtml((res && res.detail) || t('ui.build.unreadable')) + '</div>';
    return;
  }
  el.buildTargets.innerHTML = res.targets.map((target) =>
    '<div class="conf-row build-row">'
      + '<span class="build-name">' + escapeHtml(target.name) + '</span>'
      + (target.initContainer ? '<span class="tag">init ' + escapeHtml(target.initContainer) + '</span>' : '')
      + '<button class="btn small" data-build="' + escapeHtml(target.name) + '" title="'
      + escapeHtml(t('ui.build.tip', { name: target.name, path: target.path || '?', deployment: target.deployment || '?' }))
      + '">' + escapeHtml(t('ui.build.go')) + '</button>'
    + '</div>'
  ).join('');
}

el.buildTargets.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-build]');
  if (!b) return;
  b.disabled = true;
  b.textContent = t('ui.build.started');
  const res = await window.panel.action('build-image', { target: b.dataset.build });
  if (!res || !res.ok) {
    b.disabled = false;
    b.textContent = t('ui.build.go');
    return;
  }
  // The build lives in the "build" tab and can take minutes: give the button back rather than
  // leave a dead one that would look like a freeze.
  setTimeout(() => { b.disabled = false; b.textContent = t('ui.build.go'); }, 4000);
});

/* ── boot ──────────────────────────────────────────────────────────────── */

restoreUi();
setMatcher();
window.panel.onLogs(addEntries);
window.panel.onCleared(applyCleared);
window.panel.onState(renderState);
window.panel.state().then(renderState);

/* ── search: clear button ──────────────────────────────────────────────
   The field is the only place where a stale query silently hides every line,
   so it must be one click to empty -- not a select-all-and-delete. */
(() => {
  const field = el.search.closest('.search-field');
  const sync = () => field.classList.toggle('has-text', el.search.value.length > 0);
  el.search.addEventListener('input', sync);
  el.search.addEventListener('keyup', sync);
  el.searchClear.addEventListener('click', () => {
    el.search.value = '';
    ui.query = '';
    currentMatch = -1;
    sync();
    recompute();
    el.search.focus();
  });
  sync();
})();

/* ── a card's help goes behind a "?" ───────────────────────────────────
   Done here rather than in the HTML so that any card carrying a .hint gets it, including the
   ones added later. Only the .hint that are DIRECT children of the card are moved: those inside
   a fold (the red zone) are already hidden and must stay where they are. */
(() => {
  document.querySelectorAll('.card').forEach((card) => {
    const hint = card.querySelector(':scope > .hint');
    const h2 = card.querySelector(':scope > h2');
    if (!hint || !h2) return;

    const help = document.createElement('span');
    help.className = 'help';
    help.tabIndex = 0;
    help.setAttribute('role', 'button');
    help.setAttribute('aria-label', t('ui.help'));
    help.append('?');

    const bubble = document.createElement('div');
    bubble.className = 'help-bubble';
    bubble.innerHTML = hint.innerHTML;

    help.appendChild(bubble);
    h2.appendChild(help);
    hint.remove();
  });
})();
