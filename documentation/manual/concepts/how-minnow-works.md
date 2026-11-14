# Choose where to work

When an instruction mentions a relative path like `src/app.ts`, the active workspace or thread checkout tells Minnow where to look. Check that location before the first edit.

| Situation | What to open |
| --- | --- |
| You want to try a prompt without giving it a real project | Select **Sandbox** in the workspace picker. |
| You need an agent to read or change an existing project | Open that folder as a workspace and start a thread there. |
| Two tasks need independent checkouts | Use a Git worktree, then verify its branch on the thread card. |
| You want to understand code before editing | Start the turn with **/ask**. |
| You want an implementation plan saved to the repo | Start with **/plan** and ask for a named file under `documentation/plans/`. |
| You need to follow a second question without interrupting a run | Open **Side chat** from the thread's surface launcher. |

The Minnow process on your computer runs tools and stores conversations. Your selected model determines where inference happens. Local models run on the machine hosting the runtime. A cloud model or connected cloud CLI receives the prompt and the context needed for the request. Check both the picker and any [routing overrides](../apps/models.md#routing) when that matters.

Continue with [Code](../apps/code.md), [permission controls](tools-and-permissions.md), or [what goes into a request](../reference/privacy-and-security.md).
