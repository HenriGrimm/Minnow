# Git activity overlay and parsed error popover

## Goal

Show in-flight feedback for git / GitHub actions, then replace raw error toasts with a parsed popover that includes **Send to chat**.

## Todos

- [x] Add `git-error-parse.ts` with classified title/summary/details and static fixture tests
- [x] Build floating progress overlay + error popover (bounce bar, dismiss, copy, Send to chat, reduced motion)
- [x] Add `runGitUiOp` and wire SCC, git panel, advanced/graph/merge, PR/checks, Issues GitHub sync
- [x] Expand `GitErrorChatKind` and seed builders for push/pull/pr/github/generic
- [x] Update `context.md`, `code.md` manual, overlay tests

## UX

- Floating bottom-center card (same family as toasts).
- Progress appears after ~180ms so instant local ops do not flash.
- Success still uses a short toast.
- Every git/GitHub **operation** failure opens the popover (validation copy stays as a toast).
- **Send to chat** starts a Build chat seeded with the parsed error (auto-run).

## Modules

- [`src/lib/git-error-parse.ts`](../../src/lib/git-error-parse.ts)
- [`src/ui/git-activity-overlay.ts`](../../src/ui/git-activity-overlay.ts)
- [`src/ui/git-ui-op.ts`](../../src/ui/git-ui-op.ts)
- [`src/ui/git-error-to-chat.ts`](../../src/ui/git-error-to-chat.ts)
