# Chat scrolling

The transcript uses native chronological DOM flow with incremental history paging. Code, shared Issues chats, board chats and embedded transcripts use a scroll controller per viewport in `src/ui/transcript-scroll.ts`. `chat-scroll.ts` resolves the active surface and connects its jump control and layout observer. It does not maintain a global follow flag.

## Scroll policies

- Opening a conversation shows the latest entries and fills a short transcript to the initial history buffer in scheduled slices. A stored entry can be a hidden tool result, so entry count alone does not indicate usable scroll distance.
- Scrolling upward releases follow immediately. Returning downward to the actual tail resumes it, including at the end of native scrolling. Programmatic writes do not install a timed guard that can discard the return gesture.
- New output and delayed image/Markdown layout follow only while pinned. Each viewport retains its own state, so an embedded transcript cannot unpin Code.
- A history page is inserted and grouped synchronously inside the controller's `preserve` operation. When reading history, it keeps an existing visible message at its previous offset. It measures that message rather than treating every change in total transcript height as content inserted above the reader. Measurements account for CSS zoom.
- The controller uses explicit instant scroll operations, and relative adjustments for prepends. CSS smooth scrolling and temporary style restoration do not participate in follow or pagination. The browser still handles wheel, keyboard, touch and scrollbar movement.
- The pager owns loading intent, the two-viewport buffer, 30-entry pages, six-millisecond construction slices, cancellation and visibility suspension. It delegates viewport adjustments to the controller.

## Approach and references

[TanStack Virtual's chat guide](https://tanstack.com/virtual/latest/docs/chat) describes stable keyed-message anchoring, conditional bottom follow and chronological scroll containers. [Virtuoso's message-list policies](https://virtuoso.dev/message-list/scroll-modifier/) distinguish prepending history, appending messages, content resizing and switching conversations. [Element's ScrollPanel notes](https://web-docs.element.dev/scrolling.html) document the problems with competing absolute scroll writes during native scrolling and its use of relative compensation.

Minnow applies those policies to its existing native DOM renderer. Virtualization is useful for limiting the number of mounted messages in very large conversations, but is not a drop-in scroll fix here: live tool owners, thoughts, work disclosures, sub-agent cards and message actions retain references to their mounted nodes. The current implementation pages history without recycling those nodes or introducing estimated spacer heights. The actual latest reply stays in the native scroll range.

## Verification

`test/ui/transcript-scroll.test.mjs` exercises visible-message anchoring, mixed growth above and below the reader, zoom conversion, viewport isolation and immediate direction reversal. `test/ui/chat-scroll.test.mjs` covers the public chat facade, follow, touch momentum and late layout changes. History chunking and chat-work suites cover settled Compact grouping and remounts.

`test/ui/transcript-scroll-browser.test.mjs` uses the repository's isolated browser driver and real transcript CSS. It sends native wheel input upward and then downward while paging is pending, at multiple zoom levels. It verifies that the final paragraph is visible above the composer, follow resumes, the jump control disappears, and clicking Jump to latest has no remaining distance to recover. It skips explicitly when no supported browser is installed; `MINNOW_BROWSER_PATH` can select an installed Chromium browser.
