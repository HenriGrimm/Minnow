# Issues

A tracker that agents can use. Issues is a Linear-style list and board for work in your workspace, with the difference that the assistant can file, triage, expand and close items through tools — so "I found three problems while reading this" becomes three real cards instead of a paragraph you will lose.

Open it from the app rail for the fullscreen app, or from the Issues button in the Code sidebar rail to embed it beside your code.

## Views

- **List** — one dense row per issue, grouped (status by default). Click a column header to sort inside a group when ranks are equal or missing. **Alt+↑/↓** still writes a manual rank. Drag an issue onto another issue to make it a sub-issue. Click a status, priority, assignee, or project cell to edit it in place.
- **Board** — kanban lanes by status. Drop a card onto another card to nest it. Drop onto empty column space to change status. **Shift+←/→** moves the focused card across columns.
- **View → Needs review** — a saved view of issues that arrived from an agent, a crash, or GitHub and have not been reviewed yet. **Y** accepts (backlog), **N** or **Backspace** declines (canceled).
- **View → Agent work** shows issues with an assigned agent, including completed work. **My open issues** shows open issues assigned to you or left unassigned. **All issues** includes completed issues. Switching views resets the filter chips to that view’s defaults while keeping workspace scope and search. The filters below the selector refine the results.

## Working with issues

**Capture** with the quick-capture field in the header, or **New issue** (**C**) for the full form (title, type, priority, labels, description). When **Workspace scope** is **All workspaces**, the new-issue form includes a **Workspace** picker (Scratch plus recent folders). New issues start in **Backlog**. **Expand** uses the fields you have entered to suggest a title, description, labels, and priority directly in the form. Review or edit the proposal, then select **Create**.

The menubar capture button and **Ctrl/Cmd + I** open the same full form over your current app. **Expand and Create** saves the issue and closes the form, then expands its title, description, type, priority, and labels in the background. You can keep working or create another issue while it runs. Fields you edit on the saved issue are preserved; if expansion fails, the original issue remains saved.

**Select** several rows with **Ctrl/Cmd+click**, or a range with **Shift+click**. The selection bar can change status, priority, assignee, labels, and project, or delete. **Shift+F10** or right-click opens the row menu: new issue, open, copy ID, expand, add a sub-issue, remove from parent, send to chat, status, priority, type, assignee, project, labels, and delete. Linked issues also offer **Open in GitHub**. Code's files toolbar has an **Issues** pane with quick capture and the same menu; **View** opens the issue inside that pane and **Edit in Issues** opens it here.

Right-click blank space in the list or board for **Filters** (type, status, priority, project, and show/hide done) and **New issue**. New issue opens the full form for you to fill in; it does not copy the clicked issue or column.

The **Created** column shows issue age, such as **1hr**, **3 days**, or **1 month**. Hover for the exact creation time; select the column heading to sort by creation time.

**j** / **k** (or the arrows) move the focused row. **Enter** opens the peek panel for the description and history — you do not need peek to change a field. Drag the peek's left edge to widen it (remembered per workspace). The header control next to Close opens a larger centered sheet over the list; click the dim area, Restore, or Escape to return to the docked peek. The peek **Sub-issues** section lists children: **New** creates one from a title, **Existing** attaches another issue, and **Remove** unparents without deleting. A child peek shows a Parent chip that opens the parent. **Chats** lists sessions started or attached from the issue (title, Running or Done, mode). Open jumps to that chat in Code. A board tied to the issue or to one of those chats is a sibling row. **New** starts a General chat the same way Send to chat does; **Existing** attaches a session you already have. **Remove** unlinks only.

**Edit** labels inline on the row: up to three chips stay visible, a caret opens the rest, and **+** opens a typeahead. Type a name and press **Enter** (or comma) to add it; the popover stays open so you can add more. Click away or press **Escape** when you are done. The chip **×** removes it from that issue. Right-click a chip to pick a color; that color applies to every issue with the same name.

The peek keeps identity, type/status/priority chips, labels, and Send to chat pinned. The description is the page. Empty code links, attachments, and git collapse to one add row each; Plan and Related appear only when they have something to show. Sub-issues and Chats stay visible so you can add a child or attach a session on an empty card. The more menu next to Close holds **Copy issue** — the whole card as Markdown (fields, description, notes, code and git links, related issues, sub-issues, attachments, and comments) for pasting elsewhere — plus sub-issue actions and Delete.

Label suggestions come from issues in the same workspace, including completed issues. In **All workspaces**, each issue keeps its own workspace's suggestions; a new issue uses the destination selected in its **Workspace** picker. **Expand** uses the same workspace label suggestions.

