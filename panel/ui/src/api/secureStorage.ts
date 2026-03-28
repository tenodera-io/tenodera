/**
 * Secure superuser password persistence using Web Crypto API.
 *
 * On HTTPS (or localhost): password is encrypted with a non-extractable
 * AES-GCM key stored in IndexedDB. Only ciphertext lives in sessionStorage.
 *
 * On plain HTTP (non-localhost): crypto.subtle is unavailable so the password
 * is NOT persisted — after refresh the user must re-authenticate.
 */

const DB_NAME = 'tenodera_su';
const DB_VERSION = 1;
const STORE_NAME = 'keys';
const KEY_ID = 'su_key';
const SESSION_KEY = 'su_cipher';

/* ── helpers ─────────────────────────────────────────────── */

function isSecureContext(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<CryptoKey | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as CryptoKey | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: CryptoKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getOrCreateKey(): Promise<CryptoKey> {
  const db = await openDB();
  const existing = await idbGet(db, KEY_ID);
  if (existing) {
    db.close();
    return existing;
  }
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, /* extractable = false — cannot be exported from JS */
    ['encrypt', 'decrypt'],
  );
  await idbPut(db, KEY_ID, key);
  db.close();
  return key;
}

/* ── public API ──────────────────────────────────────────── */

/**
 * Encrypt and store the superuser password in sessionStorage.
 * Returns true on success, false if crypto is unavailable.
 */
export async function saveSuperuserPassword(password: string): Promise<boolean> {
  if (!isSecureContext()) return false;
  try {
    const key = await getOrCreateKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(password);
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoded,
    );
    /* store iv + ciphertext as base64 in sessionStorage */
    const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(cipherBuf), iv.length);
    const b64 = btoa(String.fromCharCode(...combined));
    sessionStorage.setItem(SESSION_KEY, b64);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decrypt the superuser password from sessionStorage.
 * Returns the password string or null if unavailable/failed.
 */
export async function loadSuperuserPassword(): Promise<string | null> {
  if (!isSecureContext()) return null;
  try {
    const b64 = sessionStorage.getItem(SESSION_KEY);
    if (!b64) return null;
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (raw.length < 13) return null; /* iv(12) + at least 1 byte */
    const iv = raw.slice(0, 12);
    const cipherBuf = raw.slice(12);
    const key = await getOrCreateKey();
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      cipherBuf,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    /* key mismatch, corrupt data, etc. — treat as absent */
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

/**
 * Remove stored password and encryption key.
 */
export async function clearSuperuserPassword(): Promise<void> {
  sessionStorage.removeItem(SESSION_KEY);
  try {
    const db = await openDB();
    await idbDelete(db, KEY_ID);
    db.close();
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * Returns true when the secure context is available (HTTPS or localhost).
 * When false, passwords cannot be persisted across refresh.
 */
export function canPersistPassword(): boolean {
  return isSecureContext();
}
