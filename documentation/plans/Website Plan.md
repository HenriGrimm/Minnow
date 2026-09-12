# minnow.sh — website design & build plan

## Context

Minnow (`HenriGrimm/Minnow`, v0.1.3, AGPL-3.0-or-later) currently has no website. Its front door is a
GitHub README. The README is good — genuinely well written — but it cannot do what a site does: show the
product moving, hold the documentation in a readable shell, give people a download button that knows
their platform, or make the first ten seconds feel like the app feels.

This plan specifies a complete marketing + docs website in a **separate repository**, built to look and
feel like the app itself: same `--mn-*` tokens, same type rules, same motion vocabulary, same voice.
Everything a builder needs is in this document — it does not assume access to the Minnow repo while
writing code, only while running the content-sync script.

**Decisions locked with the user:**

| Decision | Choice |
|---|---|
| Domain | **minnow.sh** |
| Stack | **Astro 5 + Tailwind v4** (static output) |
| Scope v1 | **Home, Download, Docs, Changelog** (+ privacy, 404, feeds) |
| Docs strategy | **Sync script** pulls `documentation/` from the Minnow repo at build time |
| Theme | **`human-dark` default**, light toggle, all 16 families shipped and live-switchable |
| Motion | **Apple-style: motion reveals the product.** No decorative motion. |

---

## 1. Brand facts (verified from the repo — use these, not memory)

### 1.1 Positioning

- Tagline: **"A full agentic development workspace. Open source, and completely yours."**
- Lockup subtitle (in `minnow-lockup-horizontal.svg`): **"Tiny by design."**
- Thesis: *"Minnow exists because the tools are good but the seams between them were not."*
- Audience: **the solo developer and the hobbyist.** Explicitly **not** teams, orgs, or enterprise.
  Single-player is a design decision, not a gap.
- Reference point: **Blender**, not a SaaS product.
- Repo: `https://github.com/HenriGrimm/Minnow` · Discord: `https://discord.gg/U4FPzv9K4X` ·
  Sponsor: `https://github.com/sponsors/HenriGrimm` · Author: Henri Grimm `<henri@grimmedia.org>`

### 1.2 Voice rules (from `PRODUCT.md` — these are binding)

- Plain and unhurried. State what a thing does and stop.
- **No exclamation marks.** No hype ("autonomous AGI"). No growth-marketing cadence.
- Write like project documentation, not a landing page: short declaratives, real nouns, second person.
- "Free and open source" is said **once**, plainly. It is the premise, not a badge.
- Privacy is stated plainly, never fear-marketed.
- Naming competitors is **allowed on the site** (`PRODUCT.md` names the site as a positioning surface) —
  but only the seven sanctioned rows in §1.4, never disparaging, and always paired with what the
  integration buys.
- **Claims discipline:** everything describes what ships today. Nothing in the future tense.

### 1.3 Shipped surfaces (verified against `src/os/app-registry.ts`)

App rail: **Code, Source Control, Models, Brain, Issues, Scheduler** (+ Settings in the menubar).
**Orchestrator boards live inside Code**, not on the rail. Terminal, Browser preview and Dev servers are
surfaces inside Code.

> **Do not put these on the site.** They exist in the codebase but are release-gated:
> **Research** (marked broken in code), **Experts**, **Benchmarking**, **Compare**, **Super Plan** mode.
> Also **do not claim**: an Email app, a Studio app, or agent-CLI providers (claude/codex/cursor) —
> none exist. `documentation/images/app-research.png` must not be used.

### 1.4 The sanctioned replacement table (nothing outside this may be claimed)

| Instead of | You get | Honest because |
|---|---|---|
| Cursor, or VS Code plus a chat extension | **Code** | LSP, inline completion, Quick Edit, terminal, dev servers, Chromium preview, chat over the same repo |
| Linear, Jira (single-player) | **Issues** | List, board, triage, saved views, `issue_*` tools the agent files to itself |
| GitHub Desktop, Tower | **Source Control Center** | Changes, history, branches, stashes, worktrees, PRs and CI via your own `gh` |
| LM Studio | **Models** | Hardware-fit scoring, HF downloads, `llama-server` serving, providers, per-role routing, usage and cost |
| Notion or Obsidian, for project notes | **Brain** | Markdown wiki, semantic recall, code index, memories, agent read/write |
| A drawer of shell scripts and cron | **Scheduler**, `/loop`, `/goal` | Recurring agent jobs with run history, scoped to the workspace |
| A hand-rolled CI or agent-runner pipeline | **Orchestrator boards** | Plan → waves of Builder/Tester agents in isolated worktrees → merge |

### 1.5 Numbers that are true and checkable

| Claim | Value | Source |
|---|---|---|
| Built-in tools | **105** | `server/tools/builtin-catalog.js` |
| Themes | **16** (8 families × light/dark) | `src/styles/tokens.css` |
| Built-in skills | **19** | `src/skills/builtin-manifest.json` |
| Work agent roles | **12** | agents docs |
| Sub-agent types | **8** | agents docs |
| Composer modes | **4** (General, Build, Plan, Debug) | `src/chat/modes/registry.ts` |
| Cloud provider presets | **9** | `src/providers/presets.ts` |
| Local provider presets | **2** (LM Studio, Ollama) | `src/providers/presets.ts` |
| Language servers | **8 on by default, 6 more available** | integrations docs |
| Startup budget | **appReady ≤ 2500 ms**, CI-enforced | `budgets.json` |
| Accessibility | **WCAG 2.1 AA across all 16 themes**, CI-tested | `test/theme-contrast.test.mts` |
| Platforms | Windows NSIS · macOS dmg/zip · Linux AppImage | electron-builder config |

Providers to name (exact, in registry order): OpenRouter, OpenAI, Groq, Mistral, OpenCode Zen,
OpenCode Go, Anthropic, DeepSeek, GitHub Copilot; local: LM Studio, Ollama; runtimes: llama.cpp, MLX.

### 1.6 Liftable lines (already written, already in voice)

1. "Minnow exists because the tools are good but the seams between them were not."
2. "Plan a feature, let it build in a worktree, watch the tests, review the diff, file what broke, commit, ship — without switching apps or re-explaining your project to anything."
3. "It runs on whatever you point it at."
4. "The point of open source is not that you *could* read the source. It's that the seams are open where you actually want to reach in."
5. "…on the principle that a program able to run shell commands should occasionally check in."
6. "the honest version of 'local-first' is not 'nothing ever leaves' — it is 'nothing leaves unless you sent it somewhere'."
7. "sixteen built in, which is fifteen more than strictly necessary."
8. "There is no telemetry and no phone-home. Nobody here knows you installed it."
9. "No feature is ever withheld to make a paid tier."
10. "One maintainer and a small community. It is a work in progress, meaning parts of it are unfinished and you will find the edges before I do."
11. "You can also just open a repo and start typing."

> **Do not copy README typos:** "intergrated", "availible", "combinded", and the stray fragment
> `| a fully intergrated issue` on README line 29. Rewrite those rows cleanly.

---

## 2. Art direction

### 2.1 The brief, resolved

The five reference sites and "as if Apple made it" pull in compatible directions once you notice that
Apple's actual design language is *restraint plus product-as-hero* — which is exactly what `PRODUCT.md`
already demands. The anti-references (no glassmorphism, no gradient text, no neon HUD, no KPI cards, no
decorative motion) are not obstacles to "modern and cool"; they are the reason it will look expensive.

**North star, scaled up from the app's own:** *Calm local instrument.*

