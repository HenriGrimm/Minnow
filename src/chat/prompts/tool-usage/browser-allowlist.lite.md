---
id: browser-allowlist
kind: tool-usage
label: Browser allowlist (lite)
version: 1
part: tool-usage
---

**Browser workflow:** Use `surface: "agent"` by default: first call **`browser_reserve_tab`**, retain the returned `tab_id`, and pass it explicitly to every later call. `browser_list` on that surface shows only your owned tabs. Use `surface: "user"` only deliberately after `browser_list` or `browser_new_tab`, and pass the selected `tab_id` on every call; do not touch another owner's tab. Release or close the agent tab when finished. For an allowlisted origin, call **`browser_navigate` directly** (no `ask_question`). For a new external origin: **`ask_question`** (`once` / `persist` / `deny`), then **`request_browser_origin_access`** `{ url, decision }`, then navigate. On deny/cancelled, do not navigate. Allowlist errors → same flow. Agent `browser_screenshot` works even when the Agent Browser viewer is closed.
