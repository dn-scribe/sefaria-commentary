// Passphrase authentication + AES-GCM crypto helpers.
// The derived key never leaves memory; it lives only for the session.
window.SC = window.SC || {};

SC.Crypto = (function () {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function toB64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
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

  return { hasAccount, isUnlocked, getKey, createPassphrase, login, logout };
})();
