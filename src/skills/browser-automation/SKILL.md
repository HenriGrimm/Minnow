---
name: browser-automation
description: >-
  Drive Minnow's visible preview or isolated Agent Browser for login flows, SPAs, and screenshots.
  Use when fetch tools are insufficient or the user mentions browser automation.
disable-model-invocation: true
---

# Browser automation (preview and Agent Browser)

Use **`browser_*` tools** for authenticated pages, dynamic JS, visual verification, or UI testing. There are two surfaces:

- `surface: "agent"` is the default isolated Agent Browser. It runs a headless installed Chrome, Edge, Brave, or Chromium session through the local server.
- `surface: "user"` targets a visible Chromium preview tab in the Minnow desktop shell.

Keep these surfaces separate. Agent Browser ownership is enforced by the run identity; never guess or reuse another owner's tab id.

## When to use preview browser vs fetch tools

| Need | Tool |
|------|------|
| Public HTML, no login | `fetch_web_content` (browser executor) |
| Login, SPA, CORS-blocked, isolated run | Agent `browser_reserve_tab` → `browser_navigate` + `browser_snapshot` |
| Deliberate visible preview work | User `browser_list` / `browser_new_tab`, then explicit `tab_id` |
| Visual proof | `browser_screenshot` (Agent Browser screenshots work with the viewer closed) |

## Workflow

1. For an isolated run, call **`browser_reserve_tab`** first. Keep the returned `tab_id`; pass it explicitly to every later Agent Browser call. Use `browser_new_tab` for another private tab.
2. Use **`browser_list`** with `surface: "agent"` to see only your owned tabs. `browser_switch_tab` validates an Agent tab but does not change the viewer.
3. For visible work, call `browser_list` with `surface: "user"` or deliberately call `browser_new_tab` with `surface: "user"`; use the returned/listed `tab_id` on every later action. Do not manipulate tabs owned by another agent or an unselected user tab.
4. For **new external origins**, call **`ask_question`** first (options `once`, `persist`, `deny`), then **`request_browser_origin_access`** with `{ url, decision: "once"|"persist" }`, then retry `browser_navigate`. Unattended Agent Browser runs cannot grant their own blocked origin.
5. `browser_snapshot` — get `[uid]` markers for elements. Refresh after navigation or interaction before using a uid.
6. `browser_click` / `browser_fill` — act on uids from the latest snapshot.
7. `browser_screenshot` — PNG appears inline in chat; it does not require the Agent Browser viewer to be open.
8. Finish with `browser_release_tab` to leave a private tab for user inspection or reassignment, or `browser_close_tab` to close it and release resources. Popup/page targets in Agent Browser are closed, so work in the reserved page.

The Agent Browser viewer is opened with the browser sidebar button. It offers **Watch**, **Guide**, and **Take control** for a selected tab, plus assign/unassign, close-tab, and clear-tabs controls. Closing the viewer leaves the browser service running; quitting Minnow shuts it down. Agent sessions are disposable, are not restored on the next session, and allow up to 8 tabs per service. Minnow does not download a browser; install one or set `MINNOW_BROWSER_PATH`.

Enable browser automation and allowlisted origins under **Settings → Tools → Built-in browser automation**.
