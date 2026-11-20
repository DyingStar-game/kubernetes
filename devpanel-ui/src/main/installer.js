'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { run } = require('./util');
const toolchain = require('./toolchain.json');

/**
 * Fetching what a new machine lacks.
 *
 * Three rules, because this code downloads programs and then runs them:
 *
 *   1. Only from the publisher's own address, written in toolchain.json -- never from a search,
 *      never from a setting.
 *   2. Nothing is used before its SHA-256 matches the one the publisher announces. A file that
 *      does not match is deleted, and the reason is said.
 *   3. Nothing needs elevated rights: each tool is one binary, placed in <data dir>/tools/bin,
 *      which the panel puts at the front of the PATH of everything it starts. The system's own
 *      PATH and the user's other tools are never touched.
 *
 * What cannot be done that way (Docker, git: real installers, with rights and sometimes a
 * restart) is not done silently here; see setup.js.
 */

/** "win32-x64", "linux-x64"... : how toolchain.json names a system. */
function platformKey(platform = process.platform, arch = process.arch) {
  return (platform === 'win32' ? 'win32' : 'linux') + '-' + arch;
}

/** [1, 35, 1] from "v1.35.1+abc"; null when there is no version in the text. */
function parseVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** <0, 0 or >0, like a sort comparator. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Is an installed version good enough for this tool?
 * Too old is not, and neither is a newer MAJOR when the tool caps it: the repository's scripts
 * need Helm 3, and a Helm 4 found first on the PATH breaks them.
 */
function versionVerdict(tool, versionText) {
  const found = parseVersion(versionText);
  if (!found) return { ok: false, reason: 'unreadable' };
  const min = parseVersion(tool.minVersion);
  if (min && compareVersions(found, min) < 0) return { ok: false, reason: 'too-old', version: found.join('.') };
  if (tool.maxMajor && found[0] > tool.maxMajor) return { ok: false, reason: 'too-new', version: found.join('.') };
  return { ok: true, version: found.join('.') };
}

/** SHA-256 of a file, as lowercase hex. */
async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * Download a file and keep it only if its SHA-256 is the expected one.
 *
 * Written to "<dest>.part" first: an interrupted download never leaves something that looks
 * complete. `onProgress(received, total)` is called as bytes arrive (total is 0 when unknown).
 */
async function downloadVerified({ url, dest, sha256, onProgress, fetchImpl = fetch, signal }) {
  if (!/^https:\/\//.test(url) && !/^http:\/\/127\.0\.0\.1[:/]/.test(url)) {
    throw new Error('refusing to download from a non-https address: ' + url);
  }
  if (!/^[0-9a-f]{64}$/.test(String(sha256 || ''))) {
    throw new Error('no SHA-256 to check the download against');
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';

  const res = await fetchImpl(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error('download failed: HTTP ' + res.status + ' for ' + url);
  const total = Number(res.headers.get('content-length')) || 0;

  const hash = crypto.createHash('sha256');
  let received = 0;
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    hash.update(chunk);
    received += chunk.length;
    if (onProgress) onProgress(received, total);
  });
  try {
    await pipeline(source, fs.createWriteStream(part));
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  }

  const actual = hash.digest('hex');
  if (actual !== sha256) {
    fs.rmSync(part, { force: true });
    throw new Error('checksum mismatch for ' + path.basename(dest) + ': expected ' + sha256 + ', got ' + actual
      + '. The file was deleted.');
  }
  fs.rmSync(dest, { force: true });
  fs.renameSync(part, dest);
  return { dest, bytes: received };
}

/**
 * Unpack a .zip or a .tar.gz into a folder, with the system's own `tar`.
 * On Windows that is bsdtar (it reads zip too), asked for by its full path: the first `tar` on
 * the PATH is often Git's GNU tar, which does not read zip.
 */
