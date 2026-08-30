/**
 * StorageManager with AES-GCM Encrypted Storage for sensitive data.
 *
 * Architecture:
 * - Non-sensitive data (settings, theme, cache): plaintext localStorage (getLocal/setLocal)
 * - Sensitive data (accounts, keys): AES-GCM encrypted localStorage (encryptAndStore/decryptAndRetrieve)
 * - Password verification: PBKDF2 hash stored, plaintext NEVER stored
 * - Decrypted keys exist ONLY in memory during active session
 *
 * Crypto flow:
 *   password → PBKDF2 (100,000 iterations, SHA-256) → AES-GCM key
 *   AES-GCM key + random IV → encrypt(JSON) → base64 ciphertext stored in localStorage
 */

// --- Crypto Helpers (Web Crypto API) ---
declare var chrome: any;


const PBKDF2_ITERATIONS = 100_000;
const LAST_ACTIVE_KEY = "arfhe_last_active";

/**
 * When the user was last active, captured the instant this module loads.
 *
 * This is the value the reopen check must use, and it has to be frozen before anything
 * else runs. The timestamp is refreshed by user activity — mouse, keys, the tab becoming
 * visible — and the extension popup produces some of those the moment it opens. Reading
 * it later meant reading a stamp that the current page had already written: the staleness
 * test compared "now" against "now", always passed, and a wallet closed for hours
 * reopened unlocked.
 *
 * Module scope is deliberate. It is evaluated at import time, before React renders and
 * long before any listener is attached, so nothing can have touched it yet.
 */
const LAST_ACTIVE_AT_LOAD: number | null = (() => {
  try {
    const raw = localStorage.getItem(LAST_ACTIVE_KEY);
    if (!raw) return null;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
})();

const SALT_KEY = "arfhe_salt";
const PASS_HASH_KEY = "arfhe_pass_hash";

/** Generate a random salt (16 bytes) */
function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/** Generate a random IV for AES-GCM (12 bytes) */
function generateIV(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(12));
}

/**
 * The salt is handed to WebCrypto as the Uint8Array VIEW, never as `salt.buffer`.
 *
 * `.buffer` throws away byteOffset and byteLength, so a view over part of a larger buffer
 * would derive from the wrong bytes — silently, and with a key that still looks valid until
 * a decrypt somewhere else fails. Today's salts are always whole freshly-allocated arrays,
 * which is why nothing has broken; that is a property of the callers, not a guarantee.
 *
 * It also crossed a realm boundary under the test environment: jsdom's ArrayBuffer is not
 * Node's, so `salt.buffer` failed the WebCrypto BufferSource check with "not instance of
 * ArrayBuffer, Buffer, TypedArray, or DataView" and took every encryption test down with it.
 * A TypedArray view passes that check in both realms.
 */
/** Derive an AES-GCM CryptoKey from a password + salt using PBKDF2 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

/** Hash a password for verification (NOT for encryption — separate purpose) */
async function hashPassword(password: string, salt: Uint8Array): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );

  return arrayBufferToBase64(bits as ArrayBuffer);
}

/** AES-GCM encrypt */
async function aesEncrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const encoder = new TextEncoder();
  const iv = generateIV();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    encoder.encode(plaintext)
  );

  // Prepend IV (12 bytes) to ciphertext for storage
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return arrayBufferToBase64(combined.buffer as ArrayBuffer);
}

/** AES-GCM decrypt */
async function aesDecrypt(key: CryptoKey, encryptedBase64: string): Promise<string> {
  const combined = base64ToUint8Array(encryptedBase64);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plainBuffer);
}

/** Uint8Array / ArrayBuffer → base64 */
function arrayBufferToBase64(buffer: ArrayBuffer | ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer as ArrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** base64 → Uint8Array */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}


// --- StorageManager ---

class StorageManager {
  /** In-memory AES key — only exists while wallet is unlocked */
  private _cryptoKey: CryptoKey | null = null;

  /** Registered cleanup callbacks — called on lock() to wipe sensitive data from other services */
  private _lockCallbacks: (() => void)[] = [];