List rows, board cards, and the peek header show **GitHub · Needs push** for local changes awaiting sync and **GitHub · Conflict** for known sync conflicts. With **Two-way mirror** enabled, unlinked issues show **GitHub · Not synced**. These indicators use the last sync watermark; changes made on GitHub are checked when synchronization runs.

Drop or paste images into the description to include visual context, including while creating a new issue. Images are stored locally and shown inline. Agents receive those images when they read the issue description or attachments.

Type in the description to edit it. The formatting toolbar appears while the description is focused. **Ctrl/Cmd+Enter** commits; **Escape** commits and lets the panel close.

Nested lists, HTML, and other blocks outside the rich-text format show an **Edit source** field. Type directly in that field to change the Markdown or HTML. Changes save when you leave the description or submit the issue, and untouched blocks keep their original formatting.

**Projects** group and filter issues inside this app. They are not Orchestrator boards. The Group control can bucket the list by project, and each project shows a closed/open count.

Agents can link related, blocking, or duplicate issues with `issue_link`; those links appear under **Related issues** in the detail panel. Parent and child cards use `parentId` (peek Sub-issues, list nesting, and the Sub column), not Related.

## Handing an issue to an agent

This is what the app is for.

| Action | What happens |
|--------|--------------|
| **Expand** | Sparkles on peek, board cards, the row menu, or **E**. Rewrites the title and description and suggests labels and priority from what is already on the card. You review and edit in an overlay; nothing is saved until you apply. Uses the prompt expander model when one is set. |
| **Expand with agent** | An agent researches the workspace and fills in a real description (triage notes), from the detail panel or the row menu |
| **Send to chat** | Opens a chat seeded with the issue, in a mode you choose, then the same run-target panel as the composer: the current workspace shown by name, an existing worktree, or New worktree |
| **Send to board** | When the issue has a plan, hands it to an orchestrate board |
| **Open plan** | Opens the issue's plan document in the editor |

Activity chips in the detail header are live; clicking one opens the agent drawer or board chat behind it.

**General**, **Build**, **Plan**, and **Debug** all expose `issue_*` tools. Debug also has local diagnostics. Plan can file, update, and attach a plan path to a card; it still cannot edit application code.

## Git conventions

Issues have workspace-specific ids like `MIN-12` (configure the prefix under **Settings → Apps → Issues → Issue IDs**). Legacy `ISS-*` ids still work. Minnow uses the id on each card consistently:

- Branch: `issue/<id>-<slug>` (slug derived from title)
- Commits are found by searching for `[MIN-12]` (or your key)
- Plans live at `documentation/plans/issues/<id>.md`
- Pull requests go through the `gh` CLI when it is installed, with GitHub links appearing on the issue
- **Review PR** (when `gh` is available and a PR can be resolved) runs an in-app reviewer and shows the verdict on the issue. Reviews are not posted to GitHub.
- **GitHub sync** (Settings → Apps → Issues → GitHub) is **Off** or **Two-way mirror**. When it is on, the Issues header shows **Sync all** to import missing open and closed GitHub issues into Triage, push unlinked cards, and sync linked issues in one pass — scoped to the **Workspace scope** control (current workspace vs all workspaces). The peek Git section can also push a new issue, sync a linked one, and import open GitHub issues into Triage. **Sync automatically** (under Two-way mirror) pushes title, description, labels, type, priority, status, project assignment, sub-issue parent links, and comments as they change, creates a GitHub issue when you add a local issue or edit those fields on an unlinked card, and checks GitHub every 5 minutes while Minnow is running — including in the background. It does not backfill every unlinked card when you turn it on. Labels sync **by name**; if a name is not in the GitHub repo yet, Minnow creates it. Chip colors stay in Minnow. **Open** uses your system browser, not the in-app browser. If both sides changed since the last sync, the most recent change to the synced fields wins automatically; equal timestamps use GitHub. Successful background sync stays quiet. Changes to local-only fields such as rank, assignee, or chat links do not show **Needs push**.

Minnow stores its categorization and comment timeline in a versioned HTML comment at the end of the GitHub issue body. Importing on another machine restores custom taxonomy entries, projects, and comments without adding the metadata to the visible description. These fields use Minnow metadata, rather than GitHub native issue types, Projects fields, sub-issue relationships, or discussion comments. Keep the metadata block when editing the body on GitHub. GitHub open/closed changes still control whether an issue is closed. Sync parents before children; **Sync all** imports missing issues before syncing existing cards and syncs parents first. When syncing an individual child, import its missing parent first. Bodies over 65,536 characters report an error instead of being truncated.

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
