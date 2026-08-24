/**
 * Sefaria Commentary - Google Apps Script backend.
 *
 * Deploy:
 *   1. https://script.google.com/ -> New project, paste this file in as Code.gs.
 *   2. Deploy -> New deployment -> type "Web app".
 *   3. Execute as: Me. Who has access: Anyone (NOT "Only myself" - that
 *      rejects every request with 401, since a browser fetch() has no way
 *      to prove it's you; the code still only ever runs as you either way,
 *      and the deployment URL is an unguessable secret token).
 *   4. Deploy, authorize the requested Drive/Docs/Sheets scopes.
 *   5. Copy the web app URL into the app's Settings screen.
 *
 * Each book gets its own Google Sheet (acts as the synced "database" of
 * commentary) and its own Google Doc (the exported, readable document).
 * The app sends the sheet/doc ids back on every call once they exist, so
 * this script never has to keep its own index of books.
 */

function doGet() {
  return ContentService.createTextOutput("Sefaria Commentary GAS endpoint is running.");
}

function doPost(e) {
  var result;
  try {
    var payload = JSON.parse(e.postData.contents);
    switch (payload.action) {
      case "ping":
        result = { ok: true };
        break;
      case "sync":
        result = handleSync(payload);
        break;
      case "export":
        result = handleExport(payload);
        break;
      case "deleteBook":
        result = handleDelete(payload);
        break;
      case "getBookList":
        result = handleGetBookList();
        break;
      case "setBookList":
        result = handleSetBookList(payload);
        break;
      default:
        throw new Error("Unknown action: " + payload.action);
    }
  } catch (err) {
    result = { error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function getOrCreateSheet(book) {
  var ss;
  if (book.sheetId) {
    ss = SpreadsheetApp.openById(book.sheetId);
  } else {
    ss = SpreadsheetApp.create("Sefaria Commentary - " + (book.heTitle || book.title));
    var sheet = ss.getSheets()[0];
    sheet.setName("Commentary");
    sheet.appendRow(["Ref", "Title", "Comment", "Updated At"]);
    sheet.getRange(1, 1, 1, 4).setFontWeight("bold");
  }
  return ss;
}

function getOrCreateDoc(book) {
  if (book.docId) {
    return DocumentApp.openById(book.docId);
  }
  return DocumentApp.create((book.heTitle || book.title) + " - פרשנות");
}

function sefariaUrl(ref) {
  return "https://www.sefaria.org/" + String(ref || "").replace(/ /g, "_");
}

/** Appends a paragraph and right-aligns it (RTL content, LTR-default Docs). */
function appendRightParagraph(body, text) {
  var p = body.appendParagraph(text);
  p.setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
  return p;
}

/** Appends a right-aligned paragraph whose text is a clickable link to Sefaria. */
function appendSefariaLink(body, ref) {
  var p = appendRightParagraph(body, ref);
  p.editAsText().setLinkUrl(0, ref.length - 1, sefariaUrl(ref)).setUnderline(true).setForegroundColor("#1155cc");
  return p;
}

/** Sheet always mirrors the full current commentary set for the book. */
function handleSync(payload) {
  var book = payload.book;
  var entries = payload.entries || [];
  var ss = getOrCreateSheet(book);
  var sheet = ss.getSheetByName("Commentary") || ss.getSheets()[0];

  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  }
  entries.forEach(function (entry, i) {
    sheet
      .getRange(i + 2, 1, 1, 4)
      .setValues([[entry.ref, entry.title || "", entry.text || "", new Date(entry.updatedAt).toISOString()]]);
  });

  return { sheetId: ss.getId(), sheetUrl: ss.getUrl() };
}

/**
 * Writes original text + comments into the Doc.
 * mode "update": appends only the entries the client says are new/changed.
 * mode "replace": inserts a dated divider (old content is kept, never
 * erased, so history is preserved) and appends a fresh full copy after it.
 */
function handleExport(payload) {
  var book = payload.book;
  var mode = payload.mode;
  var entries = payload.entries || [];
  var ss = getOrCreateSheet(book);
  var doc = getOrCreateDoc(book);
  var body = doc.getBody();

  if (mode === "replace" && body.getText().trim() !== "") {
    body.appendPageBreak();
    appendRightParagraph(body, "--- גרסה חדשה מתאריך " + new Date().toLocaleString() + " ---").setHeading(
      DocumentApp.ParagraphHeading.HEADING2
    );
  } else if (body.getText().trim() === "") {
    appendRightParagraph(body, (book.heTitle || book.title) + " - פרשנות").setHeading(
      DocumentApp.ParagraphHeading.TITLE
    );
  }

  entries.forEach(function (entry) {
    // Title on top (optional section heading), then the source text, then a
    // link back to Sefaria instead of a plain ref prefix, then the comment
    // at the bottom.
    if (entry.title) {
      appendRightParagraph(body, entry.title).setBold(true).setHeading(DocumentApp.ParagraphHeading.HEADING4);
    }
    if (entry.heText) {
      appendRightParagraph(body, entry.heText);
    }
    if (entry.ref) {
      appendSefariaLink(body, entry.ref);
    }
    if (entry.text) {
      appendRightParagraph(body, entry.text);
    }
    appendRightParagraph(body, "");
  });
  doc.saveAndClose();

  return {
    sheetId: ss.getId(),
    sheetUrl: ss.getUrl(),
    docId: doc.getId(),
    docUrl: doc.getUrl(),
  };
}

var BOOK_LIST_FILE_NAME = "Sefaria Commentary - Book List";

// A single JSON file in Drive holding the book list (titles, refs, reading
// position, linked sheet/doc ids) so it can sync across devices. Commentary
// text itself is never sent here - only through explicit sync/export.
function getBookListFile() {
  var files = DriveApp.getFilesByName(BOOK_LIST_FILE_NAME);
  if (files.hasNext()) return files.next();
  return DriveApp.createFile(
    BOOK_LIST_FILE_NAME,
    JSON.stringify({ books: [], deletedBookIds: {} }),
    MimeType.PLAIN_TEXT
  );
}

function handleGetBookList() {
  var file = getBookListFile();
  try {
    var data = JSON.parse(file.getBlob().getDataAsString());
    return { books: data.books || [], deletedBookIds: data.deletedBookIds || {} };
  } catch (e) {
    return { books: [], deletedBookIds: {} };
  }
}

function handleSetBookList(payload) {
  var file = getBookListFile();
  file.setContent(
    JSON.stringify({
      books: payload.books || [],
      deletedBookIds: payload.deletedBookIds || {},
    })
  );
  return { ok: true };
}

function handleDelete(payload) {
  var book = payload.book || {};
  if (book.sheetId) {
    try {
      DriveApp.getFileById(book.sheetId).setTrashed(true);
    } catch (e) {}
  }
  if (book.docId) {
    try {
      DriveApp.getFileById(book.docId).setTrashed(true);
    } catch (e) {}
  }
  return { ok: true };
}