  /**
   * Export the current _cryptoKey and store it in session storage to survive extension popup closes.
   */
  async exportSession(): Promise<void> {
    if (!this._cryptoKey) return;
    try {
      const rawKey = await crypto.subtle.exportKey("raw", this._cryptoKey);
      const base64Key = arrayBufferToBase64(rawKey);

      // Try chrome.storage.session first (Extension MV3)
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
        await chrome.storage.session.set({ arfhe_session_key: base64Key });
      } else {
        // Fallback to web sessionStorage
        sessionStorage.setItem('arfhe_session_key', base64Key);
      }
      localStorage.setItem(LAST_ACTIVE_KEY, Date.now().toString());
    } catch (e) {
      console.warn("Could not export session key", e);
    }
  }

  /**
   * Attempt to restore the _cryptoKey from session storage if within the autoLockTimeout.
   */
  async restoreSession(timeoutMs: number): Promise<boolean> {
    if (this._cryptoKey) return true; // Already unlocked

    try {
      // Frozen at import time. Re-reading here would pick up a stamp this very page
      // just wrote, which is what defeated this check before.
      const lastActive = LAST_ACTIVE_AT_LOAD;
      if (lastActive === null) return false;

      if (timeoutMs > 0 && Date.now() - lastActive > timeoutMs) {
        // Session expired
        await this.clearSession();
        return false;
      }

      let base64Key: string | null = null;
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
        const result = await chrome.storage.session.get('arfhe_session_key');
        base64Key = result.arfhe_session_key;
      } else {
        base64Key = sessionStorage.getItem('arfhe_session_key');
      }

      if (!base64Key) return false;

      // Import the key back
      const rawKey = base64ToUint8Array(base64Key);
      this._cryptoKey = await crypto.subtle.importKey(
        "raw",
        rawKey as BufferSource,
        { name: "AES-GCM", length: 256 },
        true, // Keep extractable so we can re-export if needed
        ["encrypt", "decrypt"]
      );

      // Update last active
      localStorage.setItem(LAST_ACTIVE_KEY, Date.now().toString());
      return true;
    } catch (e) {
      console.warn("Could not restore session key", e);
      return false;
    }
  }

  /**
   * Clears the exported session key
   */
  async clearSession(): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
      await chrome.storage.session.remove('arfhe_session_key');
    }
    sessionStorage.removeItem('arfhe_session_key');
    localStorage.removeItem(LAST_ACTIVE_KEY);
  }

  /**
   * Retrieves a value from local storage by key (plaintext — non-sensitive)
   */
  getLocal<T>(key: string): T | null {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Retrieves a value from session storage by key
   */
  getSession<T>(key: string): T | null {
    try {
      const value = sessionStorage.getItem(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Sets a value in local storage (plaintext — non-sensitive)
   */
  setLocal<T>(key: string, value: T): boolean {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Sets a value in session storage
   */
  setSession<T>(key: string, value: T): boolean {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Removes a value from local storage
   */
  removeLocal(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch (error) {
    }
  }

  /**
   * Removes a value from session storage
   */
  removeSession(key: string): void {
    try {
      sessionStorage.removeItem(key);
    } catch (error) {
    }
  }

  // ============================
  // Encrypted Storage Methods
  // ============================

  /**
   * Initialize encryption with a password.
   * - First time: generates salt, stores password hash, derives AES key
   * - Subsequent: loads salt, verifies password, derives AES key
   * @returns true if password is correct (or newly set), false if wrong password
   */
  async initEncryption(password: string): Promise<boolean> {
    try {
      const existingSaltB64 = localStorage.getItem(SALT_KEY);

      if (existingSaltB64) {
        // Existing wallet — verify password
        const salt = base64ToUint8Array(existingSaltB64);
        const expectedHash = localStorage.getItem(PASS_HASH_KEY);
        const actualHash = await hashPassword(password, salt);

        if (actualHash !== expectedHash) {
          return false;
        }

        // Password correct — derive key
        this._cryptoKey = await deriveKey(password, salt);
        await this.exportSession();
        return true;
      } else {
        // New wallet — create salt and store hash
        const salt = generateSalt();
        const saltB64 = arrayBufferToBase64(salt.buffer as ArrayBuffer);
        localStorage.setItem(SALT_KEY, saltB64);

        const passHash = await hashPassword(password, salt);
        localStorage.setItem(PASS_HASH_KEY, passHash);

        this._cryptoKey = await deriveKey(password, salt);
        await this.exportSession();
        return true;
      }
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if a password has been set (salt exists in storage)
   */
  hasPassword(): boolean {
    return localStorage.getItem(SALT_KEY) !== null && localStorage.getItem(PASS_HASH_KEY) !== null;
  }

  /**
   * Check if encryption is currently unlocked (key in memory)
   */
  isUnlocked(): boolean {
    return this._cryptoKey !== null;
  }

  /**
   * Lock the wallet: clear AES key AND all registered sensitive data from memory.
   * This ensures private keys, mnemonics, FHE signers, and permits are all wiped.
   */
  lock(): void {
    this._cryptoKey = null;
    this.clearSession().catch(() => { });

    // Execute all registered cleanup callbacks
    for (const callback of this._lockCallbacks) {
      try {
        callback();
      } catch (e) {
      }
    }

  }

  /**
   * Register a callback to be called when the wallet is locked.
   * Used by AccountManager, FheCofheService, etc. to wipe their sensitive data.
   */
  onLock(callback: () => void): void {
    this._lockCallbacks.push(callback);
  }

  /**
   * Change password: re-encrypt all sensitive data with new password
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
    // Verify old password first
    const existingSaltB64 = localStorage.getItem(SALT_KEY);
    if (!existingSaltB64) return false;

    const oldSalt = base64ToUint8Array(existingSaltB64);
    const expectedHash = localStorage.getItem(PASS_HASH_KEY);
    const actualHash = await hashPassword(oldPassword, oldSalt);
    if (actualHash !== expectedHash) return false;

    // Decrypt with old key
    const oldKey = await deriveKey(oldPassword, oldSalt);
    const sensitiveKeys = this.getSensitiveKeys();
    const decryptedData: Record<string, unknown> = {};

    for (const key of sensitiveKeys) {
      const encrypted = localStorage.getItem(`enc_${key}`);
      if (encrypted) {
        try {
          const plaintext = await aesDecrypt(oldKey, encrypted);
          decryptedData[key] = JSON.parse(plaintext);
        } catch (e) {
        }
      }
    }

    // Generate new salt and re-encrypt
    const newSalt = generateSalt();
    const newSaltB64 = arrayBufferToBase64(newSalt.buffer as ArrayBuffer);
    localStorage.setItem(SALT_KEY, newSaltB64);

    const newPassHash = await hashPassword(newPassword, newSalt);
    localStorage.setItem(PASS_HASH_KEY, newPassHash);

    const newKey = await deriveKey(newPassword, newSalt);
    this._cryptoKey = newKey;
    await this.exportSession();

    for (const [key, value] of Object.entries(decryptedData)) {
      const encrypted = await aesEncrypt(newKey, JSON.stringify(value));
      localStorage.setItem(`enc_${key}`, encrypted);
    }

    return true;
  }

  /**
   * Encrypt and store sensitive data.
   * Requires initEncryption() to have been called first.
   */
  async encryptAndStore<T>(key: string, value: T): Promise<boolean> {
    if (!this._cryptoKey) {
      return false;
    }

    try {
      const plaintext = JSON.stringify(value);
      const encrypted = await aesEncrypt(this._cryptoKey, plaintext);
      localStorage.setItem(`enc_${key}`, encrypted);

      // Track which keys are encrypted
      const tracked = this.getSensitiveKeys();
      if (!tracked.includes(key)) {
        tracked.push(key);
        localStorage.setItem("arfhe_enc_keys", JSON.stringify(tracked));
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Decrypt and retrieve sensitive data.
   * Requires initEncryption() to have been called first.
   */
  async decryptAndRetrieve<T>(key: string): Promise<T | null> {
    if (!this._cryptoKey) {
      return null;
    }

    try {
      const encrypted = localStorage.getItem(`enc_${key}`);
      if (!encrypted) return null;

      const plaintext = await aesDecrypt(this._cryptoKey, encrypted);
      return JSON.parse(plaintext) as T;
    } catch (error) {
      return null;
    }
  }

  /**
   * Remove encrypted data
   */
  removeEncrypted(key: string): void {
    localStorage.removeItem(`enc_${key}`);
    const tracked = this.getSensitiveKeys();
    const updated = tracked.filter(k => k !== key);
    localStorage.setItem("arfhe_enc_keys", JSON.stringify(updated));
  }

  /**
   * Get list of keys that are stored encrypted
   */
  private getSensitiveKeys(): string[] {
    try {
      const raw = localStorage.getItem("arfhe_enc_keys");
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  /**
   * Erase this wallet from the device.
   *
   * The only answer to a forgotten password. Nothing here can recover it: the password is
   * never stored, only a PBKDF2 hash of it, and the accounts are encrypted with a key
   * derived from it. Wiping and restoring from the recovery phrase is the sole path back —
   * which is exactly why the phrase is verified during onboarding.
   *
   * Removes everything: encrypted accounts, the salt and password hash, the session key,
   * site permissions, pending claims and cached data. A partial wipe would be worse than
   * none — a leftover salt or permission record belongs to a wallet that no longer exists.
   *
   * Irreversible, and callers must confirm with the user before calling it.
   */
  async resetWallet(): Promise<void> {
    // Drop the in-memory key first, so nothing can be written back mid-wipe.
    this.lock();

    try {
      localStorage.clear();
    } catch {
      // Fall through to the targeted removals below.
    }

    try {
      sessionStorage.clear();
    } catch { /* not available */ }

    // localStorage.clear() does not touch extension storage, where site permissions,
    // background state and the session key live.
    try {
      if (typeof chrome !== "undefined" && chrome.storage) {
        await chrome.storage.local.clear();
        await chrome.storage.session?.clear();
      }
    } catch { /* not in an extension context */ }
  }

  /**
   * Migration helper: Check if unencrypted accounts exist and need migration.
   * Called once during the first login after the encryption update.
   */
  hasUnencryptedAccounts(): boolean {
    try {
      const raw = localStorage.getItem("accounts");
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Migrate plaintext accounts to encrypted storage.
   * Requires initEncryption() to have been called first.
   */
  async migrateToEncrypted(): Promise<boolean> {
    if (!this._cryptoKey) return false;

    try {
      // Read plaintext accounts
      const raw = localStorage.getItem("accounts");
      if (!raw) return false;
      const accounts = JSON.parse(raw);

      // Read plaintext active index
      const activeRaw = localStorage.getItem("active");
      const active = activeRaw ? JSON.parse(activeRaw) : -1;

      // Store encrypted
      await this.encryptAndStore("accounts", accounts);
      await this.encryptAndStore("active", active);

      // Remove plaintext originals
      localStorage.removeItem("accounts");
      localStorage.removeItem("active");

      // Remove plaintext password (replaced by PBKDF2 hash)
      localStorage.removeItem("passwd");

      return true;
    } catch (error) {
      return false;
    }
  }
}

export default StorageManager;