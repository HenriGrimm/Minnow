---
id: browser-allowlist
kind: tool-usage
label: Browser navigation allowlist
version: 1
part: tool-usage
description: Built-in browser_navigate origin allowlist and ask_question consent flow.
---

## Browser navigation allowlist

`browser_navigate` only opens URLs that match **allowed origin patterns** in Settings (localhost dev hosts by default). External sites are blocked until the user approves.

### Choose and target the browser surface

Use the isolated Agent Browser (`surface: "agent"`) by default for agent work. Call **`browser_reserve_tab` first**, keep its returned `tab_id`, and pass that exact id to every later browser call. Agent `browser_list` returns only tabs owned by the current run. Release or close the tab when the work is complete; never guess an id or act on another owner's tab.

Use the visible preview only deliberately with `surface: "user"`. Call `browser_list` to choose an existing preview tab or `browser_new_tab` to create one, then pass its explicit `tab_id` to every later call. A user-surface tab is visible to the user; do not navigate or close one unless the task selected it.

### When the origin is already allowed

If the URL’s origin is already on the allowlist (Settings → Tools → Browser navigation allowlist), call **`browser_navigate` directly** with the selected surface and explicit `tab_id`. Do **not** call **`ask_question`** or **`request_browser_origin_access`** first.

### Before navigating to a new external origin

Only when the origin is **not** already allowlisted (or `browser_navigate` returns an allowlist error):

1. Call **`ask_question`** (structured cards — do not ask only in prose).
2. If the user chooses **Allow once** or **Add to allowlist**, call **`request_browser_origin_access`** with the same URL and matching **`decision`** (`once` or `persist`).
3. Then call **`browser_navigate`** with the same explicit `surface` and `tab_id`.

Use exactly these option ids so the host can apply the choice:

```json
{
  "title": "Browser navigation",
  "questions": [
    {
      "id": "browser_allow_origin",
      "prompt": "Allow browser navigation to https://example.com?",
      "options": [
        {
          "id": "once",
          "label": "Allow once",
          "description": "Open this URL one time only"
        },
        {
          "id": "persist",
          "label": "Add to allowlist",
          "description": "Save this origin for future sessions (Settings → Tools)"
        },
        {
          "id": "deny",
          "label": "Do not allow",
          "description": "Skip navigation"
        }
      ]
    }
  ]
}
```

- On **`deny`** or **`cancelled`**, do **not** call `browser_navigate` or `request_browser_origin_access`.
- On **`once`** / **`persist`**, pass the same ids to **`request_browser_origin_access`**: `{ "url": "https://example.com", "decision": "once" }` or `"persist"`.
- Do **not** add an "Other" option — the UI adds it.
- An unattended Agent Browser run cannot approve a blocked origin by itself; wait for the user's approval path instead of inventing a grant.

### If navigation was already blocked

When `browser_navigate` or `request_browser_origin_access` returns an allowlist error, run the same **`ask_question`** flow (or call **`request_browser_origin_access`** without `decision` — the client will show the same question cards).

### Notes

- Prefer **`ask_question`** over long chat paragraphs for this decision.
- On the Agent Browser, **every** tab command (`browser_eval`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_screenshot`) requires the tab's current page to be allowlisted (or `about:blank` / Chrome's error page). If a command fails with `page left the browser allowlist`, `browser_navigate` back to an allowed URL; do not retry on `surface: "user"`.
- A failed load (e.g. dev server not running) leaves the tab on Chrome's error page; `browser_snapshot` there shows the network error, and `browser_navigate` still works.
- Users can edit patterns anytime under **Settings → Tools → Browser navigation allowlist** (one origin glob per line, e.g. `https://example.com` or `http://localhost:*`).
