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

    $("form-add-scope").onsubmit = (e) => {
      e.preventDefault();
      addScopedBook($("input-scope-search").value);
    };

    initScopeChapterPicker();
  }

  let scopeSearchDebounce = null;
  let scopePickedBook = null;
  function initScopeChapterPicker() {
    $("form-scope-book-search").onsubmit = (e) => e.preventDefault();
    $("input-scope-book-search").addEventListener("input", (e) => {
      clearTimeout(scopeSearchDebounce);
      const q = e.target.value;
      $("scope-chapter-picker").hidden = true;
      scopeSearchDebounce = setTimeout(async () => {
        if (q.trim().length < 2) {
          SC.UI.renderSearchResults([], () => {}, "scope-book-results");
          return;
        }
        try {
          const results = await SC.Api.searchTitles(q);
          SC.UI.renderSearchResults(results, pickScopeBook, "scope-book-results");
        } catch (err) {
          console.error(err);
        }
      }, 300);
    });

    $("btn-add-scope-chapter").onclick = () => {
      if (!scopePickedBook) return;
      const chapter = $("input-scope-chapter").value;
      addScopedBook(`${scopePickedBook.title} ${chapter}`);
    };
  }

  async function pickScopeBook(title) {
    try {
      const idx = await SC.Api.getIndex(title);
      const shape = await SC.Api.getShape(idx.title);
      scopePickedBook = idx;
      $("scope-picked-book-name").textContent = idx.heTitle;
      const select = $("input-scope-chapter");
      select.innerHTML = "";
      for (let i = 1; i <= shape.length; i++) {
        const opt = document.createElement("option");
        opt.value = i;
        opt.textContent = i;
        select.appendChild(opt);
      }
      $("scope-chapter-picker").hidden = false;
      $("input-scope-book-search").value = "";
      SC.UI.renderSearchResults([], () => {}, "scope-book-results");
    } catch (err) {
      SC.UI.toast(err.message || "שגיאה בטעינת מבנה הספר", true);
    }
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
        scopeRef: null,
        scopeHeRef: null,
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

  // A scoped book pins navigation and export to one sub-part of a book
  // (e.g. a single chapter or Part), instead of the whole thing.
  async function addScopedBook(query) {
    query = query.trim();
    if (!query) return;
    try {
      const section = await SC.Api.getSection(query);
      if (state.books.some((b) => b.scopeRef === section.ref)) {
        SC.UI.toast("הטווח הזה כבר ברשימה");
        return;
      }
      const idx = await SC.Api.getIndex(section.book);
      const book = {
        id: uid(),
        title: idx.title,
        heTitle: idx.heTitle,
        scopeRef: section.ref,
        scopeHeRef: section.heRef,
        currentRef: section.firstAvailableSectionRef,
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
      $("input-scope-search").value = "";
      await goToBooks();
      SC.UI.toast(`נוסף: ${book.heTitle} — ${book.scopeHeRef}`);
    } catch (err) {
      SC.UI.toast(err.message || "לא ניתן לפענח את ההפניה הזו בספריא", true);
    }
  }

  // Prefix match on a canonical ref, requiring a word boundary (":" or " ")
  // so "Likutei Moharan 5" never matches "Likutei Moharan 56".
  function isWithinScope(ref, scopeRef) {
    if (!scopeRef) return true;
    return ref === scopeRef || ref.startsWith(scopeRef + ":") || ref.startsWith(scopeRef + " ");
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
    if (currentBook.scopeRef) {
      if (currentSection.next && !isWithinScope(currentSection.next, currentBook.scopeRef)) {
        $("btn-next-section").disabled = true;
      }
      if (currentSection.prev && !isWithinScope(currentSection.prev, currentBook.scopeRef)) {
        $("btn-prev-section").disabled = true;
      }
    }
    $("btn-open-sefaria").onclick = () => window.open(SC.Api.sefariaUrl(currentSection.ref), "_blank");
    updateExportLink();
  }

  async function goSection(direction) {
    const ref = direction === "next" ? currentSection.next : currentSection.prev;
    if (!ref || !isWithinScope(ref, currentBook.scopeRef)) return;
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

      if (
        e.target.classList.contains("btn-add-title") ||
        e.target.classList.contains("btn-edit-title") ||
        e.target.classList.contains("btn-add-comment") ||
        e.target.classList.contains("btn-edit-comment")
      ) {
        enterEditMode(row, e.target.classList.contains("btn-add-title") || e.target.classList.contains("btn-edit-title"));
      } else if (e.target.classList.contains("btn-cancel-comment")) {
        renderCurrentSection();
      } else if (e.target.classList.contains("btn-delete-comment")) {
        deleteComment(row.dataset.ref);
      }
    });

    $("reader-content").addEventListener("submit", (e) => {
      const row = e.target.closest(".verse-row");
      if (!row) return;
      e.preventDefault();
      const title = row.querySelector(".commentary-title-input").value.trim();
      const text = row.querySelector(".commentary-text-input").value.trim();
      const heText = row.querySelector(".verse-he").textContent;
      const enEl = row.querySelector(".verse-en");
      saveComment(row.dataset.ref, { title, text, heText, enText: enEl ? enEl.textContent : "" });
    });
  }

  function enterEditMode(row, focusTitle) {
    row.querySelector(".title-view").hidden = true;
    row.querySelector(".btn-add-title").hidden = true;
    row.querySelector(".commentary-title-input").hidden = false;

    row.querySelector(".commentary-view").hidden = true;
    row.querySelector(".btn-add-comment").hidden = true;
    row.querySelector(".commentary-text-input").hidden = false;
    row.querySelector(".commentary-save-actions").hidden = false;

    const target = focusTitle
      ? row.querySelector(".commentary-title-input")
      : row.querySelector(".commentary-text-input");
    target.focus();
  }

  async function saveComment(ref, data) {
    if (!data.text && !data.title) {
      SC.UI.toast("נא להזין כותרת או טקסט פרשנות", true);
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
    const book = currentBook;
    const entries = sortedEntries(book.id);
    SC.Api
      .callGas(state.settings.gasUrl, {
        action: "sync",
        book: bookRef(book),
        entries,
      })
      .then((res) => {
        if (res.sheetId && !book.sheetId) {
          book.sheetId = res.sheetId;
          book.sheetUrl = res.sheetUrl;
          persist();
          if (currentBook === book) updateExportLink();
        }
      })
      .catch((err) => console.warn("Sheet sync failed", err));
  }

  function bookRef(book) {
    return {
      id: book.id,
      title: book.title,
      // Fold the scope into the name so two scoped entries from the same
      // parent book (e.g. two different chapters) don't collide in Drive.
      heTitle: book.scopeHeRef ? `${book.heTitle} - ${book.scopeHeRef}` : book.heTitle,
      sheetId: book.sheetId,
      docId: book.docId,
    };
  }

  function updateExportLink() {
    const docLink = $("link-open-doc");
    if (currentBook.docUrl) {
      docLink.href = currentBook.docUrl;
      docLink.hidden = false;
    } else {
      docLink.hidden = true;
    }
    const sheetLink = $("link-open-sheet");
    if (currentBook.sheetUrl) {
      sheetLink.href = currentBook.sheetUrl;
      sheetLink.hidden = false;
    } else {
      sheetLink.hidden = true;
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

    $("btn-copy-gas-code").onclick = copyGasCode;
  }

  const GAS_CODE_URL =
    "https://raw.githubusercontent.com/dn-scribe/sefaria-commentary/main/gas/Code.gs";

  async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    // Fallback for older browsers / non-secure contexts.
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  }

  async function copyGasCode() {
    const status = $("copy-gas-status");
    status.textContent = "מוריד את הקוד...";
    try {
      const res = await fetch(GAS_CODE_URL);
      if (!res.ok) throw new Error("שגיאה בהורדת הקוד");
      const code = await res.text();
      await copyToClipboard(code);
      status.textContent = "✅ הקוד הועתק ללוח - הדביקו אותו בעורך ה-Apps Script";
    } catch (err) {
      status.textContent = "❌ ההעתקה נכשלה - השתמשו בקישור 'צפו בקובץ' והעתיקו משם ידנית";
    }
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
