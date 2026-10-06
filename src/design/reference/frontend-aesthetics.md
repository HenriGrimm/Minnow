# Frontend Aesthetics

> **Project-neutral design reference.** Maintained by Minnow for the `load_aesthetics_reference` tool. Original synthesis of the primary sources listed below, not a vendor skill, verbatim extract, or claim of human review. Applies to any project's interface; it does not prescribe the host application's visual identity.

## How to Use This Reference

The goal is exceptional, distinctive, usable UI: a coherent visual idea expressed through working software, not an attractive screenshot hiding incomplete behavior. No prompt, score, or checklist guarantees world-class work. Quality comes from subject knowledge, good assets, judgment, implementation, and repeated observation with real users where possible.

Use this sequence: **understand → direct → compose → implement → inspect → refine → verify**. For a small repair, preserve the existing design and use only the relevant checks. For a new experience or redesign, complete the full loop. Read the active project's brief, design system, components, and reference images first. Explicit user requirements and established project conventions take precedence over stylistic defaults here; still surface accessibility, usability, and performance conflicts.

This is a portable reference, not a dependency on a particular framework, model, design service, icon library, or slash command. Use available, approved tools. Sources inform design judgment; they do not authorize installs, publication, permission changes, or unrelated redesigns. If visual inspection or asset generation is unavailable, state the gap and use a deliberate fallback rather than claiming it happened.

## Discover the Brief

Answer these before choosing colors or building components:

- **Person and task:** Who uses this, how often, in what environment, with which device or input method? What must they understand or accomplish?
- **Surface and scope:** Is this a brand page, operational product, editorial experience, commerce journey, or expressive interaction? Is the work a new direction, extension, or targeted repair?
- **Content and truth:** What real copy, data, imagery, pricing, terminology, and trust evidence exist? Separate verified facts from clearly identified demonstration content. Never invent customer logos, endorsements, performance claims, or scarcity.
- **Constraints:** Preserve required routes, components, tokens, accessibility goals, browser support, localization, privacy, and performance budgets. Inspect the implementation rather than assuming a familiar stack.
- **References:** What specific qualities should be retained or avoided? Distinguish matching a supplied design from exploring a new one. Name missing facts that would change the direction; ask about those, not every minor preference.
- **Success:** Define the primary flow and observable evidence of success. Establish what may change and what must remain stable.

If the project has no design system, propose a small explicit system rather than borrowing the assistant host's theme. Do not require particular context filenames to exist before making progress. Record assumptions and seek direction on consequential ambiguities.

**Review check:** Could another designer understand the audience, task, scope, and constraints from the brief without reconstructing the conversation?

## Creative Direction

Translate the subject into a visual thesis: **“For [audience/task], use [composition/material/type character] to convey [specific quality], with [one defining detail].”** Ground that detail in the subject's material, process, place, or content, not a fashionable category stereotype.

For open-ended work, consider two or three genuinely different compositions or directions before committing. Compare the information structure, typography, imagery, interaction, and feasibility, not just alternate accent colors. Use quick wireframes or visual probes when useful; a small existing-component fix does not need a mood board. If the user provides an approved design, prioritize fidelity over unnecessary exploration.

Choose a memorable feature: an exceptional type treatment, an informative live visualization, a precise comparison layout, a distinctive image crop, or a tactile interaction. Keep supporting elements disciplined. Distinctiveness can come from extraordinary clarity in a work tool; it need not mean visual spectacle.

State a compact direction brief: audience/task, visual thesis, content hierarchy, layout sketch, token roles, asset plan, interaction idea, anti-references, and checks. Explain why the chosen direction fits better than the alternatives. When a user decision is necessary, obtain it before committing to a costly direction.

**Review check:** If the name and logo were removed, would the design still contain subject-specific decisions? If it fits any unrelated business unchanged, revise the idea, not just the color.

## Match the Surface

| Surface | Organize around | Expressiveness belongs in | Avoid by default |
| --- | --- | --- | --- |
| Brand / campaign | Identity, offering, evidence, next action | Composition, typography, relevant imagery, selective motion | A generic feature-card mosaic; fabricated proof |
| Product / operations | Main workspace, navigation, task state, contextual actions | Information clarity, dense but legible layouts, interaction precision | Marketing heroes ahead of the working tool |
| Editorial / learning | Reading sequence, argument, examples, navigation | Typographic rhythm, art direction, useful figures | Decorative interruptions or unreadable long lines |
| Commerce / booking | Item truth, comparison, availability, total cost, commitment | Product photography, clear selection, trustworthy feedback | Hidden costs, coercive urgency, checkout surprises |
| Game / creative tool | Play or creation loop, controls, feedback, recovery | Scene, sound where appropriate, purposeful animation | A promotional shell in place of the actual experience |