| Reference | What we take |
|---|---|
| **opencode.ai** | Restraint. Mono-labelled sections. Real numbers. FAQ accordion. Install command in the open. |
| **cursor.com** | Declarative sentence headings. Big honest product screenshots of real workflows. Changelog as a first-class page. |
| **claude.com/product/claude-code** | Structured feature grid, terminal demo, honest FAQ, the multi-surface list pattern. |
| **vercel.com** | Precision geometry. Hairline borders. Monospace micro-labels. Tight grid discipline. Logo/tech rows. |
| **supabase.com** | One saturated accent on a dark ground. Code blocks as hero content. Bento feature grids. |
| **Apple** | One idea per screen. Type as hero. Scroll-driven product reveals via `sticky`, never hijacking. Optical alignment. Motion as *arrival*, not decoration. |

### 2.2 Seven rules for this site

1. **One idea per screen.** Every section gets a full viewport of air. No two competing messages.
2. **Type is the hero.** Display at 88px / 600 / `-0.035em` on `--mn-fg`. Never gradient, never outlined, never all-caps at display size.
3. **The product is the photography.** Every section's visual is the app doing something real.
4. **Motion is arrival.** Things settle into place. Nothing loops forever. Nothing moves that is not the subject.
5. **One accent.** `--mn-accent` on primary actions, links, selection, and active state only. It never washes a large background except the primary button and the logo mark.
6. **Metric colours measure.** `--mn-success` / `--mn-warning` / `--mn-danger` appear only where something is actually being measured (hardware fit, test status, token bars). Never navigation, never decoration.
7. **Borders, not shadows.** 1px hairlines at 6% alpha do the separating. Shadows only on things that genuinely float (popovers, the app frame, the sticky nav once scrolled).

### 2.3 Banned (carried from `PRODUCT.md` anti-references)

Glassmorphism · gradient text (`background-clip: text`) · neon/HUD chrome, scanlines, glow dots ·
hero-metric KPI cards with coloured top stripes · coloured `border-left` stripes on cards or alerts ·
purple-gradient "AI startup" palette · looping decorative animation · parallax for its own sake ·
stock photography of people at laptops · fake testimonials (Minnow has no customers to quote).

---

## 3. Design system

### 3.1 Token strategy — the core of "easily switchable"

```
src/styles/
  vendor/tokens.css     # VERBATIM copy of Minnow's src/styles/tokens.css. Never hand-edited.
  tokens.site.css       # site-only additions (display scale, rhythm). Theme-independent.
  theme.css             # @theme inline bridge → Tailwind v4 utilities
  base.css              # reset + base, adapted from Minnow's global.css
  app-frame.css         # styles for the DOM replica of the Minnow shell
```

**Hard rule:** no hex or `rgb()` literal may appear anywhere except `vendor/tokens.css`.
Enforce mechanically with stylelint `color-no-hex` + a custom `declaration-property-value-disallowed-list`
for `rgb(`/`rgba(`/`hsl(` outside the vendor file. This is the same discipline the app enforces and it is
what makes a 16-theme site possible.

`vendor/tokens.css` is refreshed by `npm run sync:minnow`, which applies **one documented patch**:
`human-dark` and `mint-dark` are the only 2 of 16 blocks that omit the four `--mn-syntax-*` tokens.
Append to both:

```css
  --mn-syntax-command: var(--mn-accent);
  --mn-syntax-name: var(--mn-accent);
  --mn-syntax-inline: var(--mn-fg);
  --mn-syntax-link: var(--mn-accent);
```

### 3.2 The Human theme (the site default) — verbatim

```css
:root[data-theme="human-dark"] {
  color-scheme: dark;
  --mn-bg: #0f0f0f;
  --mn-surface-0: #141414;
  --mn-surface-1: #121212;
  --mn-surface-2: #262626;
  --mn-border: rgba(255, 255, 255, 0.06);
  --mn-border-strong: rgba(255, 255, 255, 0.12);
  --mn-fg: #ffdbbd;
  --mn-fg-muted: #a89482;
  --mn-fg-subtle: #4d433b;
  --mn-fg-on-accent: #fbf1ea;
  --mn-accent: #d27428;
  --mn-accent-soft: rgba(210, 116, 40, 0.14);
  --mn-accent-border: rgba(210, 116, 40, 0.28);
  --mn-accent-ink: #e2a573;
  --mn-success: #d27428;          /* Human aliases success→accent, unlike every other family */
  --mn-success-soft: rgba(210, 116, 40, 0.14);
  --mn-success-border: rgba(210, 116, 40, 0.28);
  --mn-success-ink: #e2a573;
  --mn-warning: #d6d300;
  --mn-focus-ring: #d27428;
  --mn-shadow: rgba(43, 43, 43, 0.45);
  --mn-folder: #a8d228;
  --mn-danger: #ff5f42;
  --mn-danger-soft: rgba(255, 95, 66, 0.18);
  --mn-danger-border: rgba(255, 95, 66, 0.35);
  --mn-danger-ink: #ff9784;
  --mn-warning-soft: color-mix(in srgb, var(--mn-warning) 18%, transparent);
  --mn-warning-border: color-mix(in srgb, var(--mn-warning) 32%, transparent);
  --mn-overlay: color-mix(in srgb, var(--mn-bg) 72%, transparent);
  --mn-surface-elevated: color-mix(in srgb, var(--mn-fg) 10%, transparent);
  --mn-selection-bg: color-mix(in srgb, var(--mn-accent) 45%, var(--mn-surface-2));
  /* + the shadow / tool-call / thought / banner / cm-* tail, identical across all 16 themes */
}

:root[data-theme="human-light"] {
  color-scheme: light;
  --mn-bg: #fbf1ea;  --mn-surface-0: #f1e7e1;  --mn-surface-1: #fcf6f1;  --mn-surface-2: #eee5de;
  --mn-border: rgba(46,34,24,0.08);  --mn-border-strong: rgba(46,34,24,0.16);
  --mn-fg: #2e2218;  --mn-fg-muted: #6f6550;  --mn-fg-subtle: #c2b7af;  --mn-fg-on-accent: #f9f0e9;
  --mn-accent: #c46820;  --mn-accent-soft: rgba(196,104,32,0.14);
  --mn-accent-border: rgba(196,104,32,0.28);  --mn-accent-ink: #7f4415;
  --mn-warning: #b8a800;  --mn-focus-ring: #c46820;  --mn-shadow: rgba(0,0,0,0.12);  --mn-folder: #9dc420;
  --mn-danger: #d94428;  --mn-danger-soft: rgba(217,68,40,0.18);
  --mn-danger-border: rgba(217,68,40,0.35);  --mn-danger-ink: #8a2e18;
  --mn-overlay: color-mix(in srgb, var(--mn-bg) 35%, transparent);
  --mn-surface-elevated: color-mix(in srgb, var(--mn-fg) 6%, transparent);
  --mn-selection-bg: color-mix(in srgb, var(--mn-accent) 38%, var(--mn-surface-0));
}
```

**Contrast rule (binding).** `--mn-accent` `#d27428` on `#0f0f0f` is ≈5.4:1 — fine for large text, UI
borders, and filled buttons, **too tight for small body copy**. For inline links and small accent text
use `--mn-accent-ink` `#e2a573` (≈8:1). Bake this into the link styles so it can't be got wrong.

### 3.3 All 16 theme ids

`swamp-dark` (app default) · `swamp-light` · `desert-dark` · `desert-light` · `ocean-dark` ·
`ocean-light` · `coral-dark` · `coral-light` · `mono-dark` · `mono-light` · `matrix-dark` ·
`matrix-light` · **`human-dark` (site default)** · `human-light` · `mint-dark` · `mint-light`

