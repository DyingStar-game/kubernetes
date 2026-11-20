'use strict';

/* DyingStar dev panel - settings screen.
 *
 * Nothing here knows any particular setting: the form is generated from what the main process
 * describes (src/main/settings-schema.js), so a new setting shows up without a line of UI code.
 *
 * Edits are kept apart from the model until "Save": typing never changes anything by itself,
 * and a rejected save leaves what was typed in place, next to the reason. */

(() => {
  const root = document.getElementById('settings');
  if (!root || !window.panel || !window.panel.settings) return;

  const TEXT = {
    en: {
      title: 'Settings',
      save: 'Save',
      saved: 'Saved',
      close: 'Close',
      browse: 'Browse…',
      reset: 'Back to automatic',
      advanced: 'Advanced settings',
      chosen: 'chosen',
      detected: 'detected',
      byDefault: 'default',
      notFound: 'not found',
      notSet: 'not set',
      required: 'required',
      unsaved: 'Unsaved changes',
      missing: 'To fill in before the panel can do its job:',
      restartNote: 'Some changes only apply after a restart of the panel:',
      restartNow: 'Restart the panel',
      needsRestart: 'applies after a restart',
      prerequisites: 'Prerequisites',
      toolsHelp: 'The command-line tools the panel and the repository\'s scripts call. A red one is not on your PATH.',
      check: 'Run the full check',
      checkHelp: 'Runs the repository\'s check-dev script (versions, memory, disk); its report opens in the "check-dev" tab.',
      dataDir: 'Data folder',
      dataDirHelp: 'Your settings, the log files and the local API token live here.',
      open: 'Open',
      shim: 'a .cmd wrapper the panel cannot start',
      discard: 'Discard the unsaved changes?',
      listHint: 'one per line',
      problems: 'Problems found in config.json:',
      profile: 'Profile',
      profileHelp: 'A profile decides which parts of the panel you see and use. It never changes what the cluster deploys.',
      noProfile: '(none: show everything)',
      chooseProfile: 'Choose a profile: until you do, the panel shows everything.',
      modules: 'What the panel takes care of',
      fromProfile: 'profile',
      forced: 'your choice',
      needs: 'needs',
      followProfile: 'Follow the profile again',
      userProfiles: 'Your own profiles go in',
      profileSource: 'profile',
    },
    fr: {
      title: 'Réglages',
      save: 'Enregistrer',
      saved: 'Enregistré',
      close: 'Fermer',
      browse: 'Parcourir…',
      reset: 'Revenir à l\'automatique',
      advanced: 'Réglages avancés',
      chosen: 'choisi',
      detected: 'détecté',
      byDefault: 'par défaut',
      notFound: 'introuvable',
      notSet: 'non renseigné',
      required: 'obligatoire',
      unsaved: 'Modifications non enregistrées',
      missing: 'À remplir pour que le panneau puisse faire son travail :',
      restartNote: 'Certains changements ne s\'appliquent qu\'après un redémarrage du panneau :',
      restartNow: 'Redémarrer le panneau',
      needsRestart: 's\'applique après un redémarrage',
      prerequisites: 'Prérequis',
      toolsHelp: 'Les outils en ligne de commande qu\'appellent le panneau et les scripts du dépôt. Un outil en rouge n\'est pas dans ton PATH.',
      check: 'Lancer la vérification complète',
      checkHelp: 'Lance le script check-dev du dépôt (versions, mémoire, disque) ; son rapport s\'ouvre dans l\'onglet « check-dev ».',
      dataDir: 'Dossier de données',
      dataDirHelp: 'Tes réglages, les fichiers de journal et le jeton de l\'API locale sont rangés ici.',
      open: 'Ouvrir',
      shim: 'un lanceur .cmd que le panneau ne sait pas démarrer',
      discard: 'Abandonner les modifications non enregistrées ?',
      listHint: 'un par ligne',
      problems: 'Problèmes trouvés dans config.json :',
      profile: 'Profil',
      profileHelp: 'Un profil décide de ce que tu vois et utilises dans le panneau. Il ne change jamais ce que le cluster déploie.',
      noProfile: '(aucun : tout afficher)',
      chooseProfile: 'Choisis un profil : en attendant, le panneau affiche tout.',
      modules: 'Ce dont le panneau s\'occupe',
      fromProfile: 'profil',
      forced: 'ton choix',
      needs: 'nécessite',
      followProfile: 'Suivre de nouveau le profil',
      userProfiles: 'Tes propres profils vont dans',
      profileSource: 'profil',
    },
  };

  let lang = 'en';
  const t = (key) => (TEXT[lang] && TEXT[lang][key]) || TEXT.en[key] || key;

  let model = null;          // what the main process last described
  const edits = new Map();   // key -> typed value, not saved yet; null = "back to automatic"
  let errors = {};           // key -> message, from the last rejected save
  let savedFlash = false;

  /** createElement with attributes and children; text is always set as text, never as HTML. */
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (name === 'class') node.className = value;
      else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
      else if (name === 'value') node.value = value;
      else if (name === 'checked') node.checked = !!value;
      else node.setAttribute(name, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const isOpen = () => !root.classList.contains('hidden');
  const dirty = () => edits.size > 0;

  async function open() {
    model = await window.panel.settings.get();
    lang = model.language === 'fr' ? 'fr' : 'en';
    edits.clear();
    errors = {};
    savedFlash = false;
    render();
    root.classList.remove('hidden');
  }

  function close() {
    if (dirty() && !window.confirm(t('discard'))) return;
    edits.clear();
    root.classList.add('hidden');
  }

  /** The entry as it would be once the pending edit is saved. */
  function viewOf(entry) {
    if (!edits.has(entry.key)) return { value: entry.value, source: entry.source, exists: entry.exists, edited: false };
    const typed = edits.get(entry.key);
    if (typed === null) return { value: entry.fallback.value, source: entry.fallback.source, exists: undefined, edited: true };
    return { value: typed, source: 'user', exists: undefined, edited: true };
  }

  function setEdit(entry, value) {
    const unchanged = value !== null && entry.source === 'user'
      && JSON.stringify(value) === JSON.stringify(entry.type === 'list' ? (entry.value || []).join('\n') : entry.value);
    if (unchanged) edits.delete(entry.key);
    else edits.set(entry.key, value);
    delete errors[entry.key];
    savedFlash = false;
    syncFooter();
  }

  // --- one field --------------------------------------------------------------

  function control(entry, view) {
    const onText = (ev) => setEdit(entry, ev.target.value);
    switch (entry.type) {
      case 'bool':
        return h('label', { class: 'field-check' },
          h('input', {
            type: 'checkbox', checked: !!view.value,
            onchange: (ev) => setEdit(entry, ev.target.checked),
          }));
      case 'enum':
        return h('select', { onchange: onText },
          entry.options.map((opt) => {
            const o = h('option', { value: opt }, opt);
            if (opt === view.value) o.selected = true;
            return o;
          }));
      case 'number':
        return h('input', {
          type: 'number', value: view.value === undefined || view.value === null ? '' : view.value,
          min: entry.min, max: entry.max, oninput: onText,
        });
      case 'list': {
        const lines = Array.isArray(view.value) ? view.value : String(view.value || '').split('\n');
        return h('textarea', {
          rows: Math.max(2, lines.length + 1), spellcheck: 'false', placeholder: t('listHint'),
          value: Array.isArray(view.value) ? view.value.join('\n') : (view.value || ''), oninput: onText,
        });
      }
      case 'file':
      case 'directory':
        return [
          h('input', { type: 'text', spellcheck: 'false', value: view.value || '', oninput: onText }),
          h('button', {
            class: 'btn small', type: 'button',
            onclick: async () => {
              const picked = await window.panel.settings.pickPath({ type: entry.type, current: view.value || '' });
              if (picked) { setEdit(entry, picked); render(); }
            },
          }, t('browse')),
        ];
      default:
        return h('input', { type: 'text', spellcheck: 'false', value: view.value || '', oninput: onText });
    }
  }

  function chips(entry, view) {
    const out = [];
    const sourceText = {
      user: t('chosen'), detected: t('detected'), default: t('byDefault'), profile: t('profileSource'),
    }[view.source];
    const pathLike = entry.type === 'file' || entry.type === 'directory';
    const empty = view.value === '' || view.value === null || view.value === undefined;

    if (pathLike && empty) out.push(h('span', { class: 'chip ' + (entry.required ? 'bad' : '') }, t('notSet')));
    else out.push(h('span', { class: 'chip ' + view.source }, sourceText));

    if (pathLike && !empty && view.exists === false) out.push(h('span', { class: 'chip bad' }, t('notFound')));
    if (entry.restart) out.push(h('span', { class: 'chip' }, t('needsRestart')));
    return out;
  }

  function field(entry) {
    const view = viewOf(entry);
    const canReset = view.source === 'user';
    return h('div', { class: 'field' + (errors[entry.key] ? ' invalid' : '') },
      h('div', { class: 'field-label' },
        entry.label,
        entry.required ? h('span', { class: 'req', title: t('required') }, ' *') : null),
      h('div', { class: 'field-main' },
        h('div', { class: 'field-control' },
          control(entry, view),
          canReset
            ? h('button', {
                class: 'icon-btn', type: 'button', title: t('reset'),
                onclick: () => { edits.set(entry.key, null); delete errors[entry.key]; savedFlash = false; render(); },
              }, '↺')
            : null),
        h('div', { class: 'field-meta' }, chips(entry, view)),
        errors[entry.key] ? h('div', { class: 'field-error' }, errors[entry.key]) : null,
        h('div', { class: 'field-help' }, entry.help)));
  }

  // --- the page ---------------------------------------------------------------

  function section(sec) {
    const plain = sec.entries.filter((e) => !e.advanced);
    const advanced = sec.entries.filter((e) => e.advanced);
    // An advanced field with a pending error or edit must not hide in a closed fold.
    const openFold = advanced.some((e) => errors[e.key] || edits.has(e.key));
    return h('section', { class: 'settings-section' },
      h('h2', null, sec.label),
      plain.map(field),
      advanced.length
        ? h('details', { class: 'advanced', open: openFold },
            h('summary', null, t('advanced') + ' (' + advanced.length + ')'),
            advanced.map(field))
        : null);
  }

  // --- profile and modules ----------------------------------------------------
  //
  // Applied at once, not with "Save": the effect (cards appearing and disappearing behind this
  // screen) is the whole point, and there is nothing typed here that could be half-finished.

  async function setProfile(choice) {
    const result = await window.panel.settings.setProfile(choice);
    if (result && result.settings) model = result.settings;
    render();
  }

  function profileSection() {
    if (!model.modules) return null;          // a main process from before profiles
    const labelOf = (id) => (model.modules.find((m) => m.id === id) || { label: id }).label;
    const current = model.profiles.find((x) => x.id === model.profile) || null;

    const select = h('select', {
      onchange: (ev) => setProfile({ profile: ev.target.value || null, modules: {} }),
    }, [{ id: '', name: t('noProfile') }, ...model.profiles].map((x) => {
      const o = h('option', { value: x.id }, x.name);
      if ((model.profile || '') === x.id) o.selected = true;
      return o;
    }));

    const rows = model.modules.map((mod) => {
      const blocked = mod.blockedBy && mod.blockedBy.length > 0;
      return h('label', { class: 'module-row' + (mod.on ? '' : ' off') },
        h('input', {
          type: 'checkbox', checked: mod.wanted,
          onchange: (ev) => setProfile({ modules: { ...model.overrides, [mod.id]: ev.target.checked } }),
        }),
        h('span', { class: 'module-text' },
          h('span', { class: 'module-name' }, mod.label),
          mod.overridden ? h('span', { class: 'chip user' }, t('forced')) : null,
          blocked && mod.wanted
            ? h('span', { class: 'chip bad' }, t('needs') + ' ' + mod.blockedBy.map(labelOf).join(', '))
            : null,
          h('span', { class: 'module-help' }, mod.help)));
    });

    const hasOverrides = Object.keys(model.overrides || {}).length > 0;
    return h('section', { class: 'settings-section' },
      h('h2', null, t('profile')),
      !model.profile ? h('div', { class: 'settings-notice warn' }, t('chooseProfile')) : null,
      (model.notes || []).length
        ? h('div', { class: 'settings-notice bad' }, h('ul', null, model.notes.map((n) => h('li', null, n))))
        : null,
      h('div', { class: 'field' },
        h('div', { class: 'field-label' }, t('profile')),
        h('div', { class: 'field-main' },
          h('div', { class: 'field-control' }, select),
          current && current.description ? h('div', { class: 'field-help strong' }, current.description) : null,
          h('div', { class: 'field-help' }, t('profileHelp')),
          h('div', { class: 'field-help' }, t('userProfiles') + ' ', h('code', null, model.userProfilesDir || '')))),
      h('div', { class: 'field' },
        h('div', { class: 'field-label' }, t('modules')),
        h('div', { class: 'field-main' },
          rows,
          hasOverrides
            ? h('div', { class: 'field-control' },
                h('button', { class: 'btn small', type: 'button', onclick: () => setProfile({ modules: {} }) },
                  t('followProfile')))
            : null)));
  }

  function prerequisites() {
    const tools = Object.entries(model.tools || {}).map(([name, tool]) => {
      const bad = !tool.found || tool.shim;
      const title = !tool.found ? t('notFound') : tool.shim ? tool.path + ' — ' + t('shim') : tool.path;
      return h('span', { class: 'chip ' + (bad ? 'bad' : 'ok'), title }, name);
    });
    return h('section', { class: 'settings-section' },
      h('h2', null, t('prerequisites')),
      h('div', { class: 'field' },
        h('div', { class: 'field-label' }, 'docker, minikube…'),
        h('div', { class: 'field-main' },
          h('div', { class: 'tool-row' }, tools),
          h('div', { class: 'field-help' }, t('toolsHelp')),
          h('div', { class: 'field-control' },
            h('button', {
              class: 'btn small', type: 'button',
              onclick: async (ev) => {
                ev.target.disabled = true;
                await window.panel.action('check-prerequisites');
                ev.target.disabled = false;
                close();
              },
            }, t('check'))),
          h('div', { class: 'field-help' }, t('checkHelp')))),
      h('div', { class: 'field' },
        h('div', { class: 'field-label' }, t('dataDir')),
        h('div', { class: 'field-main' },
          h('div', { class: 'field-control' },
            h('input', { type: 'text', value: model.dataDir || '', readonly: true }),
            h('button', {
              class: 'btn small', type: 'button',
              onclick: () => window.panel.action('open-data-folder'),
            }, t('open'))),
          h('div', { class: 'field-help' }, t('dataDirHelp')))));
  }

  function notices() {
    const out = [];
    const labelOf = (key) => {
      for (const sec of model.sections) {
        const hit = sec.entries.find((e) => e.key === key);
        if (hit) return hit.label;
      }
      return key;
    };
    if (model.missing && model.missing.length) {
      out.push(h('div', { class: 'settings-notice warn' },
        t('missing') + ' ' + model.missing.map(labelOf).join(', ') + '.'));
    }
    const broken = (model.problems || []).filter((p) => p.level === 'error');
    if (broken.length) {
      out.push(h('div', { class: 'settings-notice bad' },
        t('problems'), h('ul', null, broken.map((p) => h('li', null, p.message)))));
    }
    return out;
  }

  let footNote = null;
  let saveBtn = null;

  function syncFooter() {
    if (!saveBtn) return;
    saveBtn.disabled = !dirty();
    footNote.textContent = dirty() ? t('unsaved') : (savedFlash ? t('saved') : '');
    footNote.className = 'settings-note' + (savedFlash && !dirty() ? ' ok' : '');
  }

  async function save() {
    saveBtn.disabled = true;
    const result = await window.panel.settings.set(Object.fromEntries(edits));
    model = result.settings || model;
    lang = model.language === 'fr' ? 'fr' : 'en';
    if (result.ok) {
      edits.clear();
      errors = {};
      savedFlash = true;
    } else {
      errors = result.errors || {};
    }
    render();
  }

  function restartBar() {
    const pending = model.restartPending || [];
    if (!pending.length) return null;
    const msg = h('span', { class: 'settings-note' }, t('restartNote') + ' ' + pending.join(', '));
    return h('div', { class: 'settings-restart' },
      msg,
      h('button', {
        class: 'btn small btn-warn', type: 'button',
        onclick: async () => {
          const res = await window.panel.settings.restart();
          if (res && res.ok === false) msg.textContent = res.detail;
        },
      }, t('restartNow')));
  }

  function render() {
    const keepScroll = root.querySelector('.settings-body');
    const scrollTop = keepScroll ? keepScroll.scrollTop : 0;

    footNote = h('span', { class: 'settings-note' });
    saveBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: save }, t('save'));

    // replaceChildren() would print a null as the text "null": keep only real nodes.
    root.replaceChildren(...[
      h('div', { class: 'settings-head' },
        h('h1', null, t('title')),
        h('span', { class: 'settings-file', title: model.file }, model.file)),
      h('div', { class: 'settings-body' },
        h('div', { class: 'settings-inner' },
          notices(),
          profileSection(),
          prerequisites(),
          model.sections.map(section))),
      restartBar(),
      h('div', { class: 'settings-foot' },
        footNote,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, t('close')),
        saveBtn),
    ].filter(Boolean));

    root.querySelector('.settings-body').scrollTop = scrollTop;
    syncFooter();
  }

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && isOpen()) { ev.stopPropagation(); close(); }
  }, true);

  window.settingsScreen = { open, close, isOpen };
})();
