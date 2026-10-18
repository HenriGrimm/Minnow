# One-click worktrees

## Interaction and scope

Chat composer: **Enable worktree** creates and prepares a checkout immediately.
The control reads **Setting up…**, then **Worktree** with the branch alongside it.
A separate options button retains Local, existing checkout, and custom-name actions.
Clicking Worktree returns to Local without deleting files. Enabling it again reuses the managed slot.

Issues: **Use worktree** is a pressed-state button beside Send to chat, remembered
per issue for this session. Selecting a mode launches directly with that choice;
there is no second run-target menu. Row menus expose the same preference.

Use existing fonts, theme tokens, buttons, and focus styles. The scene is a solo
developer working beside the editor in their chosen light or dark theme. No new
palette, modal, or decorative motion is needed.

## Implementation plan

1. Add an idempotent automatic server operation, serialized per managed chat slot.
   Generate a readable title slug with a stable chat suffix; allocate an unused
   branch rather than attaching someone else's branch. Start from workspace HEAD.
   Validate existing slots against Git registration and report their real branch.
2. Prepare dependencies using the existing worktree setup engine. Preserve failed
   checkouts for retry. Never run the chat in Local when requested setup fails.
3. Add an automatic shared run-target choice, prevent sends during setup, and
   attach only after successful preparation. Capture the originating chat/workspace.
4. Wire composer and issue controls, keep advanced composer choices available,
   and preserve managed worktrees when detaching.
5. Verify Git lifecycle, naming/collisions, retries, scoped requests, UI selection,
   type checking, and affected chat/issue suites. Update shipped documentation.

## Boundaries

Uncommitted files stay in the original checkout. No automatic stashing, commits,
merges, pushes, or destructive cleanup. Existing board isolation is unchanged.
Setup supports the dependency ecosystems already handled by Minnow; it does not
infer arbitrary project services or copy secrets.
