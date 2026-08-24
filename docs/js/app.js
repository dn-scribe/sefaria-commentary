// Main controller: wires DOM events to Storage/Auth/Api/UI.
window.SC = window.SC || {};

SC.App = (function () {
  const $ = (id) => document.getElementById(id);

  let state = null;
  let currentBook = null;
  let currentSection = null;

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
  }

  function refSortKey(ref) {
    const m = ref.match(/(\d+)(?:[:.](\d+))?\s*$/);
    if (!m) return [0, 0, ref];
    return [parseInt(m[1], 10), parseInt(m[2] || "0", 10), ref];
  }

  function sortedEntries(bookId) {
    const map = state.commentary[bookId] || {};
    return Object.entries(map)
      .map(([ref, c]) => ({ ref, ...c }))
      .sort((a, b) => {
        const ka = refSortKey(a.ref);
        const kb = refSortKey(b.ref);
        return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
      });
  }

  async function persist() {
    await SC.Storage.save(state);
  }

  // ---------- Auth ----------
  function initAuth() {
    const mode = SC.Auth.hasAccount() ? "login" : "create";
    SC.UI.renderAuthMode(mode);
    SC.UI.showScreen("auth");

    $("form-auth").onsubmit = async (e) => {
      e.preventDefault();
      const pass = $("input-passphrase").value;
      const confirm = $("input-passphrase-confirm").value;
      if (mode === "create") {
        if (pass !== confirm) {
          SC.UI.authError("הסיסמאות אינן תואמות");
          return;
        }
        await SC.Auth.createPassphrase(pass);
      } else {
        const ok = await SC.Auth.login(pass);
        if (!ok) {
          SC.UI.authError("סיסמה שגויה");
          return;
        }
      }
      state = await SC.Storage.load();
      await goToBooks();
    };
  }

  function logout() {
    SC.Auth.logout();
    state = null;
    currentBook = null;
    initAuth();
  }

  // ---------- Books ----------
  async function goToBooks() {
    SC.UI.renderBooks(state.books, { onOpen: openBook, onDelete: deleteBook });
    SC.UI.showScreen("books");
  }

  let searchDebounce = null;
  function initBookSearch() {
    $("form-add-book").onsubmit = (e) => e.preventDefault();
    $("input-book-search").addEventListener("input", (e) => {
      clearTimeout(searchDebounce);
      const q = e.target.value;
      searchDebounce = setTimeout(async () => {
        if (q.trim().length < 2) {
          SC.UI.renderSearchResults([], () => {});
          return;
        }
        try {
          const results = await SC.Api.searchTitles(q);
          SC.UI.renderSearchResults(results, addBook);
        } catch (err) {
          console.error(err);
        }
      }, 300);
    });
  }

  async function addBook(title) {
    if (state.books.some((b) => b.title === title)) {
      SC.UI.toast("הספר כבר ברשימה");
      return;
    }
    try {
      const idx = await SC.Api.getIndex(title);
      const book = {
        id: uid(),
        title: idx.title,
        heTitle: idx.heTitle,
        currentRef: idx.firstRef,
        lastRef: null,
        sheetId: null,
        sheetUrl: null,
        docId: null,
        docUrl: null,
        exportedRefs: [],
        lastExportedAt: null,
        createdAt: Date.now(),
      };
      state.books.push(book);
      state.commentary[book.id] = {};
      await persist();
      $("input-book-search").value = "";
      SC.UI.renderSearchResults([], () => {});
      await goToBooks();
      SC.UI.toast(`נוסף: ${book.heTitle}`);
    } catch (err) {
      SC.UI.toast(err.message || "שגיאה בהוספת הספר", true);
    }
  }

  async function deleteBook(book) {
    if (!confirm(`למחוק את "${book.heTitle}"? הפעולה תמחק גם את הפרשנות שנשמרה מקומית.`)) return;
    if (state.settings.gasUrl && (book.sheetId || book.docId)) {
      try {
        await SC.Api.callGas(state.settings.gasUrl, {
          action: "deleteBook",
          book: { sheetId: book.sheetId, docId: book.docId },
        });
      } catch (err) {
        console.warn("Remote delete failed", err);
        SC.UI.toast("מחיקה מ-Google נכשלה, ממשיך במחיקה מקומית", true);
      }
    }
    state.books = state.books.filter((b) => b.id !== book.id);
    delete state.commentary[book.id];
    await persist();
    await goToBooks();
  }

  // ---------- Reader ----------
  async function openBook(book) {
    currentBook = book;
    try {
      const section = await SC.Api.getSection(book.currentRef || book.title);
      currentSection = section;
      renderCurrentSection();
      SC.UI.showScreen("reader");
    } catch (err) {
      SC.UI.toast(err.message || "שגיאה בטעינת הטקסט", true);
    }
  }

  function renderCurrentSection() {
    SC.UI.renderReader(currentBook, currentSection, state.commentary[currentBook.id] || {});
    $("btn-open-sefaria").onclick = () => window.open(SC.Api.sefariaUrl(currentSection.ref), "_blank");
    updateExportLink();
  }

  async function goSection(direction) {
    const ref = direction === "next" ? currentSection.next : currentSection.prev;
    if (!ref) return;
    try {
      const section = await SC.Api.getSection(ref);
      if (direction === "next") {
        currentBook.lastRef = currentSection.sectionRef;
      }
      currentBook.currentRef = section.sectionRef;
      currentSection = section;
      await persist();
      renderCurrentSection();
    } catch (err) {
      SC.UI.toast(err.message || "שגיאה בטעינת הטקסט", true);
    }
  }

  function initReaderEvents() {
    $("btn-back-to-books").onclick = goToBooks;
    $("btn-prev-section").onclick = () => goSection("prev");
    $("btn-next-section").onclick = () => goSection("next");

    $("reader-content").addEventListener("click", (e) => {
      const row = e.target.closest(".verse-row");
      if (!row) return;
      const form = row.querySelector(".commentary-form");

      if (e.target.classList.contains("btn-add-comment") || e.target.classList.contains("btn-edit-comment")) {
        form.hidden = false;
        form.querySelector(".commentary-text-input").focus();
      } else if (e.target.classList.contains("btn-cancel-comment")) {
        form.hidden = true;
      } else if (e.target.classList.contains("btn-delete-comment")) {
        deleteComment(row.dataset.ref);
      }
    });

    $("reader-content").addEventListener("submit", (e) => {
      const row = e.target.closest(".verse-row");
      if (!row || !e.target.classList.contains("commentary-form")) return;
      e.preventDefault();
      const title = row.querySelector(".commentary-title-input").value.trim();
      const text = row.querySelector(".commentary-text-input").value.trim();
      const heText = row.querySelector(".verse-he").textContent;
      const enEl = row.querySelector(".verse-en");
      saveComment(row.dataset.ref, { title, text, heText, enText: enEl ? enEl.textContent : "" });
    });
  }

  async function saveComment(ref, data) {
    if (!data.text) {
      SC.UI.toast("נא להזין טקסט לפרשנות", true);
      return;
    }
    const bookId = currentBook.id;
    state.commentary[bookId] = state.commentary[bookId] || {};
    state.commentary[bookId][ref] = { ...data, updatedAt: Date.now() };
    await persist();
    renderCurrentSection();
    SC.UI.toast("נשמר");
    syncToSheet();
  }

  async function deleteComment(ref) {
    const bookId = currentBook.id;
    if (state.commentary[bookId]) delete state.commentary[bookId][ref];
    await persist();
    renderCurrentSection();
    syncToSheet();
  }

  // ---------- Google sync / export ----------
  function syncToSheet() {
    if (!state.settings.gasUrl) return;
    const entries = sortedEntries(currentBook.id);
    SC.Api
      .callGas(state.settings.gasUrl, {
        action: "sync",
        book: bookRef(currentBook),
        entries,
      })
      .then((res) => {
        if (res.sheetId && !currentBook.sheetId) {
          currentBook.sheetId = res.sheetId;
          currentBook.sheetUrl = res.sheetUrl;
          persist();
        }
      })
      .catch((err) => console.warn("Sheet sync failed", err));
  }

  function bookRef(book) {
    return {
      id: book.id,
      title: book.title,
      heTitle: book.heTitle,
      sheetId: book.sheetId,
      docId: book.docId,
    };
  }

  function updateExportLink() {
    const link = $("link-open-doc");
    if (currentBook.docUrl) {
      link.href = currentBook.docUrl;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
    $("export-status").textContent = currentBook.lastExportedAt
      ? "יוצא לאחרונה: " + new Date(currentBook.lastExportedAt).toLocaleString("he-IL")
      : "";
  }

  async function exportBook(mode) {
    if (!state.settings.gasUrl) {
      SC.UI.toast("יש להגדיר כתובת Google Apps Script בהגדרות תחילה", true);
      return;
    }
    const all = sortedEntries(currentBook.id);
    const entries =
      mode === "replace"
        ? all
        : all.filter(
            (e) => !currentBook.exportedRefs.includes(e.ref) || e.updatedAt > (currentBook.lastExportedAt || 0)
          );

    if (!entries.length) {
      SC.UI.toast("אין פרשנות חדשה לייצוא");
      return;
    }

    $("export-status").textContent = "מייצא...";
    try {
      const res = await SC.Api.callGas(state.settings.gasUrl, {
        action: "export",
        mode,
        book: bookRef(currentBook),
        entries,
      });
      currentBook.sheetId = res.sheetId || currentBook.sheetId;
      currentBook.sheetUrl = res.sheetUrl || currentBook.sheetUrl;
      currentBook.docId = res.docId || currentBook.docId;
      currentBook.docUrl = res.docUrl || currentBook.docUrl;
      currentBook.exportedRefs =
        mode === "replace" ? entries.map((e) => e.ref) : Array.from(new Set([...currentBook.exportedRefs, ...entries.map((e) => e.ref)]));
      currentBook.lastExportedAt = Date.now();
      await persist();
      updateExportLink();
      SC.UI.toast("הייצוא הושלם");
    } catch (err) {
      $("export-status").textContent = "";
      SC.UI.toast(err.message || "הייצוא נכשל", true);
    }
  }

  // ---------- Settings ----------
  function initSettings() {
    $("btn-nav-settings").onclick = () => {
      $("input-gas-url").value = state.settings.gasUrl || "";
      $("settings-status").textContent = "";
      SC.UI.showScreen("settings");
    };
    $("btn-back-from-settings").onclick = goToBooks;
    $("link-to-settings").onclick = (e) => {
      e.preventDefault();
      $("btn-nav-settings").click();
    };

    $("form-settings").onsubmit = async (e) => {
      e.preventDefault();
      state.settings.gasUrl = $("input-gas-url").value.trim() || null;
      await persist();
      $("settings-status").textContent = "נשמר.";
    };

    $("btn-test-gas").onclick = async () => {
      const url = $("input-gas-url").value.trim();
      if (!url) {
        $("settings-status").textContent = "נא להזין כתובת URL תחילה";
        return;
      }
      $("settings-status").textContent = "בודק חיבור...";
      try {
        await SC.Api.callGas(url, { action: "ping" });
        $("settings-status").textContent = "✅ החיבור תקין";
      } catch (err) {
        $("settings-status").textContent = "❌ " + (err.message || "החיבור נכשל");
      }
    };

    $("btn-wipe").onclick = async () => {
      if (!confirm("פעולה זו תמחק את כל הנתונים המקומיים לצמיתות. להמשיך?")) return;
      SC.Storage.wipe();
      logout();
    };
  }

  function initHeader() {
    $("btn-nav-books").onclick = goToBooks;
    $("btn-logout").onclick = logout;
    $("btn-export-update").onclick = () => exportBook("update");
    $("btn-export-replace").onclick = () => exportBook("replace");
  }

  function init() {
    initAuth();
    initBookSearch();
    initReaderEvents();
    initSettings();
    initHeader();
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", SC.App.init);
