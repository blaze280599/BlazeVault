// Encrypted storage for BlazeVault.
// The vault lives in chrome.storage.local as AES-GCM ciphertext. The key is derived
// from the password with PBKDF2 and, while unlocked, kept only in chrome.storage.session
// (in memory, never written to disk, wiped when Brave closes).

const ITERATIONS = 600000;
const VERSION = 1;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const DEFAULT_SETTINGS = { lockMinutes: 10, openPrivate: true, removeFromHistory: true };

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function deriveBits(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256);
  return new Uint8Array(bits);
}

function aesKey(raw) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(raw, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(raw), enc.encode(JSON.stringify(data)));
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

async function unseal(raw, vault) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(vault.iv) }, await aesKey(raw), fromB64(vault.ct));
  return JSON.parse(dec.decode(pt));
}

async function getVault() {
  return (await chrome.storage.local.get('vault')).vault ?? null;
}

async function newVault(password, data) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const raw = await deriveBits(password, salt, ITERATIONS);
  const vault = { v: VERSION, iter: ITERATIONS, salt: toB64(salt), ...(await seal(raw, data)) };
  await chrome.storage.local.set({ vault });
  await startSession(raw);
  return raw;
}

export async function hasVault() {
  return (await getVault()) !== null;
}

// ---- settings (not secret, stored in plain text) ----

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

// ---- session ----

async function startSession(raw) {
  await chrome.storage.session.set({ key: toB64(raw) });
  await touch();
}

// Pushes the auto-lock deadline back. Called on every vault action.
export async function touch() {
  const { lockMinutes } = await getSettings();
  const expires = lockMinutes > 0 ? Date.now() + lockMinutes * 60000 : 0;
  await chrome.storage.session.set({ expires });
  if (expires) await chrome.alarms.create('autolock', { when: expires });
  else await chrome.alarms.clear('autolock');
}

// Returns the key if the vault is unlocked, otherwise null.
export async function getSession() {
  const { key, expires } = await chrome.storage.session.get(['key', 'expires']);
  if (!key) return null;
  if (expires && Date.now() >= expires) {
    await lock();
    return null;
  }
  await touch();
  return fromB64(key);
}

export async function lock() {
  await chrome.storage.session.remove(['key', 'expires']);
  await chrome.alarms.clear('autolock');
}

// ---- vault lifecycle ----

export function createVault(password) {
  return newVault(password, { items: [] });
}

export async function unlock(password) {
  const vault = await getVault();
  const raw = await deriveBits(password, fromB64(vault.salt), vault.iter);
  try {
    await unseal(raw, vault);
  } catch {
    throw new Error('Wrong password');
  }
  await startSession(raw);
  return raw;
}

export async function readData(raw) {
  return unseal(raw, await getVault());
}

export async function writeData(raw, data) {
  const vault = await getVault();
  await chrome.storage.local.set({ vault: { ...vault, ...(await seal(raw, data)) } });
}

export async function changePassword(raw, newPassword) {
  return newVault(newPassword, await readData(raw));
}

export function exportVault() {
  return getVault();
}

export async function restoreVault(backup) {
  const { v, iter, salt, iv, ct } = backup ?? {};
  const valid = v === VERSION && Number.isInteger(iter) && iter >= 100000 && iter <= 10000000
    && [salt, iv, ct].every((s) => typeof s === 'string' && s.length > 0);
  if (!valid) throw new Error('This is not a BlazeVault backup file');
  await lock();
  await chrome.storage.local.set({ vault: { v, iter, salt, iv, ct } });
}

export async function deleteVault() {
  await lock();
  await chrome.storage.local.remove('vault');
  await chrome.storage.session.remove('pending');
}

// ---- items ----

// Adds a bookmark to decrypted vault data. Returns false if the URL is already saved.
export function addItem(data, { url, title, folder = '' }) {
  if (data.items.some((i) => i.url === url)) return false;
  data.items.unshift({ id: crypto.randomUUID(), url, title: title || url, folder, added: Date.now() });
  return true;
}

// Pages saved from the right-click menu while locked wait here (memory only)
// and are added to the vault on the next unlock.
export async function addPending(item) {
  const { pending = [] } = await chrome.storage.session.get('pending');
  pending.push(item);
  await chrome.storage.session.set({ pending });
  return pending.length;
}

export async function countPending() {
  const { pending = [] } = await chrome.storage.session.get('pending');
  return pending.length;
}

export async function takePending() {
  const { pending = [] } = await chrome.storage.session.get('pending');
  await chrome.storage.session.remove('pending');
  return pending;
}
