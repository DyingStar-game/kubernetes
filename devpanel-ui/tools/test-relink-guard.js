'use strict';

/*
 * The relink guard: restarting horizon makes it DELIVER THE WORLD AGAIN, and a second delivery onto a
 * game server that already holds one does not plateau -- it climbs (~50 MB/s, measured to 26 GB, which
 * suffocates minikube). So a relink onto such a server must restart it first.
 *
 * Three things went wrong, and all three are covered here:
 *   - the guard rolled horizon before the fresh server had finished loading, so no link came up;
 *   - restarting the server made the WATCHER see a new PID and fire a second relink behind it;
 *   - and the delivery check keyed on a horizon message that means nothing (see _worldDelivered),
 *     so it always said "lost" and retried -- delivering the world three times over, which is
 *     precisely the runaway the guard exists to prevent.
 *
 * Run: npm run test:relink
 */

const { RelinkWatcher } = require('../src/main/relink');

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log('  OK    ' + label);
  } else {
    failed += 1;
    console.log('  ECHEC ' + label);
  }
}

/** A watcher wired to fakes, with the kubectl-touching parts replaced. */
function makeWatcher({ listenPid, loadedMarker = true, propsArrive = true, linked = true, graceMs = 0 }) {
  const calls = { stopped: 0, started: 0, rolled: 0 };
  let pid = listenPid;

  const log = {
    seq: 100,
    lines: [],
    note(t) { this.lines.push(String(t)); },
    // Only answers "server loaded" once the fake server has been (re)started, like the real one.
    search({ q }) {
      if (q && q.includes('server loaded')) {
        return { lines: loadedMarker && calls.started > 0 ? [{ i: 2, text: 'server loaded' }] : [] };
      }
      // The delivery marker: the server saying it received every initial object, seen only after
      // horizon was restarted.
      if (q && q.includes('All initial objects loaded')) {
        return { lines: propsArrive && calls.rolled > 0 ? [{ i: 200, text: 'All initial objects loaded' }] : [] };
      }
      return { lines: [{ i: 1, text: 'boot' }] };
    },
    sourceList() { return [{ name: 'godot-server', last: Date.now() }]; },
  };

  const w = new RelinkWatcher({
    config: {
      ports: { gameServer: 8980, horizon: 7040 },
      k8s: { namespace: 'ns', horizonDeployment: 'horizon' },
      timeouts: { serverSettleMs: 3000, relinkMs: 3000, worldDeliveryMs: 4000 },
      relink: { maxAttempts: 1, maxConsecutiveFailures: 2, graceMs },
    },
    // `linked` may be a function of how many times horizon was restarted so far.
    probes: {
      gameServer: async () => ({
        ok: true, listenPid: pid, linked: typeof linked === 'function' ? linked(calls) : linked,
      }),
    },
    log,
    godot: {
      stopServer() { calls.stopped += 1; pid = null; },
      async startServer() { calls.started += 1; pid = 4242; return { ok: true }; },
    },
  });

  // Never touch a real cluster.
  w._rollHorizon = async () => { calls.rolled += 1; return { ok: true }; };
  w._blockers = async () => [];

  return { w, calls, log };
}