async function extractArchive(archive, destDir, { platform = process.platform, env = process.env } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const tar = platform === 'win32'
    ? path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const r = await run(tar, ['-xf', archive, '-C', destDir], { timeoutMs: 300000 });
  if (r.code !== 0) throw new Error('could not unpack ' + path.basename(archive) + ': ' + (r.stderr || r.stdout).trim());
}

class Toolchain {
  /**
   * @param {string} toolsDir   <data dir>/tools
   * @param {object} log        the log bus (notes go to the "panel" tab)
   */
  constructor({ toolsDir, log, platform = process.platform, arch = process.arch }) {
    this.binDir = path.join(toolsDir, 'bin');
    this.cacheDir = path.join(toolsDir, 'downloads');
    this.log = log;
    this.key = platformKey(platform, arch);
    this.platform = platform;
    this.tools = toolchain.tools;
  }

  /** Put the panel's own tools ahead of everything else, for every process it starts. */
  prependToPath(env = process.env) {
    const name = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    const parts = String(env[name] || '').split(path.delimiter).filter((p) => p && p !== this.binDir);
    env[name] = [this.binDir, ...parts].join(path.delimiter);
  }

  tool(id) {
    return this.tools.find((t) => t.id === id) || null;
  }

  /**
   * What is this tool's situation: usable as it is, or to be fetched?
   * Asked by running the tool itself, so it answers for what the PATH really resolves to.
   */
  async check(id) {
    const tool = this.tool(id);
    if (!tool) return { id, ok: false, reason: 'unknown' };
    const asset = tool.assets[this.key] || null;
    const r = await run(id, tool.versionArgs, { timeoutMs: 15000 });
    const text = (r.stdout || '') + '\n' + (r.stderr || '');
    const m = text.match(new RegExp(tool.versionPattern));
    if (!m) return { id, ok: false, reason: 'missing', wanted: tool.version, installable: !!asset };
    const verdict = versionVerdict(tool, m[1]);
    return { id, ...verdict, wanted: tool.version, installable: !!asset };
  }

  async checkAll() {
    return Promise.all(this.tools.map((t) => this.check(t.id)));
  }

  /** Fetch one tool into the panel's own folder. Resolves { id, file, version }. */
  async install(id, { onProgress, signal } = {}) {
    const tool = this.tool(id);
    if (!tool) throw new Error('unknown tool: ' + id);
    const asset = tool.assets[this.key];
    if (!asset) throw new Error(id + ' cannot be fetched automatically on this system (' + this.key + ')');

    const target = path.join(this.binDir, asset.file);
    this.log.note('Fetching ' + id + ' ' + tool.version + ' from ' + new URL(asset.url).host + '...');

    if (!asset.archive) {
      await downloadVerified({ url: asset.url, dest: target, sha256: asset.sha256, onProgress, signal });
    } else {
      const archive = path.join(this.cacheDir, path.basename(new URL(asset.url).pathname));
      const unpacked = path.join(this.cacheDir, id + '-' + tool.version);
      await downloadVerified({ url: asset.url, dest: archive, sha256: asset.sha256, onProgress, signal });
      fs.rmSync(unpacked, { recursive: true, force: true });
      await extractArchive(archive, unpacked, { platform: this.platform });
      const member = path.join(unpacked, ...asset.member.split('/'));
      if (!fs.existsSync(member)) throw new Error(asset.member + ' is not in the archive of ' + id);
      fs.mkdirSync(this.binDir, { recursive: true });
      fs.copyFileSync(member, target);
      fs.rmSync(unpacked, { recursive: true, force: true });
      fs.rmSync(archive, { force: true });
    }
    if (this.platform !== 'win32') fs.chmodSync(target, 0o755);
    this.log.note(id + ' ' + tool.version + ' is ready (checksum verified): ' + target);
    return { id, file: target, version: tool.version };
  }
}

module.exports = {
  Toolchain, platformKey, parseVersion, compareVersions, versionVerdict, sha256Of, downloadVerified, extractArchive,
};
