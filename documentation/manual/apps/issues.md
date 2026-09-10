# Issues

A tracker that agents can use. Issues is a Linear-style list and board for work in your workspace, with the difference that the assistant can file, triage, expand and close items through tools — so "I found three problems while reading this" becomes three real cards instead of a paragraph you will lose.

Open it from the app rail for the fullscreen app, or from the Issues button in the Code sidebar rail to embed it beside your code.

## Views

- **List** — one dense row per issue, grouped (status by default). Click a column header to sort inside a group when ranks are equal or missing. **Alt+↑/↓** still writes a manual rank. Drag an issue onto another issue to make it a sub-issue. Click a status, priority, assignee, or project cell to edit it in place.
- **Board** — kanban lanes by status. Drop a card onto another card to nest it. Drop onto empty column space to change status. **Shift+←/→** moves the focused card across columns.
- **Triage** — a saved view of issues that arrived from an agent, a crash, or GitHub and have not been reviewed yet. **Y** accepts (backlog), **N** or **Backspace** declines (canceled).
- **Assigned to agents** / **My open** — the other built-in tabs. Hide-done is a chip under the tabs.

## Working with issues

**Capture** with the quick-capture field in the header, or **New issue** (**C**) for the full form (title, type, priority, labels, description). When **Workspace scope** is **All workspaces**, the new-issue form includes a **Workspace** picker (Scratch plus recent folders). New issues start in **Backlog**. **Expand** uses the fields you have entered to suggest a title, description, labels, and priority directly in the form. Review or edit the proposal, then select **Create**.

**Select** several rows with **Ctrl/Cmd+click**, or a range with **Shift+click**. The selection bar can change status, priority, assignee, labels, and project, or delete. **Shift+F10** or right-click opens the row menu: open, copy ID, expand, add a sub-issue, remove from parent, send to chat or a background agent, change status, delete.

The **Created** column shows issue age, such as **1hr**, **3 days**, or **1 month**. Hover for the exact creation time; select the column heading to sort by creation time.

**j** / **k** (or the arrows) move the focused row. **Enter** opens the peek panel for the description and history — you do not need peek to change a field. Drag the peek's left edge to widen it (remembered per workspace). The header control next to Close opens a larger centered sheet over the list; click the dim area, Restore, or Escape to return to the docked peek. The peek **Sub-issues** section lists children: **New** creates one from a title, **Existing** attaches another issue, and **Remove** unparents without deleting. A child peek shows a Parent chip that opens the parent. **Chats** lists sessions started or attached from the issue (title, Running or Done, mode). Open jumps to that chat in Code. A board tied to the issue or to one of those chats is a sibling row. **New** starts a General chat the same way Send to chat does; **Existing** attaches a session you already have. **Remove** unlinks only.

**Edit** labels inline on the row: up to three chips stay visible, a caret opens the rest, and **+** opens a typeahead. Type a name and press **Enter** (or comma) to add it; the popover stays open so you can add more. Click away or press **Escape** when you are done. The chip **×** removes it from that issue. Right-click a chip to pick a color; that color applies to every issue with the same name.

The peek keeps identity, type/status/priority chips, labels, and Send to chat pinned. The description is the page. Empty code links, attachments, and git collapse to one add row each; Plan and Related appear only when they have something to show. Sub-issues and Chats stay visible so you can add a child or attach a session on an empty card. Delete lives under the more menu next to Close.

Drop or paste images into the description to include visual context, including while creating a new issue. Images are stored locally and shown inline. Agents receive those images when they read the issue description or attachments.

Type in the description to edit it. The formatting toolbar appears while the description is focused. **Ctrl/Cmd+Enter** commits; **Escape** commits and lets the panel close.

**Projects** group and filter issues inside this app. They are not Orchestrator boards. The Group control can bucket the list by project, and each project shows a closed/open count.

Agents can link related, blocking, or duplicate issues with `issue_link`; those links appear under **Related issues** in the detail panel. Parent and child cards use `parentId` (peek Sub-issues, list nesting, and the Sub column), not Related.

## Handing an issue to an agent

This is what the app is for.