async function main() {
  console.log('--- cas 1 : le serveur a deja recu le monde -> il est redemarre AVANT horizon ---');
  {
    const { w, calls, log } = makeWatcher({ listenPid: 1111 });
    w.worldDeliveredPid = 1111;   // this very server was fed
    await w.relink('', { force: true });
    ok(calls.stopped === 1 && calls.started === 1, 'le serveur est redemarre');
    ok(calls.rolled === 1, 'horizon est roule ensuite');
    ok(w.lastPid === 4242, 'le nouveau PID est ADOPTE (le veilleur ne relinkera pas derriere)');
    ok(log.lines.some((l) => l.includes('finished loading')),
      'on attend la fin du chargement, pas seulement le silence');
  }

  console.log('\n--- cas 2 : serveur neuf (jamais nourri) -> on ne le redemarre pas ---');
  {
    const { w, calls } = makeWatcher({ listenPid: 2222 });
    w.worldDeliveredPid = 9999;   // a PREVIOUS server was fed, not this one
    await w.relink('', { force: true });
    ok(calls.stopped === 0 && calls.started === 0, 'aucun redemarrage inutile');
    ok(calls.rolled === 1, 'horizon est roule directement');
  }

  console.log('\n--- cas 3 : rien n a jamais ete livre -> pas de redemarrage ---');
  {
    const { w, calls } = makeWatcher({ listenPid: 3333 });
    await w.relink('', { force: true });
    ok(calls.stopped === 0, 'le premier relink ne redemarre rien');
    ok(calls.rolled === 1, 'horizon est roule');
  }

  console.log('\n--- cas 4 : le marqueur de chargement n arrive jamais -> on n attend pas indefiniment ---');
  {
    const { w, calls, log } = makeWatcher({ listenPid: 4444, loadedMarker: false });
    w.worldDeliveredPid = 4444;
    const started = Date.now();
    await w.relink('', { force: true });
    const waited = Date.now() - started;
    ok(calls.rolled === 1, 'horizon finit par etre roule');
    ok(waited < 10000, 'l attente est bornee (' + waited + ' ms)');
    ok(log.lines.some((l) => l.includes('anyway')), 'et l abandon est dit dans le journal');
  }

  console.log('\n--- cas 5 : la livraison se lit sur le SERVEUR, pas sur le message mort d horizon ---');
  {
    const { w, calls } = makeWatcher({ listenPid: 5555 });
    const r = await w.relink('', { force: true });
    ok(r.ok === true, 'le monde est declare livre quand un prop apparait cote serveur');
    ok(w.worldDelivered === true, 'l etat est marque livre');
    ok(calls.rolled === 1, 'horizon n est roule qu UNE fois');
  }

  console.log('\n--- cas 6 : aucun prop n arrive -> on abandonne SANS relivrer ---');
  {
    const { w, calls, log } = makeWatcher({ listenPid: 6666, propsArrive: false });
    const r = await w.relink('', { force: true });
    ok(r.ok === false, 'l echec est signale');
    ok(calls.rolled === 1, 'horizon n est PAS roule une 2e fois (c est ca l emballement memoire)');
    ok(log.lines.some((l) => l.includes('NOT retrying')), 'et le journal dit pourquoi');
  }

  console.log('\n--- cas 7 : horizon retrouve le serveur tout seul -> on ne redemarre RIEN ---');
  {
    const { w, calls, log } = makeWatcher({ listenPid: 7777, linked: true, graceMs: 3000 });
    calls.rolled = 1;                // the fake "world arrived" marker only shows after a delivery
    const r = await w.relink('nouveau serveur');
    ok(r.ok === true && r.restarted === false, 'le lien est declare bon sans redemarrage');
    ok(calls.rolled === 1, 'horizon n est PAS redemarre');
    ok(calls.stopped === 0 && calls.started === 0, 'le serveur de jeu n est pas redemarre non plus');
    ok(w.worldDelivered === true && w.worldDeliveredPid === 7777, 'le monde est note comme livre a ce serveur');
    ok(log.lines.some((l) => l.includes('by itself')), 'et le journal le dit');
  }

  console.log('\n--- cas 8 : pas de lien apres le delai -> la, on redemarre horizon ---');
  {
    // Not linked until horizon has been restarted once.
    const { w, calls } = makeWatcher({ listenPid: 8888, linked: (c) => c.rolled > 0, graceMs: 1500 });
    const started = Date.now();
    const r = await w.relink('nouveau serveur');
    ok(r.ok === true, 'le relink aboutit');
    ok(calls.rolled === 1, 'horizon est redemarre une fois');
    ok(Date.now() - started >= 1400, 'mais seulement apres avoir laisse le delai (' + (Date.now() - started) + ' ms)');
  }

  console.log('\n--- cas 9 : le bouton manuel ne patiente pas ---');
  {
    const { w, calls } = makeWatcher({ listenPid: 9999, linked: true, graceMs: 60000 });
    const started = Date.now();
    await w.relink('manual request', { force: true });
    ok(calls.rolled === 1, 'horizon est redemarre meme si le lien est bon');
    ok(Date.now() - started < 20000, 'sans attendre le delai');
  }

  console.log('\n--- cas 10 : deux demandes en meme temps -> un seul redemarrage ---');
  {
    const { w, calls } = makeWatcher({ listenPid: 1010, linked: (c) => c.rolled > 0 });
    const [a, b] = await Promise.all([w.relink('chaine'), w.relink('veilleur')]);
    ok(calls.rolled === 1, 'horizon est redemarre une seule fois');
    ok(a === b && a.ok === true, 'les deux demandes recoivent la meme reponse');
  }

  console.log('\n--- cas 11 : pas de route vers le serveur local -> horizon est laisse tranquille ---');
  {
    const { w, calls, log } = makeWatcher({ listenPid: 1111, linked: false });
    let road = false;
    w.canLink = async () => road;
    const signal = { aborted: false };
    await w._tick(signal);
    await w._tick(signal);
    ok(calls.rolled === 0, 'aucun redemarrage tant que le serveur n est pas intercepte');
    ok(w.lastPid == null, 'le serveur n est pas adopte');
    ok(log.lines.filter((l) => l.includes('no road')).length === 1, 'dit une seule fois');
    road = true;
    w._canLinkAt = 0;
    await w._tick(signal);
    ok(w.lastPid === 1111, 'la route ouverte, le serveur est pris en charge');
  }

  console.log('\nResultat : ' + passed + ' reussis, ' + failed + ' echoues.');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
