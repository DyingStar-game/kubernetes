'use strict';
/**
 * Reproduit le bug : un serveur ecoute deja, on reclique sur "Serveur dedie".
 * Avant le correctif, l'action tuait les "fantomes" -- dont l'enfant du wrapper
 * console, qui detient reellement le port -- puis lancait un rival.
 */
const net = require('node:net');
const path = require('node:path');

const PANEL = path.join(__dirname, '..');
const platform = require(path.join(PANEL, 'src', 'main', 'platform'));
const { Godot } = require(path.join(PANEL, 'src', 'main', 'godot.js'));

const PORT = 18980;   // pas 8980 : on ne veut rien perturber
let passes = 0, echecs = 0;
const t = (nom, cond, detail) => {
  if (cond) { passes++; console.log('  OK    ' + nom); }
  else { echecs++; console.log('  ECHEC ' + nom + (detail ? ' -> ' + detail : '')); }
};

// --- doublures -------------------------------------------------------------
let reapCalls, startCalls, notes, procsRunning, procsSnapshot;

function makeGodot() {
  reapCalls = []; startCalls = []; notes = [];
  return new Godot({
    config: {
      paths: { godotExe: '/fake/godot_console', godotProject: '/fake/project', godotSharpNupkgs: '/fake/nupkgs' },
      ports: { gameServer: PORT },
      godot: { serverArgs: ['--srvini=test/ini/srv1.ini'], serverFeatures: 'dedicated_server' },
    },
    log: { note: (m, lvl) => notes.push((lvl || 'INFO') + ' ' + m) },
    procs: {
      snapshot: () => procsSnapshot,
      isRunning: (id) => procsRunning.includes(id),
      start: (spec) => { startCalls.push(spec); return { id: spec.id, status: 'running' }; },
    },
  });
}

// reapOrphanGodot est remplacee : on veut savoir SI elle est appelee, et avec quoi.
const vraiReap = platform.reapOrphanGodot;
platform.reapOrphanGodot = async (opts) => { reapCalls.push(opts); return { ok: true, killed: 0, detail: 'none' }; };

const listen = (port) => new Promise((res) => {
  const srv = net.createServer();
  srv.listen(port, '0.0.0.0', () => res(srv));
});

(async () => {
  console.log('\n--- cas 1 : un serveur ecoute, lance par le panneau (ton cas) ---');
  const srv = await listen(PORT);
  procsRunning = ['godot-server'];
  procsSnapshot = [{ id: 'godot-server', status: 'running', pid: process.pid }];
  let g = makeGodot();
  let r = await g.startServer();
  t('le demarrage est refuse', r && r.ok === false && r.alreadyRunning === true, JSON.stringify(r));
  t('AUCUN serveur rival lance', startCalls.length === 0, startCalls.length + ' lancement(s)');
  t('AUCUN fantome tue (c est ce qui coupait ton serveur)', reapCalls.length === 0, reapCalls.length + ' reap');
  t('le journal explique que ca tourne deja', notes.some((n) => /already running/.test(n)), notes.join(' | '));

  console.log('\n--- cas 2 : un serveur ecoute, lance HORS du panneau (F5) ---');
  procsRunning = [];
  procsSnapshot = [];
  g = makeGodot();
  r = await g.startServer();
  t('le demarrage est refuse aussi', r && r.alreadyRunning === true);
  t('rien lance, rien tue', startCalls.length === 0 && reapCalls.length === 0);
  t('le journal dit que c est hors du panel', notes.some((n) => /outside the panel/.test(n)), notes.join(' | '));
  t('avertissement, pas simple info', notes.some((n) => n.startsWith('WARN')));

  console.log('\n--- cas 3 : le PID qui tient le port est protege du reap ---');
  procsRunning = ['godot-server'];
  procsSnapshot = [{ id: 'godot-server', status: 'running', pid: 999999 }];  // le wrapper console
  g = makeGodot();
  await g.killOrphanServers();
  const keep = reapCalls[0] ? reapCalls[0].keepPids : [];
  t('le PID du wrapper est garde', keep.includes(999999), JSON.stringify(keep));
  t('le PID qui ecoute vraiment est garde aussi', keep.includes(process.pid), JSON.stringify(keep));

  await new Promise((res) => srv.close(res));

  console.log('\n--- cas 4 : port libre, le demarrage doit avoir lieu ---');
  procsRunning = [];
  procsSnapshot = [];
  g = makeGodot();
  r = await g.startServer();
  t('le serveur est lance', startCalls.length === 1, JSON.stringify(r));
  t('les fantomes sont nettoyes AVANT (port libre = sans risque)', reapCalls.length === 1);
  const spec = startCalls[0] || {};
  t('lance en headless', (spec.args || []).includes('--headless'));
  t('balise dedicated_server posee',
    spec.env && spec.env.GODOT_EDITOR_CUSTOM_FEATURES === 'dedicated_server', JSON.stringify(spec.env));
  t('srvini transmis', (spec.args || []).includes('--srvini=test/ini/srv1.ini'));

  platform.reapOrphanGodot = vraiReap;
  console.log('\nResultat : ' + passes + ' reussis, ' + echecs + ' echoues.');
  process.exit(echecs ? 1 : 0);
})();
