/**
 * ATMOS MARKET — Kalshi RSA Authentication
 * atmos-kalshi-auth.js
 *
 * Implements Kalshi's RSA-PSS JWT signing spec.
 * The private key NEVER leaves this device.
 * Stored in sessionStorage (cleared on tab close) — user re-imports each session.
 *
 * Kalshi auth flow:
 *   1. User creates RSA key pair on kalshi.com → Settings → API
 *   2. Kalshi stores the PUBLIC key against a key_id UUID
 *   3. To authenticate: sign a timestamp string with the PRIVATE key
 *   4. Send: Authorization: <key_id>:<base64_signature>
 *   5. Kalshi verifies the signature using the stored public key
 *
 * Spec reference: https://trading-api.kalshi.com/trade-api/v2/docs
 */

// ─── KEY STORAGE (session only — never persisted to disk) ──
const KEY_STORE_KEY = 'atmos_kalshi_privkey_jwk';
let _cryptoKey = null;  // CryptoKey object, lives only in memory this tab

// ─── IMPORT FLOW ──────────────────────────────────────────

/**
 * Import a PEM-encoded RSA private key from the user's paste/file.
 * Converts to CryptoKey via SubtleCrypto.
 * Stores the JWK form in sessionStorage for the duration of the tab session.
 *
 * @param {string} pem  — full PEM string including -----BEGIN/END----- headers
 * @returns {CryptoKey}
 */
async function importKalshiPrivateKey(pem) {
  const cleaned = pem
    .replace(/-----BEGIN[^-]+-----/, '')
    .replace(/-----END[^-]+-----/, '')
    .replace(/\s+/g, '');

  let der;
  try {
    der = base64ToArrayBuffer(cleaned);
  } catch {
    throw new Error('Could not decode PEM — make sure you pasted the full key including headers.');
  }

  let key;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSA-PSS', hash: 'SHA-256' },
      true,   // extractable — needed to export to JWK for sessionStorage
      ['sign']
    );
  } catch (e) {
    // Try RSASSA-PKCS1-v1_5 as fallback (some Kalshi keys are PKCS1)
    try {
      key = await crypto.subtle.importKey(
        'pkcs8',
        der,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        true,
        ['sign']
      );
    } catch {
      throw new Error('Invalid private key format. Kalshi keys must be RSA (PKCS8 PEM). Got: ' + e.message);
    }
  }

  // Stash JWK in sessionStorage so key survives page refreshes this session
  const jwk = await crypto.subtle.exportKey('jwk', key);
  sessionStorage.setItem(KEY_STORE_KEY, JSON.stringify(jwk));
  _cryptoKey = key;

  return key;
}

/**
 * Restore a CryptoKey from sessionStorage on page reload.
 * Called during init — silently succeeds or fails.
 */
async function restoreKalshiKey() {
  const stored = sessionStorage.getItem(KEY_STORE_KEY);
  if (!stored) return null;

  try {
    const jwk = JSON.parse(stored);
    const algo = jwk.alg?.startsWith('PS') ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5';
    _cryptoKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: algo, hash: 'SHA-256' },
      false,  // not re-extractable from restored key
      ['sign']
    );
    return _cryptoKey;
  } catch {
    sessionStorage.removeItem(KEY_STORE_KEY);
    return null;
  }
}

/**
 * Clear the private key from memory and sessionStorage.
 * Called on disconnect or sign-out.
 */
function clearKalshiKey() {
  _cryptoKey = null;
  sessionStorage.removeItem(KEY_STORE_KEY);
}

function hasKalshiKey() {
  return _cryptoKey !== null || !!sessionStorage.getItem(KEY_STORE_KEY);
}

// ─── SIGNING ──────────────────────────────────────────────

/**
 * Build the Authorization header value Kalshi expects.
 *
 * Format:  <key_id>:<base64url(RSA-PSS-SHA256(timestamp_ms_string))>
 *
 * @param {string} keyId  — the UUID from kalshi.com → Settings → API
 * @returns {string}      — full header value
 */
