// Sefaria API + Google Apps Script export integration.
window.SC = window.SC || {};

SC.Api = (function () {
  const BASE = "https://www.sefaria.org";

  async function searchTitles(query) {
    if (!query || query.trim().length < 2) return [];
    const res = await fetch(`${BASE}/api/name/${encodeURIComponent(query.trim())}`);
    if (!res.ok) throw new Error("Sefaria search failed");
    const json = await res.json();
    return (json.completions || []).slice(0, 12);
  }

  async function getIndex(title) {
    const res = await fetch(`${BASE}/api/index/${encodeURIComponent(title)}`);
    if (!res.ok) throw new Error("Book not found on Sefaria");
    const json = await res.json();
    const firstRef = await getFirstSectionRef(json.title || title);
    return {
      title: json.title || title,
      heTitle: json.heTitle || json.title || title,
      firstRef,
    };
  }

  async function getFirstSectionRef(title) {
    const res = await fetch(
      `${BASE}/api/texts/${encodeURIComponent(title)}?context=0&pad=0&commentary=0`
    );
    if (!res.ok) return title;
    const json = await res.json();
    return json.firstAvailableSectionRef || json.sectionRef || title;
  }

  async function getSection(ref) {
    const res = await fetch(
      `${BASE}/api/texts/${encodeURIComponent(ref)}?context=0&pad=0&commentary=0`
    );
    if (!res.ok) throw new Error("Failed to load text from Sefaria");
    const json = await res.json();
    return {
      ref: json.ref,
      heRef: json.heRef || json.ref,
      sectionRef: json.sectionRef || json.ref,
      // For a container-level ref (e.g. a whole Part) this drills down to
      // the first actual page to display; for an already-leaf ref it's
      // effectively the same ref (or one level more specific).
      firstAvailableSectionRef: json.firstAvailableSectionRef || json.sectionRef || json.ref,
      next: json.next || null,
      prev: json.prev || null,
      he: normalizeLines(json.he),
      text: normalizeLines(json.text),
      book: json.book || json.indexTitle,
    };
  }

  // Sefaria sometimes nests arrays (e.g. Talmud); flatten one level to plain strings.
  function normalizeLines(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.map((v) => (Array.isArray(v) ? v.join(" ") : v));
    }
    return [value];
  }

  // Chapter counts for building a chapter picker, e.g. [{length: 50, chapters: [31, 25, ...]}].
  // Only covers the book's default addressing node - multi-part texts with
  // alt-structures (e.g. a Likutei Moharan "Part II") need their own query
  // by that part's own ref (which this same endpoint also accepts).
  async function getShape(title) {
    const res = await fetch(`${BASE}/api/shape/${encodeURIComponent(title)}`);
    if (!res.ok) throw new Error("שגיאה בטעינת מבנה הפרקים");
    const json = await res.json();
    const item = Array.isArray(json) ? json[0] : json;
    if (!item || !item.length) throw new Error("לא נמצא מבנה פרקים לספר זה");
    return { length: item.length };
  }

  function sefariaUrl(ref) {
    return `${BASE}/${ref.replace(/ /g, "_")}`;
  }

  // Apps Script web apps choke on CORS preflight for JSON content-type,
  // so we send text/plain and parse JSON manually server-side.
  async function callGas(gasUrl, payload) {
    const res = await fetch(gasUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Google script error (${res.status})`);
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    return json;
  }

  async function getCommentary(gasUrl, book) {
    return callGas(gasUrl, { action: "getCommentary", book: { sheetId: book.sheetId } });
  }

  async function getBookList(gasUrl) {
    return callGas(gasUrl, { action: "getBookList" });
  }

  async function setBookList(gasUrl, books, deletedBookIds) {
    return callGas(gasUrl, { action: "setBookList", books, deletedBookIds });
  }

  return {
    searchTitles,
    getIndex,
    getSection,
    getShape,
    sefariaUrl,
    callGas,
    getBookList,
    setBookList,
    getCommentary,
  };
})();
