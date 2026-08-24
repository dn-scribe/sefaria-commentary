# Sefaria Commentary

A private commentary writing tool integrated with Sefaria, Google Sheets, and Google Docs.

## Features

- 📖 Write commentary on books published at Sefaria
- 🔒 Local storage with passphrase protection
- 📱 Works offline (data not synced across devices)
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
- User can access from multiple devices (local storage is not synced!)

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

To enable Google Docs/Sheets export:

1. Create a Google Apps Script project
2. Deploy as a web app
3. Copy the deployment URL into the app settings
4. Grant necessary permissions to access your Drive

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
