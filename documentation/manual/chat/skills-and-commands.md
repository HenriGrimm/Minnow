# Use skills and slash commands

Type **/** at the start of an empty composer, then choose a skill or command from the menu. Continue with the exact task and relevant file or issue. Use the picker to see what is installed.

## Workflow skills

| Skill | Use it to | Example |
| --- | --- | --- |
| **/ask** | Investigate with a read-only turn | `/ask What invokes the newsletter job? Show the entry point and schedule.` |
| **/plan** | Save an implementation plan under `documentation/plans/` | `/plan Plan CSV export for filtered results. Save the steps and checks in documentation/plans/csv-export.md.` |
| **/debug** | Narrow down a failure with evidence | `/debug The first upload succeeds and the second returns 409. Start with the failing test and explain the cause before changing files.` |

A workflow skill applies to the turn. To build after reviewing a plan, send a normal prompt and reference the plan file, or open it in [Orchestrate](../orchestrate/boards.md) if it is structured for a board.

## Run a follow-up or compact a thread

- Use **/goal** when a thread needs to iterate toward a testable result. State the goal and what counts as success. Inspect each iteration and stop once you have the evidence you need.
- Use **/loop** to schedule a prompt in the current thread. Check the parsed interval and make sure the thread is available to run it. Use [Automations](../apps/scheduler.md) for a job with its own run history.
- Use **/followup** to add next steps to the thread. Check the command menu for the available options.
- Use **/compact** when you need to shorten a long conversation. Restate critical details from earlier messages if you need their exact wording.

## Install or write a skill

Open **Settings → Extensions → Skills Library** to install a collection or add a skill folder by GitHub URL. Open **Settings → Extensions → Skills** to manage installed skills. A custom skill is a folder with a `SKILL.md` file. Give it a description that says when to use it, clear steps, and the conditions for finishing. Test it in a fresh thread using a representative task.
