// Parses a locally-authored book (not on Sefaria) from Markdown into the
// same chapter/paragraph shape the reader can walk, so the rest of the app
// (commentary, navigation, export) never has to know the difference.
//
// Expected format (one paragraph per line, chapters as level-2 headings):
//   ## פרק א. כותרת הפרק
//   **א.** טקסט הפסקה כאן.
//   *מקור מדויק:* [שם המקור ↗](https://...)   (optional, right after a paragraph)
window.SC = window.SC || {};

SC.CustomBook = (function () {
  const CHAPTER_RE = /^##\s+(.+?)\s*$/;
  const PARA_RE = /^\*\*([^*]+)\.\*\*\s*(.+?)\s*$/;
  const SOURCE_RE = /^\*([^:*]+):\*\s*\[([^\]]+)\]\(([^)]+)\)/;
  const TITLE_RE = /^#\s+(.+?)\s*$/;

  function parseMarkdown(md, fallbackTitle) {
    const lines = md.split(/\r?\n/);
    let title = null;
    const chapters = [];
    let current = null;
    let pending = null;

    const flush = () => {
      if (pending && current) current.paragraphs.push(pending);
      pending = null;
    };

    lines.forEach((raw) => {
      const line = raw.trim();
      if (!title) {
        const t = line.match(TITLE_RE);
        if (t) {
          title = t[1];
          return;
        }
      }
      const ch = line.match(CHAPTER_RE);
      const para = line.match(PARA_RE);
      const src = line.match(SOURCE_RE);
      if (ch) {
        flush();
        current = { title: ch[1], paragraphs: [] };
        chapters.push(current);
      } else if (para && current) {
        flush();
        pending = { letter: para[1], text: para[2], sourceLabel: null, sourceUrl: null };
      } else if (src && pending) {
        pending.sourceLabel = `${src[1].trim()}: ${src[2].replace(/\s*↗\s*$/, "").trim()}`;
        pending.sourceUrl = src[3];
      } else if (line && pending && !/^<\/?[a-zA-Z][^>]*>$/.test(line)) {
        // A soft-wrapped continuation of the current paragraph's text -
        // but not a stray HTML wrapper tag (e.g. a trailing </div>).
        pending.text += " " + line;
      }
    });
    flush();

    return { title: title || fallbackTitle, chapters };
  }

  return { parseMarkdown };
})();
