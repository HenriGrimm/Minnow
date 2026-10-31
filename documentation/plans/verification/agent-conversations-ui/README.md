# Agent conversation UI checks — 2026-10-30

Actual built Minnow SPA, served by the compiled in-process server. All chats,
providers, requests, files, and settings used a disposable `MINNOW_HOME` and
scratch project. No real model, paid API, live profile, or user browser tab was
used. Browser control used agent-browser over CDP to a dedicated system Chrome
with a scratch profile and the normal browser sandbox enabled.

The fixtures exercise presentation and human request receipts. They do not
establish real-provider or native-provider execution support. The production
workflow, storage, recovery, and tool tests cover those separate boundaries.

## Browser results

| Check | Observed result | Evidence |
| --- | --- | --- |
| Parent grouping and navigation | One group of three tasks, nested child chats, explicit parent links and Previous agents. Waiting agents do not count as running. | [Dark parent](parent-dark.png), [light parent](parent-light.png) |
| Question keyboard flow | Focus radio, Space selects, Tab focuses **Send answer**, Enter submits. **Answer saved** appears and the fixture execution settles. | [Question](question-dark.png), [answered](question-answered-dark.png) |
| Live approval | **Deny** saves the owning request answer, hides its actions, and the fixture execution settles. | [Denied approval](approval-denied-dark.png) |
| Inspect-only native history | Composer text, Send, microphone, model, mode and worktree controls are disabled. Parent remains reachable. | [Native history](native-inspect-dark.png) |
| Canonical activity versus drafts | Clean server rename was observed, canonical ACK advanced the chat revision, then a draft saved and survived sibling navigation without a conflict toast. Reload, reopening the same scratch workspace and child restored the exact saved draft. | [Reloaded draft](draft-reload-light.png) |
| Genuine other-viewer draft edit | The old presentation base remained unchanged. Save returned 409 with expected revision 2/current revision 3; local unsaved text and the other viewer's persisted text both remained intact. | [Conflict UI](genuine-conflict-light.png), [redacted receipt](genuine-conflict.json) |
| Phone layout and touch | At 390 × 844 CSS pixels, no horizontal document overflow. A documented `input_touch` gesture opened the intended child. | [Phone question](question-phone-light.png) |
| Theme and reduced motion | Actual `swamp-dark` body background `rgb(15, 18, 22)` and actual `swamp-light` background `rgb(247, 247, 244)` checked. Reduced-motion media query returned true. Desktop viewport: 1440 × 1000; tablet: 768 × 1024. | [Computed dark theme](theme-dark.txt), dark/light images above |
| Menu layering and keyboard | Model menu has `mn-occludes-preview` and `pointer-events: auto`. Escape restores focus to its trigger. | [Phone model menu](model-menu-phone-light.png) |
| Scoped accessibility | Axe 4.12.1 request-region check: 0 violations, 0 incomplete, 14 passes. This is a scoped check, not a whole-app accessibility certification. | [Axe result](request-a11y.json) |

The phone images were captured before the metadata-CAS correction; its changes
do not alter the normal question or menu layout. The dark parent, question,
answered question and denied approval images use the final built UI. Earlier
misnamed local screenshots were not copied into this evidence directory.

Actual Electron native-preview guest pausing was not exercised by the plain
browser fixture. The occlusion result verifies the menu marker, bounds, pointer
events and focus behavior, not a native guest's visibility.

## Automated regression check

The final focused batch passed **99/99**, exited normally, and used no force-exit:
presentation client, session persistence, shared live chat, activity client,
durable requests, navigation, composer drop/paste/voice, and code-change
backfill tests. Local log: `.minnow/w7-final-ui-regressions.log`.

The two tool-start-indicator-remount failures reproduced unchanged in the exact
HEAD archive after verifying the files exist in `git ls-tree HEAD`. They remain
baseline failures, separate from this UI batch.

## Cleanup

The owned fixture server and provider were stopped and their wrapper completed.
Both named QA browser sessions closed. The dedicated Chrome was stopped through
its retained process handle, after verifying its exact PID and executable path;
its owner shell completed. Loopback connection checks for ports 29475, 29476 and
29477 all returned `ECONNREFUSED`. Scratch files remain as evidence; no live
profile or workspace was removed.
