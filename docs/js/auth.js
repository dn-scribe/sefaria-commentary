// Passphrase authentication + AES-GCM crypto helpers.
// The derived key never leaves memory; it lives only for the session.
window.SC = window.SC || {};

SC.Crypto = (function () {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function toB64(buf) {
    // Spreading the whole array into String.fromCharCode blows the call
    // stack once state gets large (e.g. an imported book's full text) -
    // build the binary string in chunks instead.
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }
  function fromB64(str) {
    return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  }

  async function deriveKey(passphrase, salt) {
    const baseKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptText(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      enc.encode(plaintext)
    );
    return { iv: toB64(iv), ct: toB64(ct) };
  }

  async function decryptText(key, payload) {
    const iv = fromB64(payload.iv);
    const ct = fromB64(payload.ct);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return dec.decode(pt);
  }

  return { toB64, fromB64, deriveKey, encryptText, decryptText };
})();

SC.Auth = (function () {
  const AUTH_KEY = "sc.auth";
  const MARKER = "SC-OK";
  let sessionKey = null;

  function hasAccount() {
    return !!localStorage.getItem(AUTH_KEY);
  }

  function isUnlocked() {
    return !!sessionKey;
  }

  function getKey() {
    return sessionKey;
  }

  async function createPassphrase(passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await SC.Crypto.deriveKey(passphrase, salt);
    const marker = await SC.Crypto.encryptText(key, MARKER);
    localStorage.setItem(
      AUTH_KEY,
      JSON.stringify({ salt: SC.Crypto.toB64(salt), marker })
    );
    sessionKey = key;
    return true;
  }

  async function login(passphrase) {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return false;
    const { salt, marker } = JSON.parse(raw);
    const key = await SC.Crypto.deriveKey(passphrase, SC.Crypto.fromB64(salt));
    try {
      const plaintext = await SC.Crypto.decryptText(key, marker);
      if (plaintext !== MARKER) return false;
      sessionKey = key;
      return true;
    } catch (e) {
      return false;
    }
  }

  function logout() {
    sessionKey = null;
  }

  // "Skip password" mode: instead of a passphrase-derived key, a random AES
  // key is kept in localStorage next to the data it encrypts. That only
  // obscures the data at rest - it is meant for a personal browser.
  const NOPWD_KEY = "sc.nopwd";

  function hasNoPassword() {
    return !!localStorage.getItem(NOPWD_KEY);
  }

  async function unlockNoPassword() {
    const raw = SC.Crypto.fromB64(localStorage.getItem(NOPWD_KEY));
    sessionKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
    return true;
  }

  async function generateNoPasswordKey() {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const b64 = SC.Crypto.toB64(await crypto.subtle.exportKey("raw", key));
    return { key, b64 };
  }

  // Call right after the data was re-encrypted with `key`.
  function commitNoPassword({ key, b64 }) {
    localStorage.setItem(NOPWD_KEY, b64);
    sessionKey = key;
  }

  // Call right after the data was re-encrypted with a passphrase key.
  function clearNoPassword() {
    localStorage.removeItem(NOPWD_KEY);
  }

  return {
    hasAccount,
    isUnlocked,
    getKey,
    createPassphrase,
    login,
    logout,
    hasNoPassword,
    unlockNoPassword,
    generateNoPasswordKey,
    commitNoPassword,
    clearNoPassword,
  };
})();