async function buildKalshiAuthHeader(keyId) {
  if (!_cryptoKey) {
    const restored = await restoreKalshiKey();
    if (!restored) throw new Error('No Kalshi private key loaded. Please reconnect.');
  }

  const timestamp = String(Date.now());
  const encoded   = new TextEncoder().encode(timestamp);

  let sigBuffer;
  try {
    sigBuffer = await crypto.subtle.sign(
      { name: 'RSA-PSS', saltLength: 32 },
      _cryptoKey,
      encoded
    );
  } catch {
    // Fallback for PKCS1 keys
    sigBuffer = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      _cryptoKey,
      encoded
    );
  }

  const sigB64 = arrayBufferToBase64Url(sigBuffer);
  return `${keyId}:${sigB64}`;
}

/**
 * Make an authenticated request to the Kalshi API.
 * Automatically signs each request — no token expiry to manage.
 *
 * @param {string} path     — e.g. '/portfolio/balance'
 * @param {object} options  — fetch options (method, body, etc.)
 * @param {string} keyId    — Kalshi key UUID
 * @param {string} env      — 'demo' | 'live'
 */
async function kalshiRequest(path, options = {}, keyId, env = 'demo') {
  const base = env === 'live'
    ? 'https://trading-api.kalshi.com/trade-api/v2'
    : 'https://demo-api.kalshi.co/trade-api/v2';

  const authHeader = await buildKalshiAuthHeader(keyId);

  const headers = {
    'Authorization': authHeader,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  // Browser CORS: route through proxy for web builds
  // React Native: set KALSHI_DIRECT=true to skip proxy
  const url = (typeof KALSHI_DIRECT !== 'undefined' && KALSHI_DIRECT)
    ? base + path
    : CORS_PROXY + encodeURIComponent(base + path);

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    throw new KalshiAuthError('Signature rejected by Kalshi. Check your key ID and that the private key matches.');
  }
  if (res.status === 403) {
    throw new KalshiAuthError('Kalshi access forbidden. Verify your API key is active in kalshi.com → Settings → API.');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Kalshi API error ${res.status}: ${body.slice(0, 120)}`);
  }

  return res.json();
}

class KalshiAuthError extends Error {
  constructor(msg) { super(msg); this.name = 'KalshiAuthError'; }
}

// ─── KEY VALIDATION ───────────────────────────────────────

/**
 * Validate that a PEM string looks structurally correct before importing.
 * Catches the most common user errors early with clear messages.
 */
function validatePem(pem) {
  const trimmed = pem.trim();

  if (!trimmed) {
    return { ok: false, error: 'Key is empty.' };
  }
  if (!trimmed.includes('-----BEGIN')) {
    return { ok: false, error: 'Missing PEM header. Key should start with -----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY-----' };
  }
  if (!trimmed.includes('-----END')) {
    return { ok: false, error: 'PEM appears truncated — missing -----END----- footer. Paste the complete key.' };
  }
  if (trimmed.includes('PUBLIC KEY') && !trimmed.includes('PRIVATE')) {
    return { ok: false, error: 'This looks like a PUBLIC key. Kalshi auth requires your PRIVATE key.' };
  }
  if (trimmed.includes('CERTIFICATE')) {
    return { ok: false, error: 'This is a certificate, not a private key.' };
  }

  const body = trimmed
    .replace(/-----BEGIN[^-]+-----/, '')
    .replace(/-----END[^-]+-----/, '')
    .replace(/\s+/g, '');

  if (body.length < 100) {
    return { ok: false, error: 'Key body is too short. Make sure you copied the full key.' };
  }

  return { ok: true };
}

// ─── FILE READER HELPER ───────────────────────────────────

/**
 * Let user load their .pem file from disk instead of pasting.
 * Triggers a hidden file input and resolves with the file contents.
 */
function pickKeyFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pem,.key,.txt';
    input.onchange = e => {
      const file = e.target.files[0];
      if (!file) { reject(new Error('No file selected')); return; }
      const reader = new FileReader();
      reader.onload = ev => resolve(ev.target.result);
      reader.onerror = () => reject(new Error('File read failed'));
      reader.readAsText(file);
    };
    input.click();
  });
}

// ─── UTILITIES ────────────────────────────────────────────

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function arrayBufferToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