Family names and blurbs, for the switcher UI:

| id | Name | Blurb |
|---|---|---|
| swamp | Swamp | Cool neutrals, muted green accent. Calm and editor-like. |
| desert | Desert | Warm taupe neutrals with an amber accent. Cozy for long sessions. |
| ocean | Ocean | Blue-tinted neutrals with a soft cyan accent. Modern dev-tool feel. |
| coral | Coral | Graphite neutrals with a warm coral accent. Distinct and soft-modern. |
| mono | Mono | Pure grayscale. Proof on newsprint, bench in charcoal. |
| matrix | Matrix | Phosphor green on CRT black. Accent-only green, readable long sessions. |
| human | Human | Near-black ground with burnt orange accent and peach cream text. Warm evening sessions. |
| mint | Mint | Cool charcoal neutrals with mint phosphor accent and icy cyan highlights. |

### 3.4 Global tokens carried from the app (put in `vendor/tokens.css`, unchanged)

```css
--radius-sm: 6px;  --radius-md: 10px;  --radius-lg: 14px;
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--duration-fast: 0.15s;  --duration-normal: 0.22s;  --duration-slow: 0.35s;
--font-ui: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
--font-mono: 'JetBrains Mono', ui-monospace, monospace;
--topbar-h: 52px;  --sidebar-w: 300px;  --sidebar-rail: 48px;  --touch-min: 44px;
```

### 3.5 Site-only tokens (`tokens.site.css`, `:root`, theme-independent)

```css
:root {
  /* Display scale — extends the app's 11/13/14/15px chrome scale upward.
     Chrome stays at app sizes inside .app-frame; prose on the web is 16px. */
  --fs-display: clamp(2.75rem, 1.55rem + 5.3vw, 5.5rem);    /*  44 → 88 */
  --fs-h1:      clamp(2.25rem, 1.40rem + 3.7vw, 4rem);      /*  36 → 64 */
  --fs-h2:      clamp(1.75rem, 1.22rem + 2.3vw, 2.75rem);   /*  28 → 44 */
  --fs-h3:      clamp(1.25rem, 1.06rem + 0.8vw, 1.625rem);  /*  20 → 26 */
  --fs-lead:    clamp(1.0625rem, 1rem + 0.4vw, 1.25rem);    /*  17 → 20 */
  --fs-body:    1rem;
  --fs-small:   0.875rem;
  --fs-label:   0.6875rem;   /* 11px — the app's label step */
  --fs-mono-sm: 0.8125rem;   /* 13px — the app's mono step */

  --tracking-display: -0.035em;
  --tracking-title:   -0.02em;   /* identical to the app */
  --tracking-label:    0.06em;   /* identical to the app */
  --lh-display: 1.04;  --lh-title: 1.12;  --lh-body: 1.6;

  --section-y:    clamp(5rem, 3rem + 8vw, 10rem);
  --section-y-lg: clamp(7rem, 4rem + 12vw, 14rem);
  --gutter:       clamp(1.25rem, 0.75rem + 2vw, 2.5rem);
  --container:        1200px;
  --container-wide:   1440px;
  --container-narrow:  760px;
  --prose: 72ch;                 /* the app's 72ch rule, kept */

  --radius-xl: 20px;  --radius-2xl: 28px;   /* marketing surfaces only */

  --duration-slower: 0.6s;
  --ease-settle: cubic-bezier(0.22, 1, 0.36, 1);  /* already the 2nd-most-used easing in the app */
  --ease-os:     cubic-bezier(0.2, 0.7, 0.2, 1);
}
```

### 3.6 Typography

- **Prose / headings:** `var(--font-ui)` — the system stack. On macOS this resolves to SF Pro, on
  Windows to Segoe UI; the site therefore renders in the same face the app does on that machine. That
  parity is the point, and it costs zero webfont bytes.
- **Everything instrumental:** `var(--font-mono)` — JetBrains Mono, loaded from Google Fonts CSS2 the
  same way the app loads it, weights `400;500;600`, `display=swap`, with `preconnect` to
  `fonts.googleapis.com` and `fonts.gstatic.com`. Used for: section eyebrows, metrics, code, file paths,
  version chips, terminal blocks, the app-frame's stats.
- **Optional escape hatch:** define `--font-display: var(--font-ui)` in `tokens.site.css` and use it on
  `h1`/`h2` only. If Segoe UI at 88px ever looks weak next to SF Pro, swapping in a self-hosted variable
  Inter is then a one-line change with no other edits.
- Tracking discipline is inherited: titles `-0.02em` (display `-0.035em`), uppercase labels `+0.06em`,
  body `0`. Numerals in any metric get `font-variant-numeric: tabular-nums`.

### 3.7 Base CSS (adapted from `src/styles/global.css`)

Keep verbatim: the `box-sizing` reset, `-webkit-font-smoothing: antialiased`, the `:focus-visible`
outline (`2px solid var(--mn-focus-ring)`, offset 2px), the scrollbar block (`--scrollbar-size: 8px`,
thumb `--mn-border-strong`, `background-clip: padding-box` with a 2px transparent border), the
`::selection { background: var(--mn-selection-bg) }` rule, and the `prefers-reduced-motion` kill block.

Change for the web: **drop** `overflow: hidden` and the `display: flex` on `body` (those are app-shell
rules), set `body { font-size: var(--fs-body); line-height: var(--lh-body) }`, and add
`scroll-behavior: smooth` guarded by reduced-motion.

### 3.8 Tailwind v4 bridge (`theme.css`)

```css
@import "tailwindcss";

@theme inline {
  --color-bg: var(--mn-bg);
  --color-surface-0: var(--mn-surface-0);
  --color-surface-1: var(--mn-surface-1);
  --color-surface-2: var(--mn-surface-2);
  --color-fg: var(--mn-fg);
  --color-fg-muted: var(--mn-fg-muted);
  --color-fg-subtle: var(--mn-fg-subtle);
  --color-on-accent: var(--mn-fg-on-accent);
  --color-accent: var(--mn-accent);
  --color-accent-soft: var(--mn-accent-soft);
  --color-accent-ink: var(--mn-accent-ink);
  --color-success: var(--mn-success);
  --color-warning: var(--mn-warning);
  --color-danger: var(--mn-danger);

  --radius-sm: var(--radius-sm);
  --radius-md: var(--radius-md);
  --radius-lg: var(--radius-lg);
  --radius-xl: var(--radius-xl);

  --font-sans: var(--font-ui);
  --font-mono: var(--font-mono);

  --ease-out: var(--ease-out);
  --ease-settle: var(--ease-settle);
}

@layer base {
  * , *::before, *::after { border-color: var(--mn-border); }
}
```

Utilities then read as the token names — `bg-bg`, `text-fg-muted`, `border-accent`, `rounded-md` —
and every one of them re-resolves when `data-theme` changes, with no Tailwind rebuild and no dark:
variants anywhere. **Never write `dark:` in this project.** The theme blocks already do that job.

### 3.9 Component recipes (ported from the app)

**Primary button** (from `.send-btn` / `.settings-action-btn--primary`):
```css
background: var(--mn-accent); color: var(--mn-fg-on-accent); border: 1px solid var(--mn-accent);
border-radius: var(--radius-md); font-weight: 600;
transition: background var(--duration-fast) var(--ease-out),
            color var(--duration-fast) var(--ease-out),
            box-shadow var(--duration-fast) var(--ease-out);
/* fine-pointer hover — the app's inversion move, not a brightness bump */
@media (hover: hover) and (pointer: fine) {
  &:hover { background: color-mix(in srgb, var(--mn-surface-2) 92%, transparent);
            color: var(--mn-accent); box-shadow: inset 0 0 0 1px var(--mn-accent); }
}
&:active { transform: scale(0.97); }
```

