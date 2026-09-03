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
      syncBookList();
    };
  }

  function logout() {
    SC.Auth.logout();
    state = null;
    currentBook = null;
    initAuth();
  }

  // ---------- Books ----------
  function renderBookListOnly() {
    SC.UI.renderBooks(state.books, { onOpen: openBook, onDelete: deleteBook });
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
      next: chapterIndex < chapters.length - 1 ? `custom:${book.id}:${chapterIndex + 1}` : null,
      prev: chapterIndex > 0 ? `custom:${book.id}:${chapterIndex - 1}` : null,
      he: chapter.paragraphs.map((p) => `${p.letter}. ${p.text}`),
      text: [],
      book: book.title,
    };
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
      renderCurrentSection();
      SC.UI.showScreen("reader");
    } catch (err) {
      SC.UI.toast(err.message || "שגיאה בטעינת הטקסט", true);
      return;
    }
    // Local storage is per-device; the Sheet (written on every save) is the
    // durable cross-device copy. Pull it back on open so commentary written
    // elsewhere shows up here too - render first so opening never blocks on it.
    const changed = await pullCommentary(book);
    if (changed && currentBook === book) renderCurrentSection();
  }

  async function pullCommentary(book) {
    if (!state.settings.gasUrl || !book.sheetId) return false;
    try {
      const res = await SC.Api.getCommentary(state.settings.gasUrl, book);
      const local = state.commentary[book.id] || {};
      let changed = false;
      (res.entries || []).forEach((e) => {
        const existing = local[e.ref];
        if (!existing || (e.updatedAt || 0) > (existing.updatedAt || 0)) {
          local[e.ref] = {
            title: e.title,
            text: e.text,
            heText: e.heText || existing?.heText || "",
            enText: e.enText || existing?.enText || "",
            tags: e.tags && e.tags.length ? e.tags : existing?.tags || [],
            updatedAt: e.updatedAt,
          };
          changed = true;
        }
      });
      state.commentary[book.id] = local;
      if (changed) await persist();
      return changed;
    } catch (err) {
      console.warn("Commentary pull failed", err);
      return false;
    }
  }

  function renderCurrentSection() {
    SC.UI.renderReader(currentBook, currentSection, state.commentary[currentBook.id] || {});
    if (currentBook.scopeRef) {
      if (currentSection.next && !isWithinScope(currentSection.next, currentBook.scopeRef)) {
        document.querySelectorAll(".btn-next-section").forEach((b) => (b.disabled = true));
      }
      if (currentSection.prev && !isWithinScope(currentSection.prev, currentBook.scopeRef)) {
        document.querySelectorAll(".btn-prev-section").forEach((b) => (b.disabled = true));
      }
    }
    // A custom book isn't a single Sefaria ref, so there's nothing for this
    // button to open - hide it rather than link somewhere wrong.
    $("btn-open-sefaria").hidden = currentBook.source === "custom";
    $("btn-open-sefaria").onclick = () => window.open(SC.Api.sefariaUrl(currentSection.ref), "_blank");
    updateExportLink();
    // Every navigation (next/prev/home) re-renders through here - always
    // land back at the top of the page rather than wherever was scrolled to.
    window.scrollTo(0, 0);
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
      await persist();
      renderCurrentSection();
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
      await persist();
      renderCurrentSection();
      scheduleBookListSync();
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
      await persist();
      renderCurrentSection();
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
      await persist();
      renderCurrentSection();
      scheduleBookListSync();
    } catch (err) {
      SC.UI.toast(err.message || "שגיאה בטעינת הטקסט", true);
    }
  }

  function initReaderEvents() {
    $("btn-back-to-books").onclick = goToBooks;
    document.querySelectorAll(".btn-prev-section").forEach((b) => (b.onclick = () => goSection("prev")));
    document.querySelectorAll(".btn-next-section").forEach((b) => (b.onclick = () => goSection("next")));
    $("btn-home-section").onclick = goHome;

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
      } else if (e.target.classList.contains("tag-chip-remove")) {
        e.target.closest(".tag-chip").remove();
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
          book.updatedAt = Date.now();
          persist();
          if (currentBook === book) updateExportLink();
          scheduleBookListSync();
        }
      })
      .catch((err) => console.warn("Sheet sync failed", err));
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

    state.books = finalBooks;
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
    $("btn-export-docx").onclick = exportDocx;
  }

  function initVersion() {
    $("header-version").textContent = "v" + SC.APP_VERSION;
    $("app-version").textContent = SC.APP_VERSION;
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
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", SC.App.init);