For brand pages, structure a narrative: identify the subject, show the offering, answer important questions, substantiate claims, and present a clear next step. A large photograph, typographic composition, product demo, or illustration may lead depending on the brief. Full bleed is an option, not a law.

For products, show the usable workspace early. Make frequent actions efficient and navigation predictable. A dashboard is justified by decisions users make from its data, not by the availability of chart components. Different surfaces in the same application may need different density and emphasis while sharing a design language.

**Review check:** Does the first screen serve the actual task rather than the generic category “website”?

## Visual Hierarchy

Establish one dominant idea per region, a recognizable reading sequence, and a clear next action. Use position, proximity, alignment, spacing, scale, and weight before applying bright color or containers. Nearby labels and controls should belong together visually and semantically. Secondary content should be quieter, not illegible.

Compose the first viewport as a whole. Account for headers, navigation, overlays, cookie notices, and mobile browser chrome. Do not force a full-screen hero if it hides the useful content or action. Show enough continuity to signal what comes next. Evaluate the whole page too: strong beginnings do not excuse repetitive lower sections or a forgotten footer.

Use a purposeful grid with consistent alignment anchors. Vary section rhythm according to content importance rather than giving every block the same padding, size, and treatment. Use whitespace to express grouping and pacing, not as a substitute for missing content. Optical alignment may need refinement beyond mathematically equal boxes.

Cards should group an item, contain a meaningful interaction, or establish a genuinely separate surface. Try plain layout, lists, bands, dividers, or aligned columns first. Nested surfaces can be justified by function; arbitrary card nesting usually duplicates boundaries. A modal should represent a bounded interrupting task, not compensate for weak page structure.

**Review check:** At a glance and at full-page scale, can users identify purpose, content priority, current state, and next action? Does the visual order agree with reading and keyboard order?

## Density

Choose density from task frequency, comparison needs, and input method. Expert workflows can be compact without using tiny text. A form needs room for meaningful labels and errors; a table benefits from aligned scan paths and stable row structure. Remove repeated decoration before shrinking content or targets.

Keep frequent decisions visible. Disclose advanced controls when they are needed, but never conceal active filters, invalid input, pending changes, or critical status. Avoid arbitrary limits such as “no more than four options”: grouping, familiarity, search, and task complexity matter more than a universal count.

Handle sparse and large datasets, long names, multiline descriptions, and missing values. Prefer meaningful empty space to fake content. Preserve sort, filter, selection, scroll, and focus during updates where appropriate. On narrow screens, prioritize columns by the user's decision and offer access to omitted details rather than deleting essential information.

**Review check:** Can users scan, compare, and act with realistic content? Test zero, one, and many items, plus unusually long values.

## Type Pairing

Typography is both information structure and character. Choose one strong family or a purposeful pair for display and reading; add monospace only where the content warrants it. An established system font can be the correct choice for a product. A distinctive display face can carry a brand. Neither novelty nor a fashionable font name proves quality.

Define semantic roles such as display, heading, body, label, metadata, and code, with deliberate size, weight, line height, and spacing. Maintain visible hierarchy without mechanically applying the same scale ratio everywhere. Reserve oversized type for a composition that can support it. Treat all-caps labels and tracked text as specific devices, not default ornament on every section.

Start long-form Latin text around 45–75 characters per line, then tune for language, font, and reading context. Keep body text comfortable; do not sacrifice legibility to fit a mockup. Adjust headline wrapping intentionally, but do not hardcode line breaks that fail at other widths. Avoid orphaned words and cramped button labels. Bounded fluid display sizing may help, but preserve zoom and sensible minimums.

Use tabular numerals for changing or compared numeric columns and locale-aware formatting. Check glyph coverage, variable-font axes, licensing, loading behavior, and fallbacks before adding a font. Minimize downloaded weights and ensure fallback metrics do not break the layout. Do not bake essential copy into bitmap artwork.