**Ghost button** (from `.settings-action-btn`): `background: var(--mn-bg)`, `1px solid var(--mn-border)`,
`--radius-sm`, hover → `background: color-mix(in srgb, var(--mn-fg) 4%, var(--mn-bg))` and
`border-color: var(--mn-border-strong)`.

**Card / group** (from `.settings-group`): `padding: 16px 18px`, `1px solid var(--mn-border)`,
`--radius-md`, `background: color-mix(in srgb, var(--mn-fg) 1.5%, var(--mn-bg))`. No shadow at rest.

**Row list** (from `.settings-row`): `display:flex; justify-content:space-between; gap:20px;
padding:14px 0; border-bottom:1px solid var(--mn-border)`; first row no top padding, last no border.
Hover veil `color-mix(in srgb, var(--mn-fg) 2%, transparent)`. Use this for "What it replaces" and FAQ.

**Chip / eyebrow**: `font: 600 var(--fs-label)/1.3 var(--font-mono)`, `letter-spacing: var(--tracking-label)`,
uppercase, `color: var(--mn-fg-muted)`, optional `1px solid var(--mn-border-strong)` + `--radius-sm` +
`padding: 3px 8px`.

**Code block**: `background: var(--tool-call-pre-bg)`, `1px solid var(--mn-border)`, `--radius-md`,
`font: 400 var(--fs-mono-sm)/1.5 var(--font-mono)`, `overflow-x: auto`. Syntax colours from the app's
own `--cm-keyword` / `--cm-title` / `--cm-attr` / `--cm-string` and `--mn-syntax-*` so code recolours
with the theme. Use Shiki with a custom theme that emits CSS variables (`shikiConfig.theme` →
`css-variables`), then map them onto the `--cm-*` tokens.

**Tooltip** (from `.mn-os-app-rail__tooltip`): solid `--mn-bg` fill, `1px --mn-border`, `--radius-sm`,
`--shadow-popover-soft`, and the two-layer `::before`/`::after` CSS-triangle arrow trick.

---

## 4. Motion system

### 4.1 Vocabulary

| Token | Value | Used for |
|---|---|---|
| `--duration-fast` | `0.15s` | hover, press, colour |
| `--duration-normal` | `0.22s` | panel reveal, toggle |
| `--duration-slow` | `0.35s` | drawer, section reveal |
| `--duration-slower` | `0.6s` | hero stages, image settle |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | default for everything |
| `--ease-settle` | `cubic-bezier(0.22, 1, 0.36, 1)` | large objects arriving |

Only `opacity`, `transform`, `color`, `background-color`, `border-color`, `box-shadow` and `filter` are
animated. **Never** width, height, top/left, or anything that triggers layout.

### 4.2 The reveal primitive

One `IntersectionObserver` in `src/scripts/motion.ts`, `rootMargin: "0px 0px -12% 0px"`,
`threshold: 0.01`. It adds `.is-in` to `[data-reveal]` and **unobserves immediately** — nothing
re-animates on scroll-up, because re-animation is decoration.

```css
[data-reveal] {
  opacity: 0;
  transform: translateY(var(--reveal-y, 20px)) scale(var(--reveal-s, 1));
  transition: opacity var(--duration-slow) var(--ease-out) var(--reveal-delay, 0s),
              transform var(--duration-slower) var(--ease-settle) var(--reveal-delay, 0s);
}
[data-reveal].is-in { opacity: 1; transform: none; }
```

Stagger by setting `--reveal-delay` inline: `style="--reveal-delay: 60ms"`. Cap any stagger chain at
`400ms` total; longer reads as waiting.

### 4.3 Scroll-scrubbed sections

Use native scroll-driven animations where available and degrade cleanly:

```css
@supports (animation-timeline: view()) {
  .hero-frame { animation: hero-settle linear both; animation-timeline: view(); animation-range: entry 0% cover 30%; }
}
```

JS fallback: **one** rAF-throttled `scroll` listener that writes a `--p` custom property (0→1) on the
pinned sections only. No per-element listeners, no scroll libraries.

**Pinning uses `position: sticky` + a tall spacer. Never intercept the wheel.** Apple does not hijack
scroll and neither do we.

### 4.4 Reduced motion

Three layers, mirroring the app:

1. Global kill in `base.css` (`animation-duration: 0.01ms !important`, same for transitions).
2. `[data-reveal] { opacity: 1; transform: none; }` inside the media query, so content is simply present.
3. Pinned sections collapse to a plain stacked list — the `sticky` and the spacer are removed, the five
   build-loop steps render as five ordinary sections. `motion.ts` early-returns if
   `matchMedia('(prefers-reduced-motion: reduce)').matches`.

Also port the app's hidden-window park (`:root[data-mn-render='idle']`) as a
`document.visibilityState === 'hidden'` pause, so a backgrounded tab burns no compositor time.

### 4.5 No animation library

Everything above is ~120 lines of CSS and ~60 lines of TS. If a spring API is ever wanted, `motion`
(3.8 KB) is the only sanctioned addition. GSAP, Framer Motion, Lenis and AOS are all out — they cost
more than the whole JS budget.

---

## 5. The app-frame replica (the most important build decision)

The hero, the themes section, and several feature sections need the Minnow shell to be **live DOM, not
a screenshot**, because:

- a PNG cannot recolour when the visitor picks one of 16 themes — and the theme switcher is the
  signature interaction;
- a PNG cannot assemble pane-by-pane, which is the whole hero moment;
- `hero.png` is 1.17 MB; the replica is roughly 9 KB of HTML + CSS and crisp at any DPR.

Screenshots are still used — but for the **feature deep-dives**, where full fidelity of a complex screen
(the Brain graph, the Orchestrator board, the Models fit table) matters more than recolouring.

### 5.1 Components

```
src/components/app/
  AppFrame.astro        # outer window: --radius-lg, 1px --mn-border, --shadow-lift, overflow hidden
  WindowChrome.astro    # traffic lights, workspace name, "Code" breadcrumb, Ready dot, model chip
  AppRail.astro         # 48px rail (--sidebar-rail), 7 inline-SVG icons, active pill in --mn-accent-soft
  ChatList.astro        # 300px (--sidebar-w) list: "+ New chat" outlined button, rows with PLA/BUI/GEN
                        # mode badges, mono model id at --mn-fg-subtle, "8 files +73 −79" stat line
  Transcript.astro      # assistant markdown at 14px/1.65, a tool-call row, the file-changes summary
                        # card with Commit / Create PR / Review buttons
  Composer.astro        # mode select, model chip, attach/mic/sparkle inset buttons, 44px send button
  StatusBar.astro       # "Terminal" left, "58.5 t/s" right in mono tabular-nums
```

Everything inside `.app-frame` uses the **app's real sizes** — 14px body, 13px mono, 11px labels, 52px
topbar, 48px rail, 300px sidebar — scaled as a whole with a CSS `zoom`/`scale` wrapper on small
viewports rather than reflowed. It must read as a screenshot of the app, because it effectively is one.

Nice detail to keep: the send button's fish glyph is `transform: rotate(180deg)` in the app. Keep it.

### 5.2 Icons

