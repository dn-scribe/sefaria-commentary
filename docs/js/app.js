// Main controller: wires DOM events to Storage/Auth/Api/UI.
window.SC = window.SC || {};

SC.App = (function () {
  const $ = (id) => document.getElementById(id);

  let state = null;
  let currentBook = null;
  let currentSection = null;
  // Sections appended below currentSection via the "עוד" button - a
  // transient view-only extension, not persisted and not reflected in
  // currentRef/currentHeRef. Any real navigation (next/prev/home/open)
  // resets it, so pagination reverts to normal on the following page.
  let extraSections = [];

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
    if (SC.Auth.hasNoPassword()) {
      startNoPassword();
      return;
    }
    updateLockButton();
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
      updateLockButton();
      await goToBooks();
      syncBookList();
      flushPendingSyncs();
    };
  }

  async function startNoPassword() {
    await SC.Auth.unlockNoPassword();
    state = await SC.Storage.load();
    updateLockButton();
    await goToBooks();
    syncBookList();
    flushPendingSyncs();
  }

  function updateLockButton() {
    $("btn-logout").hidden = SC.Auth.hasNoPassword();
  }

  function logout() {
    SC.Auth.logout();
    state = null;
    currentBook = null;
    initAuth();
  }

  // ---------- Books ----------
  let bookListTab = "active";

  function renderBookListOnly() {
    // Most recently opened first; books never opened yet keep their
    // original (creation) order, after all the ones that have been.
    const showArchived = bookListTab === "archived";
    const sorted = state.books
      .filter((b) => !!b.archived === showArchived)
      .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
    SC.UI.renderBooks(
      sorted,
      { onOpen: openBook, onDelete: deleteBook, onRename: renameBook, onToggleArchive: toggleArchiveBook },
      bookListTab,
      state.books.length
    );
  }

  async function toggleArchiveBook(book) {
    book.archived = !book.archived;
    book.updatedAt = Date.now();
    await persist();
    renderBookListOnly();
    SC.UI.toast(book.archived ? "הועבר לארכיון" : "שוחזר מהארכיון");
    scheduleBookListSync();
  }

  // Only the display name changes - book.title is the Sefaria lookup key
  // for live books, so it stays as is.
  async function renameBook(book) {
    const name = prompt("שם הספר:", book.heTitle || book.title);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      SC.UI.toast("שם הספר לא יכול להיות ריק", true);
      return;
    }
    if (trimmed === book.heTitle) return;
    book.heTitle = trimmed;
    book.updatedAt = Date.now();
    await persist();
    renderBookListOnly();
    SC.UI.toast("השם עודכן");
    scheduleBookListSync();
  }

  async function goToBooks() {
    renderBookListOnly();
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

    $("form-import-custom").onsubmit = async (e) => {
      e.preventDefault();
      const file = $("input-custom-file").files[0];
      if (!file) return;
      await addCustomBook(file);
      $("input-custom-file").value = "";
    };
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
        currentHeRef: idx.firstHeRef,
        showEnglish: $("chk-add-with-english").checked,
        lastRef: null,
        sheetId: null,
        sheetUrl: null,
        docId: null,
        docUrl: null,
        exportedRefs: [],
        tags: [],
        lastExportedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.books.push(book);
      state.commentary[book.id] = {};
      await persist();
      $("input-book-search").value = "";
      SC.UI.renderSearchResults([], () => {});
      await goToBooks();
      SC.UI.toast(`נוסף: ${book.heTitle}`);
      scheduleBookListSync();
      prefetchNewBook(book);
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
      // section.heRef is the Hebrew label of the query itself; if that query
      // was a container (e.g. a whole Part), the actual starting section is
      // more specific and needs its own lookup for an accurate label.
      const startHeRef =
        section.firstAvailableSectionRef === section.ref
          ? section.heRef
          : (await SC.Api.getSection(section.firstAvailableSectionRef)).heRef;
      const book = {
        id: uid(),
        title: idx.title,
        heTitle: idx.heTitle,
        scopeRef: section.ref,
        scopeHeRef: section.heRef,
        currentRef: section.firstAvailableSectionRef,
        currentHeRef: startHeRef,
        showEnglish: $("chk-add-with-english").checked,
        lastRef: null,
        sheetId: null,
        sheetUrl: null,
        docId: null,
        docUrl: null,
        exportedRefs: [],
        tags: [],
        lastExportedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.books.push(book);
      state.commentary[book.id] = {};
      await persist();
      $("input-scope-search").value = "";
      await goToBooks();
      SC.UI.toast(`נוסף: ${book.heTitle} — ${book.scopeHeRef}`);
      scheduleBookListSync();
      prefetchNewBook(book);
    } catch (err) {
      SC.UI.toast(err.message || "לא ניתן לפענח את ההפניה הזו בספריא", true);
    }
  }

  // A book that isn't on Sefaria at all - its full text lives in the book
  // record itself (customContent), not fetched live. Everything else
  // (commentary, navigation, export, cross-device sync) reuses the same
  // machinery as a Sefaria book; only how a "section" is produced differs.
  async function addCustomBook(file) {
    try {
      const text = await file.text();
      const fallbackTitle = file.name.replace(/\.(md|txt)$/i, "");
      const parsed = SC.CustomBook.parseMarkdown(text, fallbackTitle);
      if (!parsed.chapters.length) {
        SC.UI.toast('לא נמצאו פרקים בקובץ - ודאו שהפרקים מסומנים כ-"## פרק..." ', true);
        return;
      }
      const book = {
        id: uid(),
        source: "custom",
        title: parsed.title,
        heTitle: parsed.title,
        scopeRef: null,
        scopeHeRef: null,
        customContent: parsed,
        currentChapterIndex: 0,
        currentRef: null,
        currentHeRef: parsed.chapters[0].title,
        lastRef: null,
        sheetId: null,
        sheetUrl: null,
        docId: null,
        docUrl: null,
        exportedRefs: [],
        tags: [],
        lastExportedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.books.push(book);
      state.commentary[book.id] = {};
      await persist();
      await goToBooks();
      SC.UI.toast(`יובא: ${book.heTitle} (${parsed.chapters.length} פרקים, ${parsed.chapters.reduce((n, c) => n + c.paragraphs.length, 0)} פסקאות)`);
      scheduleBookListSync();
    } catch (err) {
      SC.UI.toast(err.message || "שגיאה בייבוא הקובץ", true);
    }
  }

  // Produces the same shape SC.Api.getSection returns, so the reader/UI
  // code never needs to know a book's text isn't coming from Sefaria.
  function customChapterToSection(book, chapterIndex) {
    const chapters = book.customContent.chapters;
    const chapter = chapters[chapterIndex];
    const ref = `custom:${book.id}:${chapterIndex}`;
    return {
      ref,
      heRef: chapter.title,
      sectionRef: ref,
      chapterIndex,
      next: chapterIndex < chapters.length - 1 ? `custom:${book.id}:${chapterIndex + 1}` : null,
      prev: chapterIndex > 0 ? `custom:${book.id}:${chapterIndex - 1}` : null,
      he: chapter.paragraphs.map((p) => `${p.letter}. ${p.text}`),
      text: [],
      book: book.title,
    };
  }

  // "custom:<bookId>:<chapterIndex>:<n>" (n = paragraph position, 1-based) -
  // pulls out where in customContent a given row's ref points, regardless of
  // whether that row is on the current section or one appended via "עוד".
  function parseCustomParagraphRef(ref) {
    const parts = ref.split(":");
    return { chapterIndex: parseInt(parts[2], 10), paragraphIndex: parseInt(parts[3], 10) - 1 };
  }

  // Re-derives currentSection/extraSections from customContent after an
  // edit to a custom book's source text, so the reader shows the new text
  // without a real navigation (which would drop any "עוד"-appended pages).
  function refreshCustomSections() {
    if (currentBook.source !== "custom") return;
    currentSection = customChapterToSection(currentBook, currentSection.chapterIndex);
    extraSections = extraSections.map((s) => customChapterToSection(currentBook, s.chapterIndex));
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
    if (state.commentaryDeleted) delete state.commentaryDeleted[book.id];
    if (state.pendingSheetSync) delete state.pendingSheetSync[book.id];
    state.deletedBookIds[book.id] = Date.now();
    await persist();
    await goToBooks();
    scheduleBookListSync();
  }

  // ---------- Reader ----------
  async function openBook(book) {
    currentBook = book;
    try {
      currentSection =
        book.source === "custom"
          ? customChapterToSection(book, book.currentChapterIndex || 0)
          : await SC.Api.getSection(book.currentRef || book.title);
      extraSections = [];
      renderCurrentSection();
      window.scrollTo(0, 0);
      SC.UI.showScreen("reader");
    } catch (err) {
      SC.UI.toast(err.message || "שגיאה בטעינת הטקסט", true);
      return;
    }
    book.lastOpenedAt = Date.now();
    book.updatedAt = Date.now();
    await persist();
    scheduleBookListSync();
    // Local storage is per-device; the Sheet (written on every save) is the
    // durable cross-device copy. Pull it back on open so commentary written
    // elsewhere shows up here too - render first so opening never blocks on it.
    // A book first seen via the book list can lack the sheet link if the other
    // device created the sheet after this one last synced - fetch it now.
    if (state.settings.gasUrl && !book.sheetId) {
      await syncBookList();
      book = state.books.find((b) => b.id === book.id) || book;
    }
    const changed = await pullCommentary(book);
    if (changed && currentBook === book) renderCurrentSectionPreservingScroll();
  }

  async function pullCommentary(book) {
    if (!state.settings.gasUrl || !book.sheetId) return false;
    try {
      const res = await SC.Api.getCommentary(state.settings.gasUrl, book);
      const changed = mergeRemoteCommentary(book.id, res.entries || []);
      if (changed) await persist();
      return changed;
    } catch (err) {
      console.warn("Commentary pull failed", err);
      return false;
    }
  }

  // Merges the Sheet's rows into local commentary, per paragraph, newest
  // updatedAt wins - so edits made offline on different devices combine
  // (different paragraphs: both kept; same paragraph: the later edit wins).
  // The Sheet has no "deleted" column, so a deletion travels as a row whose
  // title/text/tags are all empty ("tombstone"); a newer tombstone removes
  // the local comment, a newer edit revives it. Returns true if local changed.
  const TOMBSTONE_TTL = 90 * 24 * 3600 * 1000;
  function mergeRemoteCommentary(bookId, remoteEntries) {
    const local = (state.commentary[bookId] = state.commentary[bookId] || {});
    state.commentaryDeleted = state.commentaryDeleted || {};
    const tombs = (state.commentaryDeleted[bookId] = state.commentaryDeleted[bookId] || {});
    let changed = false;
    remoteEntries.forEach((e) => {
      const remoteTs = e.updatedAt || 0;
      const existing = local[e.ref];
      const localTs = Math.max(existing ? existing.updatedAt || 0 : 0, tombs[e.ref] || 0);
      if (remoteTs <= localTs) return;
      const isTomb = !e.title && !e.text && !(e.tags && e.tags.length);
      if (isTomb) {
        delete local[e.ref];
        tombs[e.ref] = remoteTs;
      } else {
        local[e.ref] = {
          title: e.title,
          text: e.text,
          heText: e.heText || existing?.heText || "",
          enText: e.enText || existing?.enText || "",
          tags: e.tags && e.tags.length ? e.tags : existing?.tags || [],
          updatedAt: remoteTs,
        };
        delete tombs[e.ref];
      }
      changed = true;
    });
    const cutoff = Date.now() - TOMBSTONE_TTL;
    Object.keys(tombs).forEach((ref) => {
      if (tombs[ref] < cutoff) delete tombs[ref];
    });
    return changed;
  }

  function renderCurrentSection() {
    SC.UI.renderReader(currentBook, currentSection, state.commentary[currentBook.id] || {}, extraSections);
    if (currentBook.scopeRef) {
      if (currentSection.next && !isWithinScope(currentSection.next, currentBook.scopeRef)) {
        document.querySelectorAll(".btn-next-section").forEach((b) => (b.disabled = true));
      }
      if (currentSection.prev && !isWithinScope(currentSection.prev, currentBook.scopeRef)) {
        document.querySelectorAll(".btn-prev-section").forEach((b) => (b.disabled = true));
      }
    }
    const lastSection = extraSections.length ? extraSections[extraSections.length - 1] : currentSection;
    if (lastSection.next && currentBook.scopeRef && !isWithinScope(lastSection.next, currentBook.scopeRef)) {
      document.querySelectorAll(".btn-load-more").forEach((b) => (b.disabled = true));
    }
    // A custom book isn't a single Sefaria ref, so there's nothing for this
    // button to open - hide it rather than link somewhere wrong.
    $("btn-open-sefaria").hidden = currentBook.source === "custom";
    $("btn-open-sefaria").onclick = () => window.open(SC.Api.sefariaUrl(currentSection.ref), "_blank");
    updateExportLink();
    ensureOfflineAhead(currentBook, currentSection);
  }

  // ---------- Offline text cache ----------
  // Sefaria text is kept on the device (IndexedDB, see api.js) so a book can
  // be read offline. Rolling window: when fewer than OFFLINE_REFILL cached
  // sections remain ahead of the reader, fetch the next OFFLINE_BATCH. A new
  // book therefore gets its first 50 sections; reading on to ~the 40th pulls
  // the next 50. Custom books carry their text in the book record already.
  const OFFLINE_BATCH = 50;
  const OFFLINE_REFILL = 10;
  const offlineBusy = {};
  const offlineChecked = {};
  const offlineStartDone = {};

  async function ensureOfflineAhead(book, section, announce) {
    if (!book || book.source === "custom" || !section) return;
    if (offlineBusy[book.id] || !navigator.onLine) return;
    const key = section.sectionRef;
    if (offlineChecked[book.id] === key && !announce) return;
    offlineChecked[book.id] = key;
    offlineBusy[book.id] = true;
    try {
      // "להתחלה" (go home) needs the book's first section offline too -
      // independent of where the reader is. Cache-first, so cheap once done.
      if (!offlineStartDone[book.id]) {
        try {
          const start = await SC.Api.getSection(book.scopeRef || book.title);
          await SC.Api.getSection(start.firstAvailableSectionRef);
          offlineStartDone[book.id] = true;
        } catch (e) {
          /* best-effort, retried on the next navigation */
        }
      }
      // Walk the already-cached chain after the current section.
      let ahead = 0;
      let last = section;
      while (ahead <= OFFLINE_REFILL) {
        if (!last.next || !isWithinScope(last.next, book.scopeRef)) return; // end of book/scope
        const cached = await SC.Api.getCachedSection(last.next);
        if (!cached) break;
        last = cached;
        ahead++;
      }
      if (ahead > OFFLINE_REFILL) return; // plenty cached ahead
      let fetched = 0;
      while (fetched < OFFLINE_BATCH && last.next && isWithinScope(last.next, book.scopeRef)) {
        try {
          last = await SC.Api.getSection(last.next);
        } catch (e) {
          break; // offline/rate-limited: resume on the next navigation
        }
        fetched++;
      }
      if (fetched > 0 && announce) {
        SC.UI.toast(`נשמרו ${fetched} קטעים לקריאה ללא חיבור לאינטרנט`);
      }
    } finally {
      offlineBusy[book.id] = false;
    }
  }

  // After adding a Sefaria book: download its first sections in the background.
  async function prefetchNewBook(book) {
    try {
      const section = await SC.Api.getSection(book.currentRef);
      ensureOfflineAhead(book, section, true);
    } catch (e) {
      /* best-effort */
    }
  }

  function initOffline() {
    const banner = $("offline-banner");
    const update = () => (banner.hidden = navigator.onLine);
    update();
    window.addEventListener("offline", update);
    window.addEventListener("online", () => {
      update();
      // Anything written while offline reaches the Sheet / book list now.
      if (!state) return;
      syncBookList();
      flushPendingSyncs();
      if (currentBook && $("screen-reader").classList.contains("active")) {
        ensureOfflineAhead(currentBook, currentSection);
      }
    });

    if ("serviceWorker" in navigator) {
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch((e) => console.warn("SW registration failed", e));
      // A new version took over: tell the user, since open pages keep running old code.
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!hadController || reloaded) return;
        reloaded = true;
        SC.UI.toast("גרסה חדשה הותקנה - רעננו את העמוד");
      });
    }
  }

  // Rebuilding #reader-content (innerHTML="" then re-appending every row)
  // makes the browser clamp/drift the scroll position on its own, even with
  // no explicit scrollTo call - so for edits that shouldn't move the page
  // (save/cancel/delete), capture and re-assert the position rather than
  // just avoiding a reset.
  function renderCurrentSectionPreservingScroll() {
    const y = window.scrollY;
    renderCurrentSection();
    window.scrollTo(0, y);
  }

  async function goSection(direction) {
    if (currentBook.source === "custom") {
      const chapters = currentBook.customContent.chapters;
      const curIdx = currentBook.currentChapterIndex || 0;
      const nextIdx = direction === "next" ? curIdx + 1 : curIdx - 1;
      if (nextIdx < 0 || nextIdx >= chapters.length) return;
      if (direction === "next") currentBook.lastRef = currentSection.heRef;
      currentBook.currentChapterIndex = nextIdx;
      currentBook.currentHeRef = chapters[nextIdx].title;
      currentBook.updatedAt = Date.now();
      currentSection = customChapterToSection(currentBook, nextIdx);
      extraSections = [];
      await persist();
      renderCurrentSection();
      window.scrollTo(0, 0);
      scheduleBookListSync();
      return;
    }

    const ref = direction === "next" ? currentSection.next : currentSection.prev;
    if (!ref || !isWithinScope(ref, currentBook.scopeRef)) return;
    try {
      const section = await SC.Api.getSection(ref);
      if (direction === "next") {
        currentBook.lastRef = currentSection.sectionRef;
      }
      currentBook.currentRef = section.sectionRef;
      currentBook.currentHeRef = section.heRef;
      currentBook.updatedAt = Date.now();
      currentSection = section;
      extraSections = [];
      await persist();
      renderCurrentSection();
      window.scrollTo(0, 0);
      scheduleBookListSync();
    } catch (err) {
      SC.UI.toast(err.message || "שגיאה בטעינת הטקסט", true);
    }
  }

  // Appends the next section below the current one instead of replacing it
  // (the "עוד" button) - for editing across a spot where the app's paging
  // splits the text awkwardly and both parts need to be visible together.
  // Purely a view: not persisted, and any real navigation drops it.
  async function loadMoreSection() {
    const last = extraSections.length ? extraSections[extraSections.length - 1] : currentSection;
    if (!last.next) return;

    if (currentBook.source === "custom") {
      const chapters = currentBook.customContent.chapters;
      const nextIdx = (currentBook.currentChapterIndex || 0) + extraSections.length + 1;
      if (nextIdx >= chapters.length) return;
      extraSections.push(customChapterToSection(currentBook, nextIdx));
      renderCurrentSectionPreservingScroll();
      return;
    }

    if (!isWithinScope(last.next, currentBook.scopeRef)) return;
    try {
      const section = await SC.Api.getSection(last.next);
      extraSections.push(section);
      renderCurrentSectionPreservingScroll();
    } catch (err) {
      SC.UI.toast(err.message || "שגיאה בטעינת הטקסט", true);
    }
  }

  // Jumps back to the very first section/chapter of the book (or of the
  // scope, for a scoped book) - not just one step back like "prev".
  async function goHome() {
    if (currentBook.source === "custom") {
      if ((currentBook.currentChapterIndex || 0) === 0) {
        window.scrollTo(0, 0);
        return;
      }
      currentBook.lastRef = currentSection.heRef;
      currentBook.currentChapterIndex = 0;
      currentBook.currentHeRef = currentBook.customContent.chapters[0].title;
      currentBook.updatedAt = Date.now();
      currentSection = customChapterToSection(currentBook, 0);
      extraSections = [];
      await persist();
      renderCurrentSection();
      window.scrollTo(0, 0);
      scheduleBookListSync();
      return;
    }
    try {
      const start = await SC.Api.getSection(currentBook.scopeRef || currentBook.title);
      const section = await SC.Api.getSection(start.firstAvailableSectionRef);
      currentBook.lastRef = currentSection.sectionRef;
      currentBook.currentRef = section.sectionRef;
      currentBook.currentHeRef = section.heRef;
      currentBook.updatedAt = Date.now();
      currentSection = section;
      extraSections = [];
      await persist();
      renderCurrentSection();
      window.scrollTo(0, 0);
      scheduleBookListSync();
    } catch (err) {
      SC.UI.toast(err.message || "שגיאה בטעינת הטקסט", true);
    }
  }

  function initReaderEvents() {
    $("btn-back-to-books").onclick = goToBooks;
    document.querySelectorAll(".btn-prev-section").forEach((b) => (b.onclick = () => goSection("prev")));
    document.querySelectorAll(".btn-next-section").forEach((b) => (b.onclick = () => goSection("next")));
    document.querySelectorAll(".btn-load-more").forEach((b) => (b.onclick = () => loadMoreSection()));
    $("btn-home-section").onclick = goHome;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.onclick = () => {
        bookListTab = b.dataset.tab;
        renderBookListOnly();
      };
    });

    // Tapping a word in an editing textarea (source text or comment) moves
    // the caret to the beginning of that word (double tap: the end). Range selections are left alone.
    $("reader-content").addEventListener("click", (e) => {
      const ta = e.target;
      if (!ta.matches || !ta.matches(".source-text-input, .commentary-text-input")) return;
      if (ta.selectionStart !== ta.selectionEnd) return;
      const pos = ta.selectionStart;
      const text = ta.value;
      if (/\s/.test(text.charAt(pos)) && (pos === 0 || /\s/.test(text.charAt(pos - 1)))) return;
      let start = pos;
      while (start > 0 && !/\s/.test(text.charAt(start - 1))) start--;
      ta.setSelectionRange(start, start);
    });

    // Double tap selects the word natively; collapse the caret to its end.
    $("reader-content").addEventListener("dblclick", (e) => {
      const ta = e.target;
      if (!ta.matches || !ta.matches(".source-text-input, .commentary-text-input")) return;
      setTimeout(() => {
        const text = ta.value;
        let end = ta.selectionEnd;
        while (end > ta.selectionStart && /\s/.test(text.charAt(end - 1))) end--;
        ta.setSelectionRange(end, end);
      }, 0);
    });

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
        renderCurrentSectionPreservingScroll();
      } else if (e.target.classList.contains("btn-delete-comment")) {
        deleteComment(row.dataset.ref);
      } else if (e.target.classList.contains("tag-chip-remove")) {
        e.target.closest(".tag-chip").remove();
      } else if (
        e.target.classList.contains("btn-edit-source") ||
        (e.target.classList.contains("verse-he") &&
          row.querySelector(".btn-edit-source") &&
          !window.getSelection().toString())
      ) {
        enterSourceEditMode(row);
      } else if (e.target.classList.contains("btn-cancel-source")) {
        renderCurrentSectionPreservingScroll();
      } else if (e.target.classList.contains("btn-save-source")) {
        const text = row.querySelector(".source-text-input").value.trim();
        saveSourceText(row.dataset.ref, text);
      }
    });

    $("reader-content").addEventListener("change", (e) => {
      if (!e.target.classList.contains("tag-select")) return;
      const row = e.target.closest(".verse-row");
      const select = e.target;
      const value = select.value;
      select.value = "";
      if (!value) return;
      if (value === "__new__") {
        const name = (prompt("שם התגית החדשה:") || "").trim();
        if (!name) return;
        addTagToBook(name);
        addTagChip(row, name);
      } else {
        addTagChip(row, value);
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
      const tags = Array.from(row.querySelectorAll(".tag-chip-list .tag-chip")).map((el) => el.dataset.tag);
      saveComment(row.dataset.ref, { title, text, heText, enText: enEl ? enEl.textContent : "", tags });
    });
  }

  // Adds a tag to the row's in-progress chip list (no duplicates). Existing
  // chips are already in the DOM from the server-rendered template; this only
  // handles chips added interactively during this edit session.
  function addTagChip(row, tag) {
    const list = row.querySelector(".tag-chip-list");
    if (Array.from(list.children).some((c) => c.dataset.tag === tag)) return;
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.dataset.tag = tag;
    const label = document.createElement("span");
    label.textContent = tag;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "tag-chip-remove";
    removeBtn.textContent = "×";
    chip.appendChild(label);
    chip.appendChild(removeBtn);
    list.appendChild(chip);
  }

  // Adds a new tag to the book's tag list (available to every paragraph in
  // this book) and reflects it into every tag-select on the current page
  // immediately, without a full re-render.
  function addTagToBook(tag) {
    currentBook.tags = currentBook.tags || [];
    if (currentBook.tags.includes(tag)) return;
    currentBook.tags.push(tag);
    currentBook.updatedAt = Date.now();
    persist();
    scheduleBookListSync();
    document.querySelectorAll(".tag-select").forEach((select) => {
      const opt = document.createElement("option");
      opt.value = tag;
      opt.textContent = tag;
      select.insertBefore(opt, select.lastElementChild);
    });
  }

  function enterEditMode(row, focusTitle) {
    row.querySelector(".title-view").hidden = true;
    row.querySelector(".btn-add-title").hidden = true;
    row.querySelector(".commentary-title-input").hidden = false;

    row.querySelector(".commentary-view").hidden = true;
    row.querySelector(".btn-add-comment").hidden = true;
    row.querySelector(".commentary-text-input").hidden = false;
    row.querySelector(".tag-editor").hidden = false;
    row.querySelector(".commentary-save-actions").hidden = false;

    const target = focusTitle
      ? row.querySelector(".commentary-title-input")
      : row.querySelector(".commentary-text-input");
    target.focus();
  }

  async function saveComment(ref, data) {
    if (!data.text && !data.title) {
      await deleteComment(ref);
      return;
    }
    const bookId = currentBook.id;
    state.commentary[bookId] = state.commentary[bookId] || {};
    state.commentary[bookId][ref] = { ...data, updatedAt: Date.now() };
    if (state.commentaryDeleted && state.commentaryDeleted[bookId]) delete state.commentaryDeleted[bookId][ref];
    markSheetDirty(bookId);
    await persist();
    renderCurrentSectionPreservingScroll();
    SC.UI.toast("נשמר");
    syncToSheet();
  }

  async function deleteComment(ref) {
    const bookId = currentBook.id;
    if (state.commentary[bookId]) delete state.commentary[bookId][ref];
    state.commentaryDeleted = state.commentaryDeleted || {};
    (state.commentaryDeleted[bookId] = state.commentaryDeleted[bookId] || {})[ref] = Date.now();
    markSheetDirty(bookId);
    await persist();
    renderCurrentSectionPreservingScroll();
    SC.UI.toast("נמחק");
    syncToSheet();
  }

  function enterSourceEditMode(row) {
    row.querySelector(".verse-he").hidden = true;
    row.querySelector(".btn-edit-source").hidden = true;
    row.querySelector(".source-text-input").hidden = false;
    row.querySelector(".source-edit-actions").hidden = false;
    row.querySelector(".source-text-input").focus();
  }

  // Edits a custom book's own source paragraph text (only ever applies to
  // source === "custom" books - the row's edit-source control only exists
  // for those to begin with). Commentary on the same ref is untouched.
  async function saveSourceText(ref, text) {
    if (!text) {
      SC.UI.toast("הטקסט לא יכול להיות ריק", true);
      return;
    }
    const { chapterIndex, paragraphIndex } = parseCustomParagraphRef(ref);
    currentBook.customContent.chapters[chapterIndex].paragraphs[paragraphIndex].text = text;
    currentBook.updatedAt = Date.now();
    await persist();
    refreshCustomSections();
    renderCurrentSectionPreservingScroll();
    SC.UI.toast("נשמר");
    scheduleBookListSync();
  }

  // ---------- Google sync / export ----------
  // One sync at a time per book: two overlapping first syncs (no sheetId yet)
  // would each create their own Sheet. Each run first pulls and merges what
  // other devices wrote (newest edit per paragraph wins), then pushes the
  // merged result - the Sheet is rewritten wholesale, so pushing without
  // pulling would erase another device's offline edits.
  // A book stays "pending" until a sync succeeds, so edits made offline are
  // pushed when the connection returns (even after the app was closed).
  const sheetSyncChains = {};
  function markSheetDirty(bookId) {
    state.pendingSheetSync = state.pendingSheetSync || {};
    state.pendingSheetSync[bookId] = true;
  }

  function syncToSheet() {
    syncBookToSheet(currentBook);
  }

  function entriesWithTombstones(bookId) {
    const tombs = (state.commentaryDeleted && state.commentaryDeleted[bookId]) || {};
    const rows = Object.keys(tombs).map((ref) => ({
      ref, title: "", text: "", heText: "", enText: "", tags: [], updatedAt: tombs[ref],
    }));
    return sortedEntries(bookId).concat(rows);
  }

  function syncBookToSheet(book) {
    if (!state || !book || !state.settings.gasUrl) return;
    const run = async () => {
      if (!state) return;
      state.pendingSheetSync = state.pendingSheetSync || {};
      state.pendingSheetSync[book.id] = false;
      try {
        if (book.sheetId && (await pullCommentary(book)) && currentBook === book) {
          renderCurrentSectionPreservingScroll();
        }
        const res = await SC.Api.callGas(state.settings.gasUrl, {
          action: "sync",
          book: bookRef(book),
          entries: entriesWithTombstones(book.id),
        });
        if (res.sheetId && !book.sheetId) {
          book.sheetId = res.sheetId;
          book.sheetUrl = res.sheetUrl;
          book.updatedAt = Date.now();
          if (currentBook === book) updateExportLink();
          scheduleBookListSync();
        }
        await persist();
      } catch (err) {
        console.warn("Sheet sync failed", err);
        if (state) {
          state.pendingSheetSync[book.id] = true;
          persist().catch(() => {});
        }
      }
    };
    sheetSyncChains[book.id] = (sheetSyncChains[book.id] || Promise.resolve()).then(run);
  }

  function flushPendingSyncs() {
    if (!state || !state.settings.gasUrl || !navigator.onLine) return;
    Object.keys(state.pendingSheetSync || {}).forEach((id) => {
      if (!state.pendingSheetSync[id]) return;
      const book = state.books.find((b) => b.id === id);
      if (book) syncBookToSheet(book);
      else delete state.pendingSheetSync[id];
    });
  }

  // ---------- Book list sync (cross-device) ----------
  // Only book metadata (titles, refs, reading position, linked sheet/doc
  // ids) syncs through this - commentary text never does, only via the
  // existing per-book sync/export.
  let bookListSyncTimer = null;
  function scheduleBookListSync() {
    clearTimeout(bookListSyncTimer);
    bookListSyncTimer = setTimeout(syncBookList, 800);
  }

  async function syncBookList() {
    if (!state.settings.gasUrl) return;
    try {
      const remote = await SC.Api.getBookList(state.settings.gasUrl);
      mergeRemoteBookList(remote);
      await persist();
      renderBookListOnly();
      await SC.Api.setBookList(state.settings.gasUrl, state.books, state.deletedBookIds);
    } catch (err) {
      console.warn("Book list sync failed", err);
    }
  }

  // Last-write-wins per book, keyed by each book's own updatedAt, with
  // tombstones so a delete on one device doesn't get resurrected by a
  // stale add still sitting on another device.
  function mergeRemoteBookList(remote) {
    const remoteBooks = remote.books || [];
    const remoteDeleted = remote.deletedBookIds || {};

    Object.keys(remoteDeleted).forEach((id) => {
      const ts = remoteDeleted[id];
      if (!state.deletedBookIds[id] || ts > state.deletedBookIds[id]) {
        state.deletedBookIds[id] = ts;
      }
    });

    const merged = new Map();
    remoteBooks.forEach((rb) => merged.set(rb.id, rb));
    state.books.forEach((lb) => {
      const rb = merged.get(lb.id);
      if (!rb || (lb.updatedAt || 0) >= (rb.updatedAt || 0)) {
        merged.set(lb.id, lb);
      }
    });

    const finalBooks = [];
    merged.forEach((b, id) => {
      const deletedAt = state.deletedBookIds[id];
      if (deletedAt && deletedAt >= (b.updatedAt || 0)) return;
      finalBooks.push(b);
    });

    // Whichever side wins on updatedAt, never drop the Sheet/Doc link the
    // other side has - a stale device that merely opened the book (bumping
    // its updatedAt) must not wipe the link another device created.
    const LINK_KEYS = ["sheetId", "sheetUrl", "docId", "docUrl"];
    finalBooks.forEach((b) => {
      const other = remoteBooks.find((rb) => rb.id === b.id);
      if (!other || other === b) return;
      LINK_KEYS.forEach((k) => {
        if (!b[k] && other[k]) b[k] = other[k];
      });
      // Tags only ever get added, so combine instead of letting the winning
      // side's list replace the other's (two devices adding tags offline).
      const tags = Array.from(new Set([...(b.tags || []), ...(other.tags || [])]));
      if (tags.length !== (b.tags || []).length) b.tags = tags;
    });

    state.books = finalBooks;
    if (currentBook) currentBook = finalBooks.find((b) => b.id === currentBook.id) || currentBook;
    finalBooks.forEach((b) => {
      if (!state.commentary[b.id]) state.commentary[b.id] = {};
    });
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

  // Walks every section of the book (or, if scoped, just within that scope)
  // via next/prev chaining, producing one row per line whether or not it
  // has commentary - a text-only row still shows the source in the Doc.
  async function collectFullText(book) {
    if (book.source === "custom") return collectCustomFullText(book);
    const commentary = state.commentary[book.id] || {};
    const start = await SC.Api.getSection(book.scopeRef || book.title);
    const entries = [];
    let sectionRef = start.firstAvailableSectionRef;
    let guard = 0;
    while (sectionRef && guard < 1000) {
      guard++;
      const section = await SC.Api.getSection(sectionRef);
      const lines = section.he.length ? section.he : section.text;
      const enLines = section.text;
      lines.forEach((line, i) => {
        const ref = SC.UI.commentaryRefFor(section.sectionRef, i);
        const c = commentary[ref];
        entries.push({
          ref,
          heText: SC.UI.stripTags(line),
          enText: SC.UI.stripTags(enLines[i] || ""),
          title: c ? c.title || "" : "",
          text: c ? c.text || "" : "",
          tags: c ? c.tags || [] : [],
          updatedAt: c ? c.updatedAt || 0 : 0,
        });
      });
      if (!section.next || !isWithinScope(section.next, book.scopeRef)) break;
      sectionRef = section.next;
    }
    return entries;
  }

  function collectCustomFullText(book) {
    const commentary = state.commentary[book.id] || {};
    const entries = [];
    book.customContent.chapters.forEach((chapter, ci) => {
      chapter.paragraphs.forEach((p, pi) => {
        const ref = SC.UI.commentaryRefFor(`custom:${book.id}:${ci}`, pi);
        const c = commentary[ref];
        entries.push({
          ref,
          heText: `${p.letter}. ${p.text}`,
          enText: "",
          title: c ? c.title || "" : "",
          text: c ? c.text || "" : "",
          tags: c ? c.tags || [] : [],
          updatedAt: c ? c.updatedAt || 0 : 0,
        });
      });
    });
    return entries;
  }

  async function exportBook(mode) {
    if (!state.settings.gasUrl) {
      SC.UI.toast("יש להגדיר כתובת Google Apps Script בהגדרות תחילה", true);
      return;
    }
    const fullText = $("chk-export-full-text").checked;
    $("export-status").textContent = fullText
      ? "אוסף את הטקסט המלא... זה עשוי לקחת זמן לספרים גדולים"
      : "אוסף פרשנות...";
    let all;
    try {
      all = fullText ? await collectFullText(currentBook) : sortedEntries(currentBook.id);
    } catch (err) {
      $("export-status").textContent = "";
      SC.UI.toast(err.message || "שגיאה באיסוף הטקסט", true);
      return;
    }
    const entries =
      mode === "replace"
        ? all
        : all.filter(
            (e) => !currentBook.exportedRefs.includes(e.ref) || e.updatedAt > (currentBook.lastExportedAt || 0)
          );

    if (!entries.length) {
      $("export-status").textContent = "";
      SC.UI.toast("אין תוכן חדש לייצוא");
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
      currentBook.updatedAt = Date.now();
      await persist();
      updateExportLink();
      SC.UI.toast("הייצוא הושלם");
      scheduleBookListSync();
    } catch (err) {
      $("export-status").textContent = "";
      SC.UI.toast(err.message || "הייצוא נכשל", true);
    }
  }

  // ---------- Word (.docx) export - no Google account needed ----------
  // Runs entirely client-side via the vendored docx.js (js/vendor/docx.min.js)
  // and triggers a normal browser download. One-shot: unlike the Google Doc
  // export there's no "update only" concept, since there's no persisted
  // remote file to diff against - it's always the current full set.
  async function exportDocx() {
    const fullText = $("chk-export-full-text").checked;
    $("export-status").textContent = fullText
      ? "אוסף את הטקסט המלא... זה עשוי לקחת זמן לספרים גדולים"
      : "אוסף פרשנות...";
    let entries;
    try {
      entries = fullText ? await collectFullText(currentBook) : sortedEntries(currentBook.id);
    } catch (err) {
      $("export-status").textContent = "";
      SC.UI.toast(err.message || "שגיאה באיסוף הטקסט", true);
      return;
    }
    if (!entries.length) {
      $("export-status").textContent = "";
      SC.UI.toast("אין תוכן לייצוא");
      return;
    }

    $("export-status").textContent = "בונה קובץ Word...";
    try {
      const blob = await buildDocxBlob(currentBook, entries);
      const label = currentBook.heTitle + (currentBook.scopeHeRef ? " - " + currentBook.scopeHeRef : "");
      downloadBlob(blob, `${label} - פרשנות.docx`);
      $("export-status").textContent = "קובץ ה-Word הורד";
    } catch (err) {
      $("export-status").textContent = "";
      SC.UI.toast(err.message || "יצירת קובץ ה-Word נכשלה", true);
    }
  }

  // Mirrors gas/Code.gs's handleExport layout: title on top, source text,
  // a clickable Sefaria link, then the comment - all right-aligned.
  function buildDocxBlob(book, entries) {
    const { Document, Packer, Paragraph, TextRun, ExternalHyperlink, HeadingLevel, AlignmentType } = window.docx;
    const label = book.heTitle + (book.scopeHeRef ? " - " + book.scopeHeRef : "");

    const rightPara = (opts) => new Paragraph({ alignment: AlignmentType.RIGHT, bidirectional: true, ...opts });

    const children = [rightPara({ text: label + " - פרשנות", heading: HeadingLevel.TITLE })];

    entries.forEach((entry) => {
      if (entry.title) {
        children.push(
          rightPara({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: entry.title, bold: true })] })
        );
      }
      if (entry.heText) {
        children.push(rightPara({ children: [new TextRun(entry.heText)] }));
      }
      if (entry.ref && !entry.ref.startsWith("custom:")) {
        children.push(
          rightPara({
            children: [
              new ExternalHyperlink({
                link: SC.Api.sefariaUrl(entry.ref),
                children: [new TextRun({ text: entry.ref, color: "1155CC", underline: {} })],
              }),
            ],
          })
        );
      }
      if (entry.text) {
        children.push(rightPara({ children: [new TextRun(entry.text)] }));
      }
      if (entry.tags && entry.tags.length) {
        children.push(
          rightPara({ children: [new TextRun({ text: "תגיות: " + entry.tags.join(", "), italics: true })] })
        );
      }
      children.push(rightPara({ text: "" }));
    });

    return Packer.toBlob(new Document({ sections: [{ children }] }));
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- Settings ----------
  function initSettings() {
    $("btn-nav-settings").onclick = () => {
      $("input-gas-url").value = state.settings.gasUrl || "";
      $("settings-status").textContent = "";
      $("chk-skip-pwd").checked = SC.Auth.hasNoPassword();
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

    $("chk-skip-pwd").onchange = async (e) => {
      const box = e.target;
      if (box.checked) {
        if (!confirm("האפליקציה תיפתח ללא סיסמה. מתאים רק לדפדפן אישי. להמשיך?")) {
          box.checked = false;
          return;
        }
        const pending = await SC.Auth.generateNoPasswordKey();
        await SC.Storage.saveWithKey(state, pending.key);
        SC.Auth.commitNoPassword(pending);
        SC.UI.toast("הסיסמה בוטלה");
      } else {
        const pass = prompt("בחרו סיסמה חדשה:");
        if (!pass) {
          box.checked = true;
          return;
        }
        await SC.Auth.createPassphrase(pass);
        await persist();
        SC.Auth.clearNoPassword();
        SC.UI.toast("הסיסמה הופעלה");
      }
      updateLockButton();
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
    $("btn-export-docx").onclick = exportDocx;
  }

  // Asks the server (bypassing every cache) which version is live; if it's
  // newer, drops the service worker + its caches, re-downloads the app files
  // past the browser's HTTP cache (GitHub Pages sends max-age=600) and reloads.
  async function checkForUpdate() {
    const btn = $("btn-check-update");
    btn.disabled = true;
    try {
      let res;
      try {
        res = await fetch("js/version.js?t=" + Date.now(), { cache: "no-store" });
      } catch (e) {
        SC.UI.toast("אין חיבור לאינטרנט", true);
        return;
      }
      const m = res.ok && /APP_VERSION\s*=\s*"([^"]+)"/.exec(await res.text());
      if (!m) {
        SC.UI.toast("לא ניתן לבדוק עדכון כרגע", true);
        return;
      }
      if (m[1] === SC.APP_VERSION) {
        SC.UI.toast(`הגרסה עדכנית (${SC.APP_VERSION})`);
        return;
      }
      SC.UI.toast(`מעדכן לגרסה ${m[1]}...`);
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k.startsWith("sc-shell-")).map((k) => caches.delete(k)));
      }
      await Promise.all((SC.SHELL_FILES || []).map((u) => fetch(u, { cache: "reload" }).catch(() => null)));
      location.reload();
    } finally {
      btn.disabled = false;
    }
  }

  function initVersion() {
    $("header-version").textContent = "v" + SC.APP_VERSION;
    $("app-version").textContent = SC.APP_VERSION;
    $("btn-check-update").onclick = checkForUpdate;
    $("btn-view-changelog").onclick = () => {
      SC.UI.renderChangelog(SC.CHANGELOG);
      SC.UI.showScreen("changelog");
    };
    $("btn-back-from-changelog").onclick = () => SC.UI.showScreen("settings");
  }

  function init() {
    initAuth();
    initBookSearch();
    initReaderEvents();
    initSettings();
    initHeader();
    initVersion();
    initOffline();
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", SC.App.init);
