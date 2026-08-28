// DOM rendering. No app/business logic here - app.js wires events into these.
window.SC = window.SC || {};

SC.UI = (function () {
  function $(id) {
    return document.getElementById(id);
  }

  function showScreen(name) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
    $(`screen-${name}`).classList.add("active");
    $("app-header").hidden = name === "auth";
  }

  let toastTimer = null;
  function toast(msg, isError) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    el.classList.toggle("toast-error", !!isError);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3500);
  }

  function renderAuthMode(mode) {
    $("auth-title").textContent = mode === "create" ? "יצירת סיסמה" : "כניסה";
    $("auth-subtitle").textContent =
      mode === "create"
        ? "הסיסמה מגנה על הנתונים שלכם במכשיר הזה בלבד. אין לשכוח אותה - אין דרך לשחזר אותה."
        : "הזינו את הסיסמה שלכם כדי לפתוח את הנתונים המקומיים.";
    $("label-confirm").hidden = mode !== "create";
    $("input-passphrase-confirm").required = mode === "create";
    $("auth-error").hidden = true;
    $("input-passphrase").value = "";
    $("input-passphrase-confirm").value = "";
    $("input-passphrase").focus();
  }

  function authError(msg) {
    const el = $("auth-error");
    el.textContent = msg;
    el.hidden = false;
  }

  function renderSearchResults(items, onSelect, targetId) {
    const ul = $(targetId || "book-search-results");
    ul.innerHTML = "";
    items.forEach((item) => {
      const title = item.split("|")[0] || item;
      const li = document.createElement("li");
      li.className = "result-item";
      li.textContent = title;
      li.addEventListener("click", () => onSelect(title));
      ul.appendChild(li);
    });
  }

  function renderBooks(books, handlers) {
    const list = $("book-list");
    list.innerHTML = "";
    $("empty-state").hidden = books.length > 0;
    books.forEach((book) => {
      const li = document.createElement("li");
      li.className = "book-item";
      li.innerHTML = `
        <div class="book-info">
          <strong>${escapeHtml(book.heTitle || book.title)}${book.scopeHeRef ? " — " + escapeHtml(book.scopeHeRef) : ""}</strong>
          <span class="muted">${escapeHtml(book.currentHeRef || book.currentRef || "")}</span>
        </div>
        <div class="book-actions">
          <button class="secondary btn-open">פתיחה</button>
          <button class="danger btn-delete">מחיקה</button>
        </div>`;
      li.querySelector(".btn-open").addEventListener("click", () => handlers.onOpen(book));
      li.querySelector(".btn-delete").addEventListener("click", () => handlers.onDelete(book));
      list.appendChild(li);
    });
  }

  function commentaryRefFor(sectionRef, index) {
    return `${sectionRef}:${index + 1}`;
  }

  function renderReader(book, section, commentaryMap) {
    $("reader-book-title").textContent = book.heTitle || book.title;
    $("reader-section-title").textContent = section.heRef || section.sectionRef;

    const lines = section.he.length ? section.he : section.text;
    const enLines = section.text;
    const container = $("reader-content");
    container.innerHTML = "";

    if (!lines.length) {
      container.innerHTML = `<p class="muted">אין טקסט זמין לקטע זה.</p>`;
      return;
    }

    lines.forEach((line, i) => {
      const ref = commentaryRefFor(section.sectionRef, i);
      const existing = commentaryMap[ref];
      const row = document.createElement("form");
      row.className = "verse-row";
      row.dataset.ref = ref;
      row.innerHTML = `
        <div class="verse-title-row">
          <div class="title-view" ${existing?.title ? "" : "hidden"}>
            <strong>${escapeHtml(existing?.title || "")}</strong>
            <button type="button" class="link-btn btn-edit-title">עריכה</button>
          </div>
          <button type="button" class="link-btn btn-add-title" ${existing?.title ? "hidden" : ""}>+ הוספת כותרת</button>
          <input type="text" class="commentary-title-input" placeholder="כותרת הקטע" value="${escapeAttr(existing?.title || "")}" hidden />
        </div>
        <div class="verse-text">
          <span class="verse-num">${i + 1}</span>
          <span class="verse-he">${escapeHtml(stripTags(line))}</span>
          ${enLines[i] ? `<span class="verse-en muted">${escapeHtml(stripTags(enLines[i]))}</span>` : ""}
        </div>
        <div class="verse-commentary-row">
          <div class="commentary-view" ${existing?.text ? "" : "hidden"}>
            <div class="commentary-text">${linkify(escapeHtml(existing?.text || ""))}</div>
            <div class="commentary-actions">
              <button type="button" class="link-btn btn-edit-comment">עריכה</button>
              <button type="button" class="link-btn btn-delete-comment">מחיקה</button>
            </div>
          </div>
          <button type="button" class="link-btn btn-add-comment" ${existing?.text ? "hidden" : ""}>+ הוספת פרשנות</button>
          <textarea class="commentary-text-input" placeholder="כתבו את הפרשנות כאן..." rows="3" hidden>${existing?.text || ""}</textarea>
          <div class="row-actions commentary-save-actions" hidden>
            <button type="submit" class="primary">שמירה</button>
            <button type="button" class="secondary btn-cancel-comment">ביטול</button>
          </div>
        </div>`;
      container.appendChild(row);
    });

    $("btn-prev-section").disabled = !section.prev;
    $("btn-next-section").disabled = !section.next;
  }

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }
  function escapeAttr(str) {
    return escapeHtml(str);
  }
  function stripTags(str) {
    return String(str || "")
      .replace(/<sup[^>]*>.*?<\/sup>/gi, "")
      .replace(/<i class="footnote">.*?<\/i>/gi, "")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&");
  }
  function linkify(str) {
    return str.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  }

  return {
    showScreen,
    toast,
    renderAuthMode,
    authError,
    renderSearchResults,
    renderBooks,
    renderReader,
    commentaryRefFor,
    stripTags,
  };
})();
