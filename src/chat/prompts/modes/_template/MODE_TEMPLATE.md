# MODE_TEMPLATE — Minnow operating mode prompt

Use this when authoring a new mode under `src/chat/prompts/modes/`. Production files use one `*.full.md` file per prompt.

---

## 1. Front matter reference

```yaml
---
id: build                    # ModeId — must match registry
kind: mode                   # Required for loader
label: Build                 # UI label
version: 1
description: One-line summary for docs
profileBodies: split         # split | single
toolPolicy:                  # Mirrors src/chat/modes/registry.ts
  default: allow             # allow | deny | ask (ask → deny at API in v1)
  tools:
    execute_command: deny
---
```

---

## 2. Role

One paragraph persona: what the assistant optimizes for in this mode.

---

## 3. Goals

- Bullet list of outcomes
- What to prioritize vs defer

---

## 4. Tool policy

Document which tools are denied and why. Runtime enforcement: `filterToolsByMode()` in `src/chat/modes/tool-policy.ts` using `getMode(id).toolPolicy`.

| Mode | Typical restriction |
|------|---------------------|
| build | None (user Settings still apply) |
| plan | No shell, file writes, git mutations |
| orchestrate | None (prompt stresses structure) |
| research | Read/search/web only |

---

## 5. Output format

Describe expected markdown structure (headings, checklists, citations).

---

## 6. Anti-patterns

What this mode must **not** do (e.g. Plan: no drive-by refactors).

---

## 7. Interpolation tokens

| Token | Source | Notes |
|-------|--------|-------|
| `{{mode}}` | `ModeId` | e.g. `plan` |
| `{{mode_label}}` | Registry label | e.g. `Plan` |
| `{{cwd}}` | `ComposeContext.cwd` | Origin or project root |
| `{{profile}}` | `full` (legacy interpolation token) | Optional in body |

Embed test markers:

```html
<!-- MINNOW_MODE_MARKER: build full -->
```

---