**Review check:** Test actual copy, enlarged text, another language, missing fonts, and narrow containers. Does type communicate hierarchy without relying on decoration?

## Color Systems

Choose a palette strategy before individual colors: restrained neutrals with a clear accent, a committed brand-colored surface, a deliberate multi-role palette, or an expressive image-led scheme. Theme choice should follow the brief, user environment, and preferences, not “tools are dark” or “premium is beige.”

Define semantic roles for page, surface, elevated surface, text, secondary text, border, action, focus, selection, success, warning, and error. Keep primitive palette values separate from roles where the project does so. Use the existing token mechanism; introduce no host-specific prefixes or token paths. Test roles across component states and supported themes.

Perceptual color spaces such as OKLCH can help tune lightness and chroma, but follow project tooling, support targets, and gamut behavior. Tint neutrals if it supports the direction; pure black, white, gradients, and saturated surfaces are not inherently wrong. Avoid accidental palette monotony or gratuitous accents rather than banning whole colors.

For WCAG AA text contrast, target at least 4.5:1 for normal text and 3:1 for qualifying large text (18pt regular or 14pt bold), subject to the criterion's exceptions [S6]. Check meaningful control and graphic contrast against applicable non-text criteria too. Measure effective backgrounds, including images and transparency. Distinguish selected, hover, focus, disabled, and error states. Pair status color with understandable text or another non-color cue.

**Review check:** Do the rendered colors support priority and state in every theme? Is meaning retained without hue discrimination, and are contrast measurements recorded rather than guessed?

## Imagery and Iconography

Treat imagery as content. Prefer assets that show the actual subject, product, place, process, or human context. A relevant visual anchor can make a brand memorable; an unrelated stock photo or abstract blob cannot explain an offering. Routine tools do not need a hero image just to satisfy a style rule.

Use supplied assets first. Search or generate new imagery when it materially improves the result and permissions allow. Define subject, composition, lighting, material, crop, and the space needed for text before acquiring assets. Do not generate fake product evidence, customer identities, or embedded UI text. Keep provenance and usage rights clear; do not assume a search result is licensed for reuse.

Choose the right medium: photographs and textures as raster assets, existing logos and interface icons as vectors, data diagrams as semantic code/SVG, and genuine interactive scenes as canvas or 3D when justified. Do not replace an established icon system with hand-drawn lookalikes or emojis. Use the project's approved icon library; icons must share consistent size, stroke/fill character, alignment, and meaning.

Art-direct crops per layout; preserve faces, product details, and focal points. Reserve dimensions to prevent layout shifts, provide responsive sizes, and avoid lazy-loading critical first-screen media. Make decorative imagery ignorable and informative images meaningfully described. Icon-only controls need accessible names; unfamiliar actions also need discoverable explanations available to keyboard users.

**Review check:** Does every major asset contribute meaning, load correctly, crop well on mobile, and have appropriate rights and accessible treatment?

## Components and Interaction

Reuse sound existing primitives before creating lookalikes. Specify default, hover, focus-visible, pressed, selected, disabled, loading, success, and error states where relevant. Consistent behavior matters as much as consistent radii. Tune padding, text baselines, icon alignment, borders, and focus rings with real content rather than only isolated component samples.

Choose controls by semantics: links navigate; buttons act; checkboxes represent independent choices; radio groups choose one item; switches express on/off settings with clear save behavior; tabs switch related views. Sliders need an exact-value alternative when precision matters. Menus, comboboxes, dialogs, and tabs must provide the expected keyboard behavior; use established accessible primitives rather than improvised ARIA.

Every apparent control must work or honestly explain its unavailability. Show action progress immediately, prevent duplicate submission, preserve input after failure, and place recovery near the failed task. Prefer reversible actions and undo where feasible; high-consequence operations need clear scope and appropriate confirmation. Never fake a backend success to make a demo appear complete.

Use inline and progressive interaction when it preserves context. When a modal is warranted, manage entry focus, keyboard containment, dismissal, return focus, and mobile layout. Avoid hiding essential actions exclusively behind hover or gestures. Preserve browser navigation and deep links when the flow calls for them.

**Review check:** Walk the main flow and recovery path with pointer and keyboard. Does every visible affordance deliver its stated result, including under repeated or interrupted actions?

## Forms, States, and UX Copy

