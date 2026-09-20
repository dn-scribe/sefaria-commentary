# AGENTS.md

Instructions for AI coding agents working in this repository (Sefaria
Commentary). This file and [CLAUDE.md](CLAUDE.md) are kept in sync -
if you edit one, update the other the same way.

## Stack & structure

- Static site, no build step: plain `<script>` tags under `docs/js/`, using
  a `window.SC` namespace (`SC.Auth`, `SC.Storage`, `SC.Api`, `SC.UI`,
  `SC.App`, `SC.CustomBook`). Served via GitHub Pages from `docs/`.
- `gas/Code.gs` is a separate Google Apps Script backend (Sheets/Docs/Drive
  sync), deployed independently as a Web App - see `gas/README.md`.

## Critical: changes to gas/Code.gs need developer approval first

`gas/Code.gs` is a live, deployed Google Apps Script Web App, not just a
file in this repo. Unlike everything else here, a change to it can't be
verified end-to-end by an agent - it requires the developer's own Google
account, an actual redeploy, and testing from a real device.

**Before writing any change to `gas/Code.gs`, or designing a feature whose
only implementation touches it, stop and ask the developer for explicit
approval first** - even if the request doesn't mention Apps Script, and even
if editing it looks like the obvious or most direct approach. Prefer a
client-only implementation when one exists (most of this app's Sefaria/text
features do - the Apps Script side only handles Sheets/Docs/Drive sync and
export); explain briefly why a gas change would be needed before touching it.

Merging to `gas/**` also triggers `.github/workflows/deploy-gas.yml`, which
auto-redeploys the live Apps Script - another reason a gas change is never
routine, and always worth calling out explicitly (and confirming when it
did *not* happen) in any summary of a change.

## Workflow expectations

- Verify UI/behavior changes live in a browser (e.g. a local
  `python3 -m http.server` against `docs/`) before calling a task done -
  don't rely on reading the code alone.
- One PR per feature/fix, via `gh pr create` / `gh pr merge`.
- State plainly, after each change, whether `gas/**` was touched and
  therefore whether the deploy-gas workflow will fire.
