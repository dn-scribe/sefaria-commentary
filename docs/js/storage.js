// Encrypted local-storage persistence for app state (books + commentary + settings).
window.SC = window.SC || {};

SC.Storage = (function () {
  const DATA_KEY = "sc.data";

  function defaultState() {
    return {
      settings: { gasUrl: null },
      books: [],
      // commentary[bookId][ref] = { title, text, updatedAt }
      commentary: {},
      // Tombstones for cross-device book-list sync: { bookId: deletedAtMs }
      deletedBookIds: {},
    };
  }

  async function load() {
    const raw = localStorage.getItem(DATA_KEY);
    if (!raw) return defaultState();
    const key = SC.Auth.getKey();
    if (!key) throw new Error("locked");
    try {
      const json = await SC.Crypto.decryptText(key, JSON.parse(raw));
      const state = JSON.parse(json);
      return Object.assign(defaultState(), state);
    } catch (e) {
      console.error("Failed to decrypt local data", e);
      return defaultState();
    }
  }

  async function save(state) {
    const key = SC.Auth.getKey();
    if (!key) throw new Error("locked");
    const payload = await SC.Crypto.encryptText(key, JSON.stringify(state));
    localStorage.setItem(DATA_KEY, JSON.stringify(payload));
  }

  function wipe() {
    localStorage.removeItem(DATA_KEY);
    localStorage.removeItem("sc.auth");
  }

  return { defaultState, load, save, wipe };
})();