Do not pull the Flaticon Uicons font for ~24 glyphs. Author `src/components/icons/*.astro` as inline
SVGs (24×24, `stroke="currentColor"`, `stroke-width="1.5"`, rounded caps/joins) matching the app's rail
and chrome icons. Inline SVG also means they inherit `currentColor` and therefore the theme.

### 5.3 Brand marks

Vendor from `public/logos/` via the sync script into `public/brand/`. The canonical glyph path — reuse
it inline wherever the mark appears rather than loading a file:

```
body: M 16 50 C 26 36, 44 32, 56 42 L 69 50 L 56 58 C 44 68, 26 64, 16 50 Z
tail: M 69 50 L 84 40 L 81 50 L 84 60 Z
eye:  circle cx="27" cy="46" r="2.2"
viewBox="0 0 100 100"
```

On the site the glyph is `fill: currentColor` so it takes the theme; the eye dot is `--mn-bg`. The
brand black `#0f0f10` and lockup grey `#6b6b70` are used **only** in the favicon/OG assets, which are
theme-independent.

Favicon set: `public/brand/favicon.ico`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`,
plus an SVG favicon with a `prefers-color-scheme` swap.

---

## 6. Page-by-page specification

### 6.1 Navigation (all pages)

Sticky, `height: 64px`, `background: var(--mn-bg)`, **no border until scrolled** — then a 1px
`--mn-border` bottom edge fades in over 150 ms (single IntersectionObserver on a sentinel div; no
scroll listener).

Left: glyph (28px, `--radius-sm`, `--mn-accent` fill, `--mn-fg-on-accent` glyph) + "Minnow" at
`15px/600/-0.02em`. Centre-left links: Docs · Changelog · Themes (anchor to the home section).
Right: GitHub star count chip (build-time fetched, mono, tabular-nums) · theme control · Discord icon ·
**Download** (primary button).

Theme control is a three-state segmented control matching the app's `.settings-segments`:
**Dark · Light · Auto**. A long-press / click-and-hold, or a caret, opens the 8-family picker.

Mobile (<768px): hamburger → full-screen sheet sliding from the right,
`transform: translateX(100%) → 0` over `--duration-normal` `--ease-out`, scrim at `--mn-overlay`.

### 6.2 Home

**§0 Hero**

- Eyebrow (mono, uppercase, `--fs-label`): `AGPL-3.0-OR-LATER · v0.1.3 · WINDOWS · MACOS · LINUX`
- H1 `--fs-display`: **A full agentic development workspace.**
- Lead `--fs-lead`, `--mn-fg-muted`, max `--container-narrow`:
  *Editor, agents, git, issues, planning, knowledge, and local model hosting — one app, designed from
  the ground up to work with each other.*
- CTAs: **Download for macOS ↓** (primary, label swaps by detected platform) · **Read the docs →**
  (ghost). Under them, small mono: `Windows · macOS · Linux` as direct links, and
  `git clone https://github.com/HenriGrimm/Minnow.git` with a copy button.
- Below: the `AppFrame` replica, full-bleed to `--container-wide`, bleeding slightly off the bottom of
  the fold so it invites scroll.

**Hero animation** (on load, not on scroll — it must be seen immediately):

| t | Stage |
|---|---|
| 0 ms | Frame draws: `opacity 0→1`, `scale 0.98→1`, `translateY(16px)→0`, 600 ms `--ease-settle` |
| 180 ms | Window chrome + traffic lights fade in |
| 260 ms | App rail icons stagger in, 40 ms apart, `translateX(-8px)→0` |
| 420 ms | Chat list rows fade-up, 30 ms apart, cap 8 rows |
| 620 ms | Transcript content fades in |
| 900 ms | Composer slides up 12 px |
| 1150 ms | Caret blinks, then types `Add a dark mode toggle to settings` at ~28 ms/char |
| 2000 ms | A tool-call row streams in with the app's `tool-call-spin` spinner, resolves to a check |
| 2350 ms | The `Edited 8 files +73 −79` summary card slides up 10 px and settles |

Total ≈2.4 s, then **it stops**. It does not loop. Under reduced motion the whole frame renders in its
final state with zero animation.

On scroll, the frame does one Apple settle: `scale(1.04) → 1` and `--radius-2xl → --radius-lg` mapped to
the first 480 px of scroll via `animation-timeline: view()`.

**§1 Runs on** — a quiet strip, `--section-y` padding, hairline top border.
Heading, small: *It runs on whatever you point it at.*
A 4×3 grid of mono wordmarks at `--mn-fg-muted`, hover `--mn-fg`: OpenRouter · OpenAI · Anthropic ·
Groq · Mistral · DeepSeek · GitHub Copilot · OpenCode Zen · OpenCode Go · LM Studio · Ollama ·
llama.cpp · MLX. Text wordmarks, not logos — more instrument, less logo soup, and no trademark risk.
Footnote: *No accounts, no subscriptions, no usage limits, no telemetry.*

**§2 The seams** — the thesis. Centred, `--section-y-lg`, `--container-narrow`.

H2 at `--fs-h1`: *Minnow exists because the tools are good but the seams between them were not.*
Body: the `PRODUCT.md` paragraph, trimmed to three sentences.

Visual — **the seam diagram**, and it is the argument, not decoration: five labelled tiles (Editor ·
Tracker · Git · Models · Notes) sit apart with visible gaps; the gaps carry a faint `--mn-danger-soft`
fill. As the section scrolls through, the tiles slide together, the gaps close to zero, the five
separate 1px borders resolve into **one continuous hairline rectangle**, and the label under it changes
to `one workspace, one tool set`. Scrubbed by `--p`, reversible, `transform` only.

**§3 The build loop** — the signature pinned section.

`position: sticky` viewport with a `500vh` spacer. Left column (sticky): five steps as a list; the
active one gets a filled `--mn-accent` dot and `--mn-fg` text, inactive are `--mn-fg-subtle`.
*(A filled dot, not a coloured `border-left` stripe — stripes are an anti-reference.)*
Right column: the matching screenshot cross-fades with a 12 px y-offset, 300 ms.

1. **idea → Plan mode** — a spec in `documentation/plans/`
2. **Orchestrator board** — Builder and Tester agents in isolated worktrees → `app-orchestrator.png`
3. **Source Control** — review the diff, open the PR, watch CI → `app-source-control.png`
4. **Issues** — what broke, filed by the agent that found it → `app-issues.png`
5. **Brain** — what you learned, still there next month → `app-brain.png`

Immediately after the pin releases, centred, small, `--mn-fg-muted`:
*You can also just open a repo and start typing.*

**§4 What it replaces** — the seven sanctioned rows.

Not a table. A stack of rows on hairline dividers, vercel-style:
left column `Instead of Cursor, or VS Code plus a chat extension` in mono `--mn-fg-muted`; right column
the surface name at `--fs-h3`/600 plus one line of what the integration buys. Hover veil only.
Closing line under the stack: *They share one chat engine, one tool set, one session store, and one
workspace root. What the agent learns in one is available in all of them.*

**§5 App deep-dives** — alternating, one viewport each, image left/right alternating.

Order: **Code → Source Control → Orchestrator → Models → Brain → Issues → Scheduler.**
Each: mono eyebrow · H2 declarative · 2–3 sentences · 3–4 mono "what's in it" chips · screenshot in an
`AppFrame`-style border. Image reveal: `translateY(40px) → 0` + `opacity 0→1`, with the inner image at
`scale(1.04) → 1` so it settles into its frame.

Code gets one extra, inline: a **Quick Edit / Intent** demo — a small code block where a plain-English
comment is typed and then replaced by real code, with a `Tab ⇥` chip. Plays **once** on first view,
then rests. Never loops.

