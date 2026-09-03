# Auto-deploying `Code.gs` via GitHub Actions (optional)

By default, updating `Code.gs` means manually pasting it into the Apps
Script editor and creating a new deployment version - see the main
[README](../README.md#3-google-apps-script-integration-optional) for that
path, or use the in-app "📋 העתקת קוד ללוח" button in Settings.

The workflow at
[`.github/workflows/deploy-gas.yml`](../.github/workflows/deploy-gas.yml)
automates that: it runs [`clasp`](https://github.com/google/clasp) (Google's
official CLI) whenever `gas/**` changes on `main`, pushing the new code and
republishing your existing deployment - same `/exec` URL, new code, no
manual copy-paste. It's a separate workflow from anything else in this repo
and only ever triggers on `gas/` changes, so it can't interfere with
GitHub Pages (which doesn't use Actions at all here) or any other workflow.

## One-time setup (do this once, on your own machine)

1. **Enable the Apps Script API** for your account at
   [script.google.com/home/usersettings](https://script.google.com/home/usersettings)
   (off by default - clasp fails without it).

2. **Install and log in to clasp:**
   ```bash
   npm install -g @google/clasp
   clasp login
   ```
   This opens a browser OAuth flow and writes `~/.clasprc.json`.

3. **Link this folder to your existing Apps Script project.** Find your
   Script ID in the Apps Script editor → Project Settings → "Script ID",
   then from the repo root:
   ```bash
   cd gas
   clasp clone <YOUR_SCRIPT_ID>
   ```
   This pulls the project's current `appsscript.json` manifest down into
   `gas/` and writes `gas/.clasp.json` (just the script id - not secret).
   `clasp clone` also pulls the current `Code.gs` from the server; diff it
   against what's already in this folder before committing, in case they've
   drifted.

   Commit both `.clasp.json` and `appsscript.json`:
   ```bash
   git add .clasp.json appsscript.json
   git commit -m "Link gas/ to Apps Script project"
   ```

4. **Find your deployment ID.** In the Apps Script editor: Deploy → Manage
   deployments → the ID next to your active web app deployment (also visible
   in its URL). Add it as a **repo variable** (not a secret - it's not
   sensitive) at Settings → Secrets and variables → Actions → Variables:
   - Name: `CLASP_DEPLOYMENT_ID`
   - Value: that deployment id

5. **Add your clasp credentials as a repo secret.** The contents of the
   `~/.clasprc.json` written in step 2 - this one genuinely is sensitive,
   it's a live OAuth refresh token:
   ```bash
   cat ~/.clasprc.json
   ```
   Copy the full output into a new secret at Settings → Secrets and
   variables → Actions → Secrets:
   - Name: `CLASP_CREDENTIALS`
   - Value: the full JSON

That's it - the next push touching `gas/**` on `main` will push and
redeploy automatically. Trigger it manually anytime from the Actions tab
("Run workflow") without needing a `gas/` change, e.g. after fixing
credentials.