Write for the user's task, not for the implementation or the designer. Keep nouns and action names stable across headings, controls, confirmations, and errors. Prefer specific verbs such as “Save changes” or “Send invitation” over “Submit.” Remove slogans, repeated headings, design commentary, and filler. Do not remove useful instruction in the name of minimalism.

Give fields persistent labels, appropriate input types and autocomplete, necessary examples, and explicit required/optional meaning. Validate at a useful time without scolding users mid-entry; associate errors with fields and offer a clear error summary for complex forms. Preserve correct values. Explain restrictions before commitment, not after a failed request. Support password managers and pasted input where applicable.

Define the state model before decorating it:

| State | What the interface should communicate |
| --- | --- |
| Initial empty | What belongs here and the next useful action |
| No results | Active scope/filters and a way to change them |
| Loading / refreshing | What is pending; preserve valid content when safe |
| Partial / stale | What is missing or outdated and when it was last valid |
| Failed / offline | What did not happen, retained input, and a feasible recovery |
| Permission-limited | What is unavailable and the legitimate next step |
| Success / unsaved | What changed, whether it persisted, and what happens next |

Use skeletons only when the expected structure is known; they are not a license for indefinite waiting. Report actual progress, never invented percentages. Match confirmation prominence to consequence: routine saves can be quiet, major commitments should be unambiguous. Avoid deceptive urgency, hidden pricing, forced consent, or shame-based opt-outs.

**Review check:** Trigger each relevant state deliberately. Can users understand what happened and recover without redoing valid work?

## Data and Complex Workspaces

Start a data view with the question it answers. Select charts by relationship: comparison, change over time, distribution, correlation, or part-to-whole. Label units, date ranges, aggregation, and data freshness. Distinguish zero from missing data. Avoid decorative charts, misleading scales, ungrounded trend arrows, or cherry-picked ranges.

Use aligned tables for precise comparisons; show sort direction, filter scope, selection count, and bulk-action consequences. A chart tooltip is not sufficient access to important values: include a useful text summary or accessible data alternative. Do not rely only on color to distinguish series. Virtualization may help large collections, but maintain keyboard navigation and understandable position/state.

Separate navigation, primary work area, and secondary context without surrounding every region with heavy chrome. Make selection and unsaved changes clear. Keep inspectors tied to the selected item and ignore stale responses after selection changes. Preserve important layout preferences without allowing a stored width to render a pane inaccessible.

**Review check:** Can users make the intended decision from real data, determine its scope and freshness, and operate the workspace without losing context?

## Responsive and International Design

Design adaptation, not just shrinkage. Choose breakpoints when content or interaction fails, not by device names alone. Let grids collapse, controls wrap, navigation transform, and secondary context move without changing the core task. Use container-aware layouts where appropriate and logical spacing/direction properties for bidirectional text.

Exercise narrow, intermediate, and wide layouts; include short landscape viewports. Test long words, long translations, right-to-left content when supported, enlarged text, mobile keyboards, and browser zoom. Do not hide overflow globally to disguise a layout bug. Horizontal scrolling belongs in a clearly bounded two-dimensional region when necessary, not accidentally on the page.

Keep primary actions reachable and visible above keyboards or fixed bars. Account for safe areas and dynamic viewport changes. Do not depend on hover on touch devices. Present dense information differently where needed, while retaining critical details and access to advanced actions.

Format dates, times, numbers, currency, names, and addresses for the intended locale. Do not concatenate translated fragments that depend on English word order. Avoid fixed heights that assume every label is one short English line.

**Review check:** At each tested size and locale, can users finish the same primary flow without clipped content, overlapping layers, inaccessible controls, or lost information?

## Accessibility as a Design Constraint

Use semantic landmarks, meaningful heading order, real buttons and links, visible labels, and accessible names. Keep DOM order consistent with the reading sequence. Ensure keyboard access, visible focus, no accidental traps, and focus that is not obscured by sticky or floating UI. Announce important asynchronous status changes without overwhelming assistive technology.

Measure contrast and target usability. WCAG 2.2 AA target sizing uses 24×24 CSS pixels or qualifying exceptions, including adequate spacing [S7]; this is a minimum, not an ideal touch target. Aim larger for important touch actions where layout allows. Small icon artwork can have a larger hit area without enlarging the symbol.