**§6 Local models, cloud models, or both**

H2: *It runs on whatever you point it at.* Three columns:
- **Local** — llama.cpp and MLX built in. Multi-GPU layer split. Hugging Face downloads.
- **Cloud** — nine providers, your own key. Anthropic, OpenAI, OpenRouter, Groq, Mistral, DeepSeek, …
- **Both** — routing binds models to roles; routers pool capacity with slots, priority and failover.

Visual: a **hardware-fit card** — model name, size, quant, a fit bar using `--mn-success` /
`--mn-warning` / `--mn-danger`, and an estimated t/s in mono. This is the one place metric colours
belong, because it is genuinely measuring something. Pull quote:
*the alternative is downloading 40 GB to discover it swaps.*

**§7 Agents and tools**

Bento grid (supabase-flavoured, but flat and bordered rather than glassy):
- **Wide card** — the permission model. 105 tiny mono tiles stagger in, then a handful visibly toggle
  through Full → Ask → Off to show what the control does. Caption: *105 built-in tools. Each one can be
  Full, Ask, or Off, on the principle that a program able to run shell commands should occasionally
  check in.*
- **Sub-agents** — 8 types, with the constraint stated plainly: *no sub-agent can spawn further
  sub-agents.*
- **Modes** — 4 in the composer. *A mode swaps the system prompt and the tool list. Plan mode does not
  merely ask the model to avoid editing your files; the editing tools are not in the payload.*
- **Skills** — 19 built in, `/` in the composer.
- **MCP** — any server, tools arrive as `mcp__<server>__<tool>`. Context7 on by default.
- **Worktrees** — every board task gets its own checkout and branch.

**§8 Open at the seams**

H2 is the README line: *The point of open source is not that you could read the source. It's that the
seams are open where you actually want to reach in.*

Five cards, each with a **real** code snippet in the app's own syntax colours:
Skills (`~/.minnow/skills/my-skill/SKILL.md`) · Tools (a local plugin, no MCP server required) ·
Agents · Prompts (*every system prompt in the app is a markdown file in the repo*) · Themes
(a `--mn-*` block). Each card links to the relevant doc.

**§9 Themes — the live switcher**

H2: *Sixteen built in, which is fifteen more than strictly necessary.*
Eight family cards, each with a light/dark toggle, each showing a 4-swatch mini-preview
(bg / surface-2 / accent / fg). Selecting one sets `document.documentElement.dataset.theme` and **the
entire page recolours** using the app's own 160 ms `background-color`/`border-color`/`fill`/`stroke`
transition. The `AppFrame` replica sits beside the picker and recolours with everything else — which is
why it had to be DOM.

Choice persists to `localStorage` under the app's own key names (`minnow.theme`,
`minnow.theme.followSystem`, `minnow.theme.family`) so the site and the app speak the same dialect.
Footnote with a link to `src/styles/tokens.css` on GitHub: *the whole UI is `--mn-*` tokens in one file.*

**§10 Yours, on your disk**

The README's five bullets, verbatim in substance. Visual: a `~/.minnow` tree rendered in mono —
`chats/` `config/` `brain/` `models/` `secrets/` `skills/` `tools/`. Calm. No padlock icons, no shields,
no red. Pull quote:
*the honest version of "local-first" is not "nothing ever leaves" — it is "nothing leaves unless you
sent it somewhere".*
And: *There is no telemetry and no phone-home. Nobody here knows you installed it.*

**§11 Free forever**

*No feature is ever withheld to make a paid tier.* Then the Blender paragraph in full.
Sponsor / Discord / GitHub links. **No pricing table** — not even a joke one with three "Free" columns;
it would import exactly the SaaS frame the product rejects.

**§12 Status**

Short, honest, at real size:
*One maintainer and a small community. It is a work in progress, meaning parts of it are unfinished and
you will find the edges before I do. Bug reports are genuinely useful.*
Links: Discord · Issues · Sponsor. Cursor and Vercel would never ship this section. That is why it works.

**§13 FAQ** — `<details>`/`<summary>` accordion on hairline rows, `--container-narrow`.

What is Minnow? · Is it really free? · Do I need an API key? · Does it work fully offline? · Which
platforms? · Is my code sent anywhere? · Can my team use it? (honest: it is single-player by design) ·
How is it different from Cursor? · Windows says the installer is unrecognised — why? · What does AGPL
mean for me?

**§14 Final CTA** — centred, `--section-y-lg`.
H2 `--fs-h1`: *Open a repo and start typing.*
Download button + `git clone` block with copy.

**§15 Footer**

Four columns — Product (Download, Changelog, Themes, Roadmap) · Documentation (Install, Connect a model,
Apps, Architecture, Troubleshooting) · Community (GitHub, Discord, Issues, Sponsor) · Legal (AGPL-3.0-or-later,
Third-party notices, Privacy). Bottom row: lockup + **Tiny by design.** + `© 2026 Henri Grimm · AGPL-3.0-or-later`.

### 6.3 `/download`

- Detect platform (`navigator.userAgentData` with UA fallback; handle Apple Silicon vs Intel) and lead
  with the right asset; every other platform listed below, never hidden.
- Release data is fetched **at build time** from `https://api.github.com/repos/HenriGrimm/Minnow/releases/latest`
  (and `/releases` for history) so there is no client-side rate limit. Show version, publish date, file
  name, size, and the asset digest where GitHub provides one.
- **Handle the missing-asset case.** v0.1.3 shipped Windows + Linux only. If the latest release has no
  asset for the visitor's platform, say so plainly and offer the most recent release that does.
- Per-platform notes: Windows SmartScreen (*Choose **More info**, then **Run anyway***); macOS dmg vs
  zip; Linux `chmod +x`.
- Beta channel note: updates run through electron-updater against GitHub Releases, channels **Stable**
  and **Beta**.
- Build-from-source block: `git clone` / `cd Minnow` / `npm install && npm start`.
- Checksums section if digests are available.

### 6.4 `/docs/*`

- Astro **Content Collections**, source `src/content/docs/**`, populated by the sync script from
  `documentation/manual/`, `documentation/contributor/`, `documentation/plugins/`.
