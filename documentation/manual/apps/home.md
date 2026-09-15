# Home

Home is your project overview. Open it from the app rail to resume chats and boards, review repository changes, and see issues and recent files for the selected workspace.

## Pick up your work

**Needs attention** brings together pending chat questions, board tasks needing attention, failed board final checks, issue-agent failures, and merge conflicts. Select a row to open the work that needs you.

**Continue working** lists recent chats and boards. Running chats show their current phase; boards show merged tasks and progress. **New chat**, **New board**, and **Open Code** start or resume work in Code.

**Repository** shows the current branch, ahead/behind counts, changed files, and tracked line additions/deletions, including staged changes. Untracked files appear in the file count; their lines are excluded from the totals. **Review changes** opens Source Control.

**Issues**, **Recent files**, **Scheduled work**, and **Project resources** open the corresponding project records, files, jobs, Brain, and model usage. Jobs without this project's explicit workspace are excluded.

## AI code edits

The calendar shows recorded AI additions plus deletions over the past 12 months or 90 days. Filter by **All AI**, **Completions**, or **Agent**. Select a day for its recent recorded edits, file links, and chat links when available. Use arrow keys to move through the calendar, or expand **Daily activity list**.

- **Completions** counts accepted inline suggestions, including partial accepts.
- **Agent** counts applied file-tool edits from chats and agents, accepted Quick Edit replacements, and accepted intent proposals.
- Editor suggestions count when accepted into the buffer. Saving the buffer does not count again.
- Shell-command changes, external editor changes, and git commits are excluded. Linked Git worktrees share the project's history.

This is editing activity, not net code growth or a productivity score. Repeated edits can count repeatedly. Days use UTC. Streaks cover the selected period; a current streak stays active until the end of today.

**Tracking since** marks the start of recorded history. Dotted cells indicate dates before tracking began; empty filled cells indicate tracked days with zero edits. Git history is not used to infer AI authorship. Activity stays locally under the Minnow data directory. File links can fail if a file or its worktree has since been removed.

## Refresh and availability

Project summaries refresh while Home is visible. Code activity refreshes every 30 seconds. **Refresh** reloads the page's data immediately. If a section cannot refresh, its last successful content stays visible with a retry message.

**Switch project** opens the workspace picker. Home scopes its lists to the chosen project; restored app destinations stay intact on reload.