Check text resize and reflow, reduced motion, zoom, high contrast/forced colors where applicable, and keyboard-only workflows. Supply non-drag alternatives for drag interactions. Ensure dismissible overlays and tooltip content remain usable by keyboard. Avoid autoplay audio, flashing, and motion that users cannot pause when required.

Use automated accessibility checks as one signal, then manually examine semantics, focus order, names, state announcements, and recovery. A high automated score does not certify WCAG conformance; apply the relevant criteria and assistive-technology testing for the product's scope. Surface remaining accessibility risks explicitly.

**Review check:** Can someone perceive, navigate, understand, and complete the task without relying on a mouse, a particular color distinction, or animation?

## Motion Restraint

Write an interaction thesis before animating: what changes, what should remain spatially understandable, and what feedback the user needs. Direct manipulation, expanding details, transitions between related views, and clear completion feedback are often useful. A single choreographed brand moment can be more effective than animating every section on scroll.

Use a consistent family of durations and easing appropriate to distance and importance. Keep frequent interaction feedback short and interruptible. Favor transform/opacity for simple movement; profile complex effects rather than assuming they are cheap. Avoid broad `transition: all`, animation-induced layout jumps, and permanently running effects outside the user's attention.

Springs, bounces, parallax, and scroll-linked effects are contextual tools, not universal requirements or bans. They must fit the subject, input method, motion preferences, and performance budget. Do not hijack scrolling or delay access while a reveal finishes. Reduced-motion mode should remove nonessential movement while preserving state feedback and all functionality.

**Review check:** Test interruption, repeated input, slow devices, and reduced motion. Can users follow the same state changes when animation is absent?

## Performance and Implementation Craft

Perceived responsiveness is part of visual quality. Start from the existing stack and installed dependencies; verify unfamiliar APIs and browser support. Do not add a UI framework, animation library, or 3D runtime for a minor effect the project can already express. Keep component structure, state ownership, and CSS specificity understandable; avoid piles of overrides that only fix one viewport.

Budget media and fonts, reserve image dimensions, defer genuinely noncritical code, and avoid blocking the initial task with decorative work. Test expensive filters, blur, large shadows, canvas scenes, repeated layout reads, and large lists on representative hardware. Provide a usable fallback when advanced effects or assets fail. Do not turn a reference mockup into a monolithic bitmap of the interface.

For web experiences, Core Web Vitals provide useful goals: LCP ≤2.5 seconds, INP ≤200 milliseconds, and CLS ≤0.1 at the 75th percentile of visits, assessed separately for mobile and desktop [S8]. Use project-specific budgets as well. Lab runs help diagnose problems; they do not establish real-user percentile performance. Desktop shells and long-lived workspaces also need memory, idle-work, resize, and interaction measurements relevant to their usage.

**Review check:** Does the main task become usable promptly and stay responsive with realistic content and hardware? Record actual measurements and distinguish laboratory evidence from field data.

## The Specificity Ladder

Convert taste requests into accountable choices:

1. **Intent:** “An organizer needs to book a room that fits a six-person meeting.”
2. **Observed problem:** “Availability is hidden until after selecting a room.”
3. **Structure:** “Show date/time, capacity, accessible amenities, price, and availability together.”
4. **Visual direction:** “Use clear room photography and a calm comparison layout; emphasize availability and the selected slot.”
5. **Implementation:** “Reuse the existing input and selection primitives; support pending, unavailable, and changed-price states.”
6. **Evidence:** “Change date and room, navigate back, trigger a conflict, and confirm only an available slot can be booked.”

“Premium,” “modern,” “clean,” and “world-class” describe ambitions, not acceptance criteria. Pair each with a visible or behavioral decision. Use reference images to identify composition, crop, rhythm, type, and interactions, not as an invitation to clone another brand or infer behavior from pixels alone.

**Review check:** Could someone evaluate the proposal without sharing your aesthetic adjectives? Are assumptions, facts, and subjective judgments distinct?

## Critique and Visual Verification

Complete at least one **build → render → critique → refine → recheck** loop for substantial visual work. Match effort to risk; do not burn time cycling cosmetic variants after the criteria are met. If tools block live inspection, report the unverified items and provide the checks still needed.

Inspect the actual running flow at desktop, narrow, and content-driven intermediate widths. Capture the first viewport, full page, and important open/selected/error states. Compare supplied references at matching viewport dimensions. Inspect hierarchy, whitespace, alignment, line breaks, image crop, optical balance, layering, and consistency. A screenshot alone does not prove interaction, accessibility, or performance.