| Action | What happens |
|--------|--------------|
| **Expand** | Sparkles on peek, board cards, the row menu, or **E**. Rewrites the title and description and suggests labels and priority from what is already on the card. You review and edit in an overlay; nothing is saved until you apply. Uses the prompt expander model when one is set. |
| **Expand with agent** | An agent researches the workspace and fills in a real description (triage notes), from the detail panel or the row menu |
| **Send to chat** | Opens a chat seeded with the issue, in a mode you choose, then the same run-target panel as the composer: This PC, an existing worktree, or New worktree |
| **Send to background** | Runs it as a background sub-agent instead of taking over your screen. Same worktree choice as Send to chat |
| **Send to board** | When the issue has a plan, hands it to an orchestrate board |
| **Open plan** | Opens the issue's plan document in the editor |

Activity chips in the detail header — **Investigating…**, **Planning…** — are live, and clicking one opens the agent drawer or board chat behind it.

**General**, **Build**, **Plan**, and **Debug** all expose `issue_*` tools. Debug also has local diagnostics. Plan can file, update, and attach a plan path to a card; it still cannot edit application code.

## Git conventions

Issues have workspace-specific ids like `MIN-12` (configure the prefix under **Settings → Apps → Issues → Issue IDs**). Legacy `ISS-*` ids still work. Minnow uses the id on each card consistently:

- Branch: `issue/<id>-<slug>` (slug derived from title)
- Commits are found by searching for `[MIN-12]` (or your key)
- Plans live at `documentation/plans/issues/<id>.md`
- Pull requests go through the `gh` CLI when it is installed, with GitHub links appearing on the issue
- **Review PR** (when `gh` is available and a PR can be resolved) runs an in-app reviewer and shows the verdict on the issue. Reviews are not posted to GitHub.
- **GitHub sync** (Settings → Apps → Issues → GitHub) is **Off** or **Two-way mirror**. When it is on, the Issues header shows **Sync all** to push unlinked cards and sync linked issues in one pass — scoped to the **Workspace scope** control (current workspace vs all workspaces). The peek Git section can also push a new issue, sync a linked one, and import open GitHub issues into Triage. **Sync automatically** (under Two-way mirror) pushes title, description, labels, and closed-state as they change, creates a GitHub issue the first time those fields change on an unlinked card, and checks GitHub every 5 minutes while Minnow is running — including in the background. It does not backfill every unlinked card when you turn it on. Labels sync **by name**; if a name is not in the GitHub repo yet, Minnow creates it. Chip colors stay in Minnow. **Open** uses your system browser, not the in-app browser. If both sides changed since the last sync, the most recent change to the synced fields wins automatically; equal timestamps use GitHub. Successful background sync stays quiet. Changes to local-only fields such as priority or chat links do not show **Needs push**.

Deleting a linked issue asks whether to remove the GitHub issue too. **Local only** keeps GitHub unchanged; **Delete everywhere** removes the GitHub issue first and then the local card. Check **Remember** to reuse either choice. Turn **Ask before deleting linked issues** back on under Settings → Apps → Issues → GitHub to restore the prompt.

When a board finishes work on an issue, the issue moves to **review** rather than closing itself.

## Taxonomy

**Settings → Apps → Issues** defines your **project key** (new auto-ids) and your types, statuses and priorities.

Statuses carry semantic roles and flags: which lanes appear on the board, and which count as closed, so workflows can resolve "the triage status" without hard-coding your names. Types and statuses each have an icon you pick in that table (same Flaticon set). Types also have a color swatch — built-in kinds (bug, task, idea, note, feature, improvement) start with distinct colors, and **Add type** picks the next unused swatch so new kinds are not grey. Status chips show the icon next to the name. You can delete an entry only when nothing references it.

Keep the taxonomy small. Humans and agents share this vocabulary, and every extra status is another thing for both to get wrong.

## Automatic bug filing

**Settings → Advanced → Health & diagnostics → File renderer errors to Issues** turns uncaught interface errors into bug cards automatically. It is **off** by default. Errors are logged locally and visible in the diagnostics viewer either way.

## Related

- [Modes](../concepts/modes.md)
- [Code app](code.md)
- [Orchestrate boards](../orchestrate/boards.md)

When Issues is open in a separate window, **Send to chat**, linked chats, plans, and files open in the Code window for that workspace. **Files** opens the workspace file tree inside Issues.
