# Sefaria Commentary

A private commentary writing tool integrated with Sefaria, Google Sheets, and Google Docs.

## Features

- 📖 Write commentary on books published at Sefaria
- 🔒 Local storage with passphrase protection - commentary text stays on-device, encrypted
- 📱 Works offline; commentary itself is not synced across devices
- 🔄 Book list and reading position sync across devices (optional, via Google)
- 📄 Export to Google Docs
- 🌐 Full RTL support for Hebrew
- 📚 Manage multiple books

## About

Goal: Lean app (html5 or similar), hosted on Github Pages, and integrated with google docs and sheets.

Function: Enable writing a private commentary to a book that is published at Sefaria
- Native - Hebrew, full RTL.

Usage:
**1st use:**
1. select the book from Sefaria, connect to Google Sheet and Google Doc, Verify connections and local storage.
2. The app will provide guidance in setting up (step by step).

**N use:**
open the app see the book list, choose a book to get to the last paragraph learned, move to the next one and add commentary that is saved (as db to google sheet)

**Commentary:** 
- Give titles to sections
- Write a comment to a section
- A comment may include a link and should be, later on - exported to google docs, clickable
- Allow opening a new tab - of the book in Sefaria in Chrome (not the app!)
- Allow CRUD to sections already edited
- All operations require the user to press (e.g. save)

**Export to Google Doc:** 
- Doc per book
- Export the original book + comments
- Default to update only - add new paragraphs and their commentary
- Allow replacing the google doc and exporting a fresh version - in this case mark the version in google docs before erasing everything so history is preserved

**Book list:** 
- Add a book
- Open (in my app)
- Delete (from my list and my docs)

**Multiple access:**
- User can access from multiple devices
- If Google Apps Script is connected (see Setup below), the book list - titles, chosen scopes, and the reading position per book - syncs across devices through a file in your Drive, so opening the app on a different device shows the same books and resumes each one where you left off
- Without that connection, or before it's ever synced, each device's book list stays local to it
- Commentary text is never included in the book-list sync file itself, but it does round-trip through Google when connected: every save pushes it to that book's Sheet, and opening a book pulls its Sheet back down and merges anything written elsewhere (last-write-wins per entry) - so commentary written on your phone shows up when you open the same book on desktop, and vice versa
- Without a Google connection, commentary stays purely local to each device

## Setup

### 1. Enable GitHub Pages

1. Go to repository settings → Pages
2. Select `main` branch → `docs/` folder
3. Save and wait for deployment

Your app will be available at: `https://dn-scribe.github.io/sefaria-commentary/`

### 2. First Use

1. Open the app
2. Create a passphrase (stored locally)
3. Add a book from Sefaria
4. Start writing commentary

### 3. Google Apps Script Integration (Optional)

This is a one-time, global setup — you do **not** create or connect a
Sheet/Doc per book. Each book automatically gets its own Google Sheet
(synced as its commentary database) and its own Google Doc (for the
exported, readable version) the first time you save or export commentary
for it. You never paste a spreadsheet or document ID anywhere.

To enable it:

1. Go to [script.google.com](https://script.google.com/) → New project
2. Delete the placeholder code and paste in the full contents of [`gas/Code.gs`](gas/Code.gs)
3. Click **Deploy → New deployment**, select type **Web app**
4. Set "Execute as": **Me**, "Who has access": **Anyone** (this does *not* make your data public - the code still only ever runs as you, and the deployment URL is an unguessable secret token that only you have; "Only myself" would instead reject every request, since a browser `fetch()` has no way to prove it's you)
5. Google will show a one-time authorization prompt (access to your Sheets/Docs/Drive) — click through it. This does not require creating anything in Google Cloud Console; it's the standard Apps Script consent screen.
6. Copy the resulting Web App URL (ends in `/exec`)
7. In the app, open **Settings** (⚙️), paste the URL into "Google Apps Script URL", click **שמירה** (Save), then **בדיקת חיבור** (Test Connection) to confirm it responds

From then on:
- Every commentary save silently syncs that book's row into its own Sheet (created automatically on first sync)
- The **ייצוא ל-Google Docs** buttons on a book's reader screen create/update that book's Doc — "עדכון" appends only new/changed commentary, "ייצוא גרסה מלאה חדשה" appends a dated divider and a fresh full copy (older content is kept, never erased)
- Once created, links to open the book's Sheet and Doc appear on its reader screen
- Deleting a book from the app also trashes its linked Sheet and Doc in Drive

## Project Structure

```
docs/
├── index.html       # Main HTML file
├── css/
│   └── style.css    # RTL-enabled styles
└── js/
    ├── storage.js   # Local storage management
    ├── auth.js      # Passphrase authentication
    ├── api.js       # Sefaria API & Google Apps Script integration
    ├── ui.js        # UI rendering
    └── app.js       # Main app controller
```

## Data Storage

All data is stored locally in your browser:

- **Passphrase hash** - One-way hash for authentication
- **Books** - List of books you're commenting on
- **Commentary** - Commentary entries per book

## Privacy

- No data is sent to any server by default
- Data remains in your browser's local storage
- Optional: Export to your personal Google Docs/Sheets

## Development

To run locally:

```bash
# No build step needed - just open docs/index.html in a browser
# Or use a local server:
python3 -m http.server 8000
# Then visit http://localhost:8000/docs/
```

## License

MIT License - See LICENSE file