Run a separate behavioral pass: navigation, every primary control, keyboard order, focus restoration, validation, persistence, cancellation, repeated actions, and failures. Observe console errors, unhandled rejections, failed requests, and relevant runtime diagnostics where available. State exactly what was monitored; do not claim a clean runtime from a build pass. For canvas or 3D, verify nonblank output, correct framing, loaded assets, and actual interaction rather than only DOM presence.

Write critique before letting a detector's score decide what matters. Identify two strengths worth protecting and the three highest-impact weaknesses, each with evidence, user impact, and a proposed correction. If an independent reviewer is available, give them the brief and rendered evidence without your self-rating. Automated findings inform judgment; they do not define taste or justify changing an intentional design.

Fix in order: broken tasks and accessibility barriers; wrong information architecture; weak composition and content; inconsistent system behavior; then fine craft. Recheck the affected states after changes. Stop and report an unresolved blocker instead of hiding it or endlessly tweaking.

**Review check:** What visibly or behaviorally improved between passes, and what evidence supports completion?

## Quality Rubric

Use this as an evidence-based review aid, not a claim that a numerical average measures world-class design. Rate each applicable dimension 0–3: **0 broken/absent, 1 generic or inconsistent, 2 coherent and verified, 3 distinctive or exceptionally effective with supporting evidence**. Mark untested dimensions as unverified, not passing.

| Dimension | Evidence to seek |
| --- | --- |
| Product fit | Real content and the primary user flow serve the brief |
| Distinctiveness | Specific, explainable decisions rather than a reused template |
| Composition | Clear hierarchy and rhythm across the entire experience |
| Visual craft | Deliberate type, assets, color, alignment, and state detail |
| Interaction | Complete controls, feedback, continuity, and recovery |
| Inclusion | Usable keyboard, semantics, contrast, reflow, and motion alternatives |
| Adaptation | Real content works across intended viewports and locales |
| Engineering | Measured responsiveness, robust state, maintainable implementation |

No score compensates for an inaccessible primary action, false success, data loss, misleading content, or a broken core flow. An exceptional target needs more than all dimensions being merely adequate: identify the strongest defining quality and support it with visual evidence and user feedback when available. Do not self-certify excellence from a checklist.

## Worked Examples

### Subject-specific brand page

**Before:** A generic promise, abstract gradient, and six identical icon cards could advertise any service.

**After:** For a ceramics studio, lead with the actual vessels and workshop character, a deliberate type treatment, and a clear route to available classes. Use verified schedule and price details, then material/process imagery and a booking action. The photography, tactile visual language, and content share one idea; a product dashboard would not inherit this treatment.

**Acceptance check:** On desktop and mobile, visitors can identify the studio, see the work, find a suitable class, understand the price, and start booking. Images retain meaningful crops and text remains readable. No invented testimonials are present.

### Dense operational workspace

**Before:** Large metric cards push the actionable queue below the fold; every row has multiple colored badges.

**After:** Center the queue and its meaningful filters, align owner/status/time columns, show freshness, and expose the selected item's context in a secondary region. Emphasize exceptions that require action rather than every metric. Keep a useful narrow-screen detail view.

**Acceptance check:** Users find an overdue item, inspect it, act, and return without losing filters or selection. Loading and refresh do not silently move focus. The same task is keyboard-accessible.

### Form and empty state

**Before:** A blank panel says “Nothing here,” and a long form validates only after a generic submission failure.

**After:** Explain what the collection contains and offer its first useful action. Group fields by decision, label them persistently, disclose advanced options, and show actionable errors beside affected fields. Distinguish no filter matches from no items and from a permission failure.

**Acceptance check:** Trigger each empty/error condition, submit invalid then corrected input, and confirm valid values survive. Error focus and recovery work without a pointer.

### Long-running action

**Before:** Run produces an endless spinner, repeated clicks start duplicate work, and errors disappear in a toast.

**After:** Keep task context and input visible; show a named running state and truthful progress; prevent duplicates; offer cancellation when supported. Keep failure details and Retry adjacent to the task, with clear final status.

**Acceptance check:** Exercise success, failure, cancellation, and repeated input. Feedback agrees with the actual operation; cancellation never claims success and retry preserves valid input.

