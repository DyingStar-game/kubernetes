'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Player tokens for the game clients the panel launches.
 *
 * The game only gets a player token from `--token=` (the launcher's job). Without one, every
 * service the client calls answers 401 and its screens stay empty. The dev realm has a client
 * made for this (public, password grant, long-lived access token) and test accounts recreated on
 * every ArgoCD sync (keycloak-managed/dev in the kubernetes repository), password = username.
 * They exist in the LOCAL dev realm only: nothing here is a real credential.
 *
 * Client N plays as TEST_PLAYERS[N-1], so two clients side by side are two different players.
 * Tokens are cached in <data dir>/runtime/player-tokens.json and reused until a day before they
 * expire. Any failure (Keycloak down, name not resolving) only logs a warning: the client still
 * starts, token-less.
 */
const TEST_PLAYERS = [
  'player-kira', 'player-orin', 'player-mara', 'player-silas',
  'player-juno', 'player-tess', 'player-dax', 'player-pell',
];
const RENEW_BEFORE_S = 24 * 3600;
const TIMEOUT_MS = 8000;

class DevToken {
  constructor({ runtimeDir, log, config }) {
    this.file = path.join(runtimeDir, 'player-tokens.json');
    this.log = log;
    this.cfg = config;
  }

  /** The test account client [index] (0-based) plays as. */
  static playerFor(index) {
    return TEST_PLAYERS[index % TEST_PLAYERS.length];
  }

  /** Seconds since epoch at which [token] expires (its `exp` claim), 0 when unreadable. */
  static expiryOf(token) {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      return Number(payload.exp) || 0;
    } catch {
      return 0;
    }
  }

  /** A valid token for [username], from the cache or Keycloak; null when none could be had. */
  async tokenFor(username) {
    const auth = (this.cfg && this.cfg.auth) || {};
    if (auth.playerTokens === false || !auth.tokenUrl || !auth.clientId) return null;

    const cache = this._read();
    const cached = cache[username];
    if (cached && DevToken.expiryOf(cached) - Date.now() / 1000 > RENEW_BEFORE_S) return cached;
    try {
      const res = await fetch(auth.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password', client_id: auth.clientId, username, password: username, scope: 'openid',
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error('Keycloak HTTP ' + res.status);
      const token = (await res.json()).access_token;
      if (!token) throw new Error('no access_token in the answer');
      cache[username] = token;
      this._write(cache);
      return token;
    } catch (err) {
      this.log.note('No player token for ' + username + ' (' + err.message
        + '): the client starts WITHOUT a token, the in-game services will answer 401.', 'WARN');
      return null;
    }
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  _write(cache) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Owner-only: these are bearer tokens, even if only for a local dev realm.
      fs.writeFileSync(this.file, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      this.log.note('Player token cache not written: ' + err.message, 'WARN');
    }
  }
}

module.exports = { DevToken, TEST_PLAYERS };
