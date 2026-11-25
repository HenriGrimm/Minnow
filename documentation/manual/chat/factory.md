# Build a plan unattended with /factory

Open a Code chat in your workspace. You can start with an empty folder. If you already have a saved Build plan, choose **Run factory** on the plan card. You can also enter a plan path or describe what to build directly.

```text
/factory documentation/plans/csv-export.md
/factory Build a habit tracker with a weekly chart and CSV export
```

Factory initializes Git when needed. In a project with no commits, it keeps your `.gitignore` or creates a default one, then makes the first local commit from the project files Git includes. Minnow creates the thread’s worktree from that commit, or uses the current commit when the project already has history. Threads that already have a worktree reuse it. A plan selected from `documentation/plans/` is captured with the request, including edits you saved before committing. The source checkout keeps its current branch and local edits.

## Follow the run

The project’s **Source Control** opens on **Local**. Use **Show chat’s checkout** to inspect the Factory branch there. Inside the Factory thread, **Files** and **Diff** open its checkout, and new **Terminal** tabs start there. **Open workspace diff** shows the project checkout. Other Local threads and **New Thread** use the project folder.

Open **Factory** in the thread header to see the current phase, feature count, model and checkout. The lead turns the plan into a specification and commits acceptance checks before implementation. Minnow assigns one feature at a time to a builder in the thread worktree. It runs the checks, then the lead inspects the result and commits the checkpoint. At review checkpoints a separate reviewer inspects the changes. The lead records fixes and follow-ups in `factory/progress.json` and `factory/decisions.md`.

Each assignment has a card in the Factory chat. While the lead waits, the card shows the builder’s or reviewer’s status. Select the card to open its chat and follow its tool calls. Completed and stopped assignments stay in the lead chat when you reopen it. Expand the working transcript to inspect the commands Factory ran and their results.

After the final review, Minnow runs every distinct feature check, project gate and full-suite command. An independent verification turn assesses the specification and report on that commit. The final chat message contains the committed report, working directory, launch instructions, verification results and next steps. Review the branch in Source Control when you are ready to merge.

## Resume or stop

- Close the window or quit Minnow at any point. The local server resumes the run on startup from the same checkout and last committed checkpoint. It also checks for unfinished tool effects and outstanding agents.
- If the provider runs out of credit, select another model in the same thread. Factory uses it for the next turn. After replenishing the same account, choose **Resume factory**.
- **Pause factory** stops the run and its active agents. **Resume factory** continues it. **End factory** ends a paused run and keeps the files and commits.
- If permissions require approval or Minnow cannot establish whether an interrupted tool finished, open the request or recovery card in the thread. If the checkout moved, restore the original checkout so the run can resume.
- Older runs that started on a project branch continue in their original checkout. Open the existing thread to keep its checkpoint and any partial changes.