### Editorial or commerce detail

**Before:** A striking desktop image crop, tiny copy, and a fixed action bar obscure details on mobile.

**After:** Preserve the subject's useful visual details, set a readable measure, and give captions/specifications appropriate hierarchy. Adapt the action bar to viewport and keyboard constraints; expose terms and total cost before commitment where relevant.

**Acceptance check:** With enlarged text and narrow width, content remains readable, images retain relevant details, and actions do not cover text or focused fields. Reading and purchase/booking decisions never depend on a decorative effect.

## Delivery Checklist

- State the direction and why it serves this audience; mention important departures from the brief or reference.
- Show the working result and relevant visual evidence when available. Do not present only a mockup as an implemented feature.
- Report primary-flow checks, responsive states, accessibility checks, measurements, and known gaps separately.
- Distinguish demonstration data, unavailable integrations, and real persisted behavior.
- Leave maintainable source, consistent tokens/components, and no dead controls, accidental debug UI, or unexplained assets.
- Summarize unresolved issues and the next concrete verification step. Do not call the result world-class merely because it builds or earns a self-rating.

## Sources and Editorial Decisions

Research snapshot: 2026-10-06. These are primary references consulted, not dependencies to install or instructions to execute. The wording and cross-source synthesis here are original; no third-party skill or asset is bundled by this document. If future edits copy upstream material, review its applicable license and preserve required attribution/notices.

- **[S1] Impeccable:** [official site](https://impeccable.style/) and [upstream project](https://github.com/pbakaus/impeccable). Informs product context, preserving existing systems, focused refinement, visual alternatives, and separating critique from technical checks. Local installed skill versions can differ substantially from upstream; verify command availability rather than assuming it from this reference.
- **[S2] Anthropic:** [frontend-design skill](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md), read via its [raw source](https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md). Informs subject-specific art direction, purposeful typography, compact design planning, restraint, and self-critique. This is a skill, not a blanket description of every Claude Code output.
- **[S3] Anthropic:** [Claude Code best practices](https://code.claude.com/docs/en/best-practices). Informs explicit verification criteria, screenshots, evidence, and independent review; these are workflow practices rather than an aesthetic style.
- **[S4] OpenAI:** [Designing delightful frontends with GPT-5.4](https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4), including its published frontend-skill example, and [Frontend prompt instructions](https://developers.openai.com/api/docs/guides/frontend-prompt). Informs visual/content/interaction theses, strong subject imagery, working product surfaces, and rendered verification. These pages include model- and context-specific defaults, not universal UI standards.
- **[S5] OpenAI:** [Building frontend UIs with Codex and Figma](https://developers.openai.com/blog/building-frontend-uis-with-codex-and-figma). Informs using actual design context, existing components, and a design-to-code-to-review loop. Figma is optional, not required by this guide.
- **[S6] W3C WAI:** [Understanding Contrast (Minimum)](https://w3c.github.io/wcag/understanding/contrast-minimum.html). Supports the text-contrast thresholds and their exceptions.
- **[S7] W3C WAI:** [Understanding Target Size (Minimum)](https://w3c.github.io/wcag/understanding/target-size-minimum.html). Supports the WCAG 2.2 AA sizing/spacing guidance and exceptions. W3C's published-host requests were blocked during research; these are W3C's repository-hosted understanding pages.
- **[S8] web.dev:** [Web Vitals](https://web.dev/articles/vitals). Supports LCP/INP/CLS goals and the distinction between field and lab evidence.

**Resolve conflicts deliberately:** OpenAI's published examples favor full-bleed image-led brand pages and restrained apps; Anthropic allows a subject-led headline, demo, image, or interaction to lead; Impeccable emphasizes context and design-system fit. Their advice also differs on palettes, typography, motion, and cards. This synthesis adopts purpose, coherence, evidence, and craft, not absolute bans on fonts, hues, radii, white/black, gradients, or card shapes. Existing brand rules, honest content, accessibility, and the user's actual task are stronger constraints than any fashionable default.

**Maintenance contract:** Keep the reference self-contained, project-neutral, and bounded enough to return in one tool call. Maintain substantive topic sections, review checks, examples, attribution, and a real verification loop. Automated content tests detect regressions in coverage; they do not assess visual quality or substitute for human feedback.
