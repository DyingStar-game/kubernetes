'use strict';

/* DyingStar dev panel - setup assistant.
 *
 * One screen that answers "what does this machine still lack to run the project?" and offers a
 * button for each missing thing. It draws what the main process reports (src/main/setup.js) and
 * asks again every few seconds while it is open, so a download or a clone shows its progress and
 * turns green by itself.
 *
 * It never decides anything: every button is one action of the main process, and what an action
 * prints goes to the "setup" log tab. */

(() => {
  const root = document.getElementById('setup');
  if (!root || !window.panel || !window.panel.setup) return;

  const t = window.t;
  const REFRESH_MS = 2500;

  let model = null;
  let timer = null;
  let message = '';      // the answer of the last action, when it was a refusal

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (name === 'class') node.className = value;
      else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
      else node.setAttribute(name, value === true ? '' : String(value));
    }
    // Fully flattened: a step is handed lists of rows, themselves built from lists.
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const isOpen = () => !root.classList.contains('hidden');

  async function refresh() {
    try {
      model = await window.panel.setup.get();
    } catch {
      return;          // a main process from before the assistant: nothing to show
    }
    if (isOpen()) render();
  }

  async function open() {
    message = '';
    root.classList.remove('hidden');
    await refresh();
    clearInterval(timer);
    timer = setInterval(refresh, REFRESH_MS);
  }

  function close() {
    clearInterval(timer);
    timer = null;
    root.classList.add('hidden');
  }

  /** Run one action of the main process, then look again at once. */
  async function act(action, payload) {
    message = '';
    const result = await window.panel.action(action, payload);
    if (result && result.ok === false && result.detail) message = result.detail;
    await refresh();
  }

  // --- pieces -------------------------------------------------------------------

  /** "42 %" or "12 MB" while something is being fetched. */
  function progressText(busy) {
    if (!busy) return '';
    if (busy.total > 0) return Math.floor((busy.received / busy.total) * 100) + ' %';
    if (busy.received > 0) return Math.round(busy.received / 1048576) + ' MB';
    return t('setup.working');
  }

  function chip(ok, textOk, textBad, busy) {
    if (busy) return h('span', { class: 'chip detected' }, progressText(busy));
    return h('span', { class: 'chip ' + (ok ? 'ok' : 'bad') }, ok ? textOk : textBad);
  }

  function row(name, status, detail, button, error) {
    return h('div', { class: 'setup-row' },
      h('div', { class: 'setup-name' }, name),
      h('div', { class: 'setup-state' }, status),
      h('div', { class: 'setup-detail' }, detail, error ? h('div', { class: 'field-error' }, error) : null),
      h('div', { class: 'setup-act' }, button));
  }

  function button(label, onclick, { primary = false, disabled = false } = {}) {
    return h('button', {
      class: 'btn small' + (primary ? ' btn-primary' : ''), type: 'button', disabled, onclick,
    }, label);
  }

  function step(number, title, done, help, ...rows) {
    return h('section', { class: 'settings-section setup-step' + (done ? ' done' : '') },
      h('h2', null, h('span', { class: 'setup-num' }, done ? '✓' : String(number)), title),
      h('p', { class: 'setup-help' }, help),
      rows);
  }

  // --- the steps ----------------------------------------------------------------

  function workspaceStep() {
    const choose = async () => {
      const picked = await window.panel.settings.pickPath({ type: 'directory', current: model.workspace || '' });
      if (!picked) return;
      await window.panel.settings.set({ 'paths.workspace': picked });
      await refresh();
    };
    return step(1, t('setup.ws.title'), model.workspaceOk, t('setup.ws.help'),
      row(t('setup.ws.folder'),
        chip(model.workspaceOk, t('setup.found'), t('setup.toChoose')),
        model.workspace || '—',
        button(t('setup.ws.choose'), choose, { primary: !model.workspaceOk })));
  }

  function toolsStep() {
    const binaries = model.tools.map((tool) => {
      const why = { missing: t('setup.missing'), 'too-old': t('setup.tooOld', { version: tool.version }),
        'too-new': t('setup.tooNew', { version: tool.version }), unreadable: t('setup.missing') }[tool.reason];
      return row(tool.id,
        chip(tool.ok, tool.version || '', why || t('setup.missing'), tool.busy),
        tool.ok ? t('setup.tool.ok') : t('setup.tool.fetch', { version: tool.wanted }),
        tool.ok || !tool.installable ? null
          : button(t('setup.fetch'), () => act('setup-install-tool', { id: tool.id }), { primary: true, disabled: !!tool.busy }),
        tool.error);
    });
    const system = model.system.map((tool) => row(tool.id,
      chip(tool.ok, t('setup.found'), t('setup.missing'), tool.busy),
      tool.ok ? t('setup.sys.ok')
        : tool.canInstall
          ? t(tool.restart ? 'setup.sys.wingetRestart' : 'setup.sys.winget')
          : h('span', null, t('setup.sys.manual') + ' ', h('code', null, tool.linux || tool.url)),
      tool.ok ? null
        : tool.canInstall
          ? button(t('setup.install'), () => act('setup-install-system', { id: tool.id }), { primary: true, disabled: !!tool.busy })
          : null,
      tool.error));
    const done = model.tools.every((x) => x.ok) && model.system.every((x) => x.ok);
    return step(2, t('setup.tools.title'), done, t('setup.tools.help'), system, binaries);
  }

  function reposStep() {
    const git = (model.system.find((x) => x.id === 'git') || {}).ok;
    const rows = model.repos.map((repo) => row(repo.folder,
      chip(repo.ok, t('setup.found'), t('setup.missing'), repo.busy),
      repo.ok ? repo.dir
        : t(repo.sizeMb > 500 ? 'setup.repo.big' : 'setup.repo.small', { size: repo.sizeMb, folder: repo.folder }),
      repo.ok ? null
        : button(t('setup.clone'), () => act('setup-clone', { id: repo.id }),
          { primary: true, disabled: !!repo.busy || !model.workspaceOk || !git }),
      repo.error));
    return step(3, t('setup.repos.title'), model.repos.every((x) => x.ok), t('setup.repos.help'), rows);
  }

  function godotStep() {
    const g = model.godot;
    if (!g.needed) return null;
    return step(4, t('setup.godot.title'), g.ok && g.nupkgsOk, t('setup.godot.help'),
      row('Godot' + (g.wanted ? ' ' + g.wanted : ''),
        chip(g.ok, t('setup.found'), t('setup.missing'), g.busy),
        g.ok ? g.exe : t('setup.godot.fetch'),
        g.ok ? null
          : button(t('setup.fetch'), () => act('setup-fetch-godot'), { primary: true, disabled: !!g.busy || !model.workspaceOk }),
        g.error),
      row(t('setup.godot.nupkgs'),
        chip(g.nupkgsOk, t('setup.found'), t('setup.missing')),
        g.nupkgsOk ? g.nupkgs : t('setup.godot.nupkgsHelp'), null));
  }

  function stackStep() {
    if (model.modules && model.modules.cluster === false) return null;
    const stack = model.stack;
    const kube = model.repos.find((x) => x.id === 'kubernetes');
    const ready = !!stack && stack.ok;
    return step(5, t('setup.stack.title'), ready, t('setup.stack.help'),
      row(t('setup.stack.name'),
        chip(ready, stack ? stack.detail : '', stack && stack.detail ? stack.detail : t('setup.stack.none')),
        ready ? t('setup.stack.ok') : t('setup.stack.start'),
        ready ? null
          : button(t('ui.stack.start'), () => { act('start-stack'); }, { primary: true, disabled: !(kube && kube.ok) })));
  }

  function render() {
    if (!model) return;
    const keep = root.querySelector('.settings-body');
    const scrollTop = keep ? keep.scrollTop : 0;
    const steps = [workspaceStep(), toolsStep(), reposStep(), godotStep(), stackStep()].filter(Boolean);
    const allDone = steps.every((s) => s.classList.contains('done'));

    root.replaceChildren(...[
      h('div', { class: 'settings-head' },
        h('h1', null, t('setup.title')),
        h('span', { class: 'settings-file' }, t('setup.subtitle'))),
      h('div', { class: 'settings-body' },
        h('div', { class: 'settings-inner' },
          allDone ? h('div', { class: 'settings-notice ok' }, t('setup.allDone')) : null,
          message ? h('div', { class: 'settings-notice bad' }, message) : null,
          steps)),
      h('div', { class: 'settings-foot' },
        h('span', { class: 'settings-note' }, t('setup.logHint')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, t('setup.close'))),
    ].filter(Boolean));

    root.querySelector('.settings-body').scrollTop = scrollTop;
  }

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && isOpen()) { ev.stopPropagation(); close(); }
  }, true);

  window.setupScreen = { open, close, isOpen };
})();