- Three-pane layout: left nav tree (from a hand-maintained `src/content/docs-nav.ts` mapping order and
  labels, validated against the synced files at build time so a missing page fails the build), content
  column capped at `--prose` (72ch — the app's own rule), right-hand TOC from `h2`/`h3`.
- **Search: Pagefind** — static index, no backend. Bind it to `Ctrl/Cmd+K` so the site's palette matches
  the app's palette convention.
- Prose styles reuse the app's markdown bubble rules: `p` margin `0.65em 0`, headings `1em 0 0.5em`
  weight 600 line-height 1.25, inline code on `--mn-surface-2`, fenced code as §3.9, tables with
  `--mn-border` cells and `--mn-surface-1` headers, blockquote as a left `--mn-border-strong` rule (the
  one legitimate left border — it is a quote, not a card).
- "Edit this page" link back to the file in the Minnow repo, and a "Last synced" line.

### 6.5 `/changelog`

- Build-time fetch of GitHub Releases; bodies rendered as MDX-ish markdown.
- Layout: left rail with version + date sticky per entry, right column with the notes. Latest first.
- Version chips in mono; pre-releases marked `BETA` with a `--mn-warning`-bordered chip.
- `/changelog/rss.xml`.

### 6.6 Small pages

- `/privacy` — short and true: *This site sets no cookies and runs no analytics.* Plus what the app does
  and does not send.
- `/404` — the fish glyph, "This page swam off.", links home and to docs. One joke is allowed.
- `/llms.txt` and `/llms-full.txt` — a plain-text product summary and a concatenated docs dump.
  Appropriate for this product and a good signal.
- `robots.txt`, `sitemap-index.xml`, `/feed.xml`.

---

## 7. Repository and technical setup

### 7.1 Repo

`HenriGrimm/minnow-web` — public, **AGPL-3.0-or-later** to match the app (the site embeds the app's
token file and documentation, so keeping licences aligned avoids any question).

### 7.2 File tree

```
minnow-web/
├─ astro.config.mjs
├─ package.json
├─ tsconfig.json
├─ .stylelintrc.json                  # the no-hex-outside-vendor guard
├─ lighthouserc.json
├─ budgets.json                       # mirrors the app's budget discipline
├─ CONTENT.md                         # voice rules, copied from PRODUCT.md §Brand personality
├─ README.md
├─ public/
│  ├─ brand/                          # synced: logos, favicons, lockup
│  ├─ docs-assets/                    # synced: images referenced by docs
│  ├─ robots.txt
│  └─ llms.txt, llms-full.txt         # generated
├─ scripts/
│  ├─ sync-minnow.mjs                 # tokens + docs + screenshots + brand
│  ├─ fetch-releases.mjs              # GitHub Releases → src/data/releases.json
│  ├─ build-llms-txt.mjs
│  └─ check-budgets.mjs
├─ src/
│  ├─ styles/
│  │  ├─ vendor/tokens.css            # VERBATIM from Minnow. Never hand-edit.
│  │  ├─ tokens.site.css
│  │  ├─ theme.css                    # Tailwind @theme inline bridge
│  │  ├─ base.css
│  │  ├─ app-frame.css
│  │  └─ prose.css
│  ├─ scripts/
│  │  ├─ theme.ts                     # ported from Minnow src/theme.ts
│  │  ├─ motion.ts
│  │  ├─ hero.ts
│  │  ├─ build-loop.ts
│  │  ├─ platform.ts
│  │  └─ copy-button.ts
│  ├─ components/
│  │  ├─ app/                         # the AppFrame replica (§5.1)
│  │  ├─ icons/                       # inline SVGs
│  │  ├─ site/                        # Nav, Footer, ThemeSwitcher, Section, Eyebrow, Button,
│  │  │                               # Card, RowList, CodeBlock, Accordion, Reveal
│  │  └─ home/                        # one component per home section
│  ├─ layouts/
│  │  ├─ Base.astro                   # <head>, theme boot script, nav, footer
│  │  ├─ Docs.astro
│  │  └─ Marketing.astro
│  ├─ content/
│  │  ├─ config.ts
│  │  ├─ docs/                        # synced
│  │  └─ docs-nav.ts
│  ├─ data/
│  │  ├─ releases.json                # generated
│  │  ├─ providers.ts, apps.ts, faq.ts, replaces.ts, themes.ts
│  │  └─ site.ts                      # SITE.url, repo, discord, sponsor, version
│  ├─ assets/screenshots/             # synced PNGs, processed by astro:assets
│  └─ pages/
│     ├─ index.astro
│     ├─ download.astro
│     ├─ changelog/index.astro
│     ├─ docs/[...slug].astro
│     ├─ privacy.astro
│     └─ 404.astro
└─ .github/workflows/
   ├─ ci.yml                          # build + stylelint + lighthouse + link check + a11y
   └─ sync-content.yml                # daily cron + repository_dispatch
```

### 7.3 Dependencies

```
astro ^5
@astrojs/mdx  @astrojs/sitemap
@tailwindcss/vite  tailwindcss ^4
sharp                       # astro:assets image pipeline
shiki                       # via Astro's built-in markdown config
astro-pagefind              # docs search
astro-og-canvas             # per-page OG images in the site's own colours
stylelint + stylelint-config-standard
@lhci/cli                   # CI Lighthouse
```

**No UI framework.** Minnow itself is "direct TypeScript + DOM with CSS tokens" — the site matching that
is both on-brand and the cheapest path to the performance budget. Every interactive piece here (theme
switcher, accordion, copy buttons, platform detect, scroll scrub) is 20–60 lines of vanilla TS in an
Astro `<script>`. Add `@astrojs/react` only if a future component genuinely needs it; nothing in v1 does.

### 7.4 Theme runtime (`src/scripts/theme.ts` — ported from `src/theme.ts`)

```ts
export const THEME_FAMILIES = ['swamp','desert','ocean','coral','mono','matrix','human','mint'] as const;
export const THEME_MODES = ['dark','light'] as const;
export const DEFAULT_THEME_ID = 'human-dark';   // site default (the app's is swamp-dark)
```

Storage keys identical to the app: `minnow.theme`, `minnow.theme.followSystem`, `minnow.theme.family`.

**Flash guard** — an inline, render-blocking IIFE in `<head>`, copied in shape from Minnow's
`index.html`, carrying the same background map so the first paint is already the right colour:

```js
var THEME_BG = {
  'swamp-dark':'#0f1216','swamp-light':'#f7f7f4','desert-dark':'#16140f','desert-light':'#f7f4ec',
  'ocean-dark':'#0d1117','ocean-light':'#f4f6f9','coral-dark':'#141416','coral-light':'#fafaf8',
  'mono-dark':'#2b2b2b','mono-light':'#f7f7f7','matrix-dark':'#040604','matrix-light':'#eef2ee',
  'human-dark':'#0f0f0f','human-light':'#fbf1ea','mint-dark':'#141615','mint-light':'#f2faf6'
};
```

Apply order, same as the app: add `.theme-no-transition` → set `data-theme` + `colorScheme` → two
`requestAnimationFrame`s → remove `.theme-no-transition`, add `.theme-ready`. Keep
`theme-transitions.css` verbatim (the 160 ms `background-color`/`border-color`/`fill`/`stroke`
transition plus the input/textarea/select opt-out that fixes caret paint lag), and sync
`<meta name="theme-color">` to the computed `--mn-bg`.

Default `human-dark` always on a first visit; `followSystem` is opt-in via the **Auto** segment, exactly
as in the app.

### 7.5 Content sync (`scripts/sync-minnow.mjs`)

```bash
node scripts/sync-minnow.mjs --repo HenriGrimm/Minnow --ref main
```

Downloads the repo tarball (no submodule — a submodule makes the site repo painful to clone and to
Dependabot) and extracts:

| From | To | Transform |
|---|---|---|
| `src/styles/tokens.css` | `src/styles/vendor/tokens.css` | append the 4 missing `--mn-syntax-*` to `human-dark` + `mint-dark`; add a "generated, do not edit" banner |
| `documentation/manual/**/*.md` | `src/content/docs/manual/**` | inject frontmatter (title from H1, description from the first paragraph), rewrite relative links `→ /docs/...`, rewrite image paths |
| `documentation/contributor/**`, `documentation/plugins/**` | `src/content/docs/...` | same |
| `documentation/images/*.png` | `src/assets/screenshots/` | skip `app-research.png` (gated app) |
| `public/logos/**` | `public/brand/` | copy |
| `documentation/ROADMAP.md` | `src/content/docs/roadmap.md` | copy |

Guards, each failing the build loudly:
- a `docs-nav.ts` entry with no matching file, or a synced file absent from the nav;
- a doc or a site string mentioning a release-gated surface (Research, Experts, Benchmarking, Compare,
  Super Plan) outside an explicit allowlist;
- `tokens.css` not containing all 16 `[data-theme=...]` blocks;
- any internal link 404ing.

### 7.6 CI

`ci.yml` on push/PR: install → `sync-minnow` → `fetch-releases` → `astro build` → stylelint (the hex
guard) → `lychee` link check → `@lhci/cli` against the built site → `check-budgets.mjs`.

`sync-content.yml`: daily cron **and** `repository_dispatch`. Re-syncs and opens a PR when anything
changed, so docs and changelog updates arrive as reviewable diffs rather than silent drift.

> **Optional one-line change in the Minnow repo** (out of scope for this plan, list it as a follow-up):
> a release-published workflow step that sends a `repository_dispatch` to `minnow-web`, so a new release
> updates the download and changelog pages within a minute instead of within a day.

### 7.7 Hosting

**Cloudflare Pages.** Static output, free, fast, and the register fits a project whose whole argument is
"not a SaaS". Vercel is an equally fine second choice and requires no code change — output is static
either way. Add `minnow.sh` and `www.minnow.sh` (301 → apex).

Headers: `Cache-Control: public, max-age=31536000, immutable` for `/_astro/*`, `max-age=0,
must-revalidate` for HTML. A strict CSP is easy here because there are no third-party scripts — only
`fonts.googleapis.com` / `fonts.gstatic.com` need allowing.

### 7.8 Performance budgets (`budgets.json`, mirroring the app's discipline)

| Metric | Budget |
|---|---|
| Home HTML (gz) | ≤ 22 KB |
| CSS, all pages (gz) | ≤ 45 KB |
| JS, home (gz) | ≤ 25 KB |
| LCP image | ≤ 180 KB (AVIF) |
| Lighthouse Performance (mobile) | ≥ 98 |
| Lighthouse A11y / Best Practices / SEO | 100 |

Screenshots go through `astro:assets` → AVIF + WebP at widths `[880, 1320, 1760, 2200]`, `loading="lazy"`
and `decoding="async"` everywhere except the LCP element. The 1.65 MB `app-brain.png` lands around
120 KB as AVIF.

### 7.9 Accessibility

- WCAG 2.1 AA in **every** theme, not just the default — the app CI-tests this and the site should too.
  Add a small Playwright + axe run that loads the home page 16 times, once per `data-theme`.
- The accent rule from §3.2 is the one that will actually bite: small accent text must use
  `--mn-accent-ink`, never `--mn-accent`.
- Skip link; landmark roles; `:focus-visible` rings everywhere at `2px solid var(--mn-focus-ring)`;
  44 px touch targets; accordion as native `<details>`; `prefers-reduced-motion` honoured at three
  levels (§4.4); every icon-only control gets an `aria-label`.

### 7.10 SEO and meta

Canonical `https://minnow.sh`. Per-page OG images generated at build in `human-dark` colours (glyph +
title in the site's own type). JSON-LD `SoftwareApplication`: `applicationCategory: DeveloperApplication`,
`operatingSystem: "Windows, macOS, Linux"`, `offers: { price: "0", priceCurrency: "USD" }`,
`license: https://www.gnu.org/licenses/agpl-3.0.html`.

**Analytics: none in v1.** The privacy page says so in one sentence, and that sentence is worth more
than the data. If analytics later become necessary, self-hosted Umami or Plausible only — never a
script that phones a third party, given what the app promises.

---

## 8. Build phases

| Phase | Deliverable | Done when |
|---|---|---|
| **0 — Foundation** | Repo scaffold, Astro + Tailwind v4, `sync-minnow.mjs`, all 16 themes vendored, `theme.ts` + flash guard, `base.css`, `tokens.site.css`, stylelint hex guard, Base layout, Nav + Footer | `npm run dev` shows a themed empty page; the theme switcher recolours it across all 16; stylelint fails on a planted hex |
| **1 — App frame** | `AppFrame` and its seven subcomponents, the icon set, brand marks | The replica sits next to `hero.png` and reads as the same app; it recolours with every theme |
| **2 — Home, static** | Every section built with final copy and layout, zero motion | The page is complete and correct with JS disabled |
| **3 — Motion** | `motion.ts` reveal primitive, hero sequence, seam diagram, pinned build loop, Quick Edit demo, tools-permission demo | All of it dies correctly under `prefers-reduced-motion`; no layout-triggering property is animated |
| **4 — Download + Changelog** | `fetch-releases.mjs`, platform detection, per-platform notes, missing-asset fallback, changelog + RSS | The current release renders correctly, including the case where macOS has no asset |
| **5 — Docs** | Content collections, sync transforms, three-pane layout, Pagefind + `Ctrl+K`, prose styles, nav validation | Every page in `documentation/manual/` renders with working links and images; a broken nav entry fails the build |
| **6 — Polish and ship** | OG images, favicons, `llms.txt`, `robots`/`sitemap`, 404, privacy, CI workflows, budgets, axe-per-theme, Cloudflare Pages + DNS | Lighthouse ≥98/100/100/100 on mobile; axe clean in all 16 themes; `minnow.sh` live |

---

## 9. Verification

**Local**
```bash
npm run sync:minnow      # pull tokens, docs, screenshots, brand
npm run dev              # Astro dev server
npm run build && npm run preview
```

Drive the dev server through the Browser pane rather than eyeballing screenshots:

1. `preview_start` on the dev server, then `read_page` to confirm structure and heading order.
2. `javascript_tool` → `document.documentElement.dataset.theme = 'matrix-light'` and read back
   `getComputedStyle(document.body).backgroundColor` for several families — this is the reliable way to
   verify theming, since screenshots of a transitioning page lie.
3. `read_console_messages` and `read_network_requests` for errors and for the real transfer sizes of the
   hero image and JS bundles.
4. `resize_window` at `mobile` / `tablet` / `desktop`, reloading after each so load-time gates re-run.
5. `resize_window { colorScheme: 'light' }` to confirm the **Auto** segment follows the system.
6. Reduced motion: `javascript_tool` cannot fake the media query, so verify by temporarily forcing
   `motion.ts`'s early-return branch and confirming every section renders at its final state.

**Automated**
```bash
npm run lint:css         # stylelint — no hex outside vendor/tokens.css
npm run check:links      # lychee over the built output
npm run check:a11y       # Playwright + axe, once per data-theme (16 runs)
npm run check:budgets    # against budgets.json
npx lhci autorun         # Lighthouse, mobile preset
```

**Content correctness — check by hand before launch**

- No mention of Email, Studio, agent-CLI providers, Research, Experts, Benchmarking, Compare, or Super Plan.
- Only the seven sanctioned replacement rows, none disparaging.
- No exclamation marks anywhere in body copy.
- Every number in §1.5 still matches the Minnow repo.
- The README's typos are not reproduced.
- Screenshot freshness: `documentation/images/README.md` warns that several PNGs still show the
  pre-workspace-first shell. `hero.png` and `app-orchestrator.png` were refreshed 2026-09-11; the rest
  date to 2026-08-08 or earlier. Re-shoot `app-code.png`, `app-brain.png`, `app-models.png`,
  `app-issues.png`, `app-scheduler.png`, `app-source-control.png` in **human-dark at 2× DPR, 16:9, real
  data** before launch so the set is consistent with the site's default theme.

---

## 10. Open follow-ups (not blocking v1)

- Re-shoot the screenshot set in `human-dark` (see above) — this is the single biggest visual-quality
  lever left.
- Add the `repository_dispatch` step to the Minnow repo's release workflow (§7.6).
- A `/themes` standalone page, if the home section proves popular enough to deserve its own URL.
- A blog, once there is something to say more than once.
