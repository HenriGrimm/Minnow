# Give Minnow the context it needs

## Point to the evidence

Put the goal, expected outcome, and relevant file or error in the same prompt. Attach an image for a visual bug and include the route or steps that reproduce it. Open the thread card if you are unsure which checkout the prompt will use.

> In `src/search.ts`, find why the empty query returns every note. The expected result is an empty list. Add or update the test for an empty query, then run that test.

If the agent missed a constraint, send it again explicitly. The context indicator by the composer helps spot long threads. When old turns have been compacted, attach the precise file or quote the exact requirement you need preserved. For a clean start, open a new thread and hand over the goal, current status, and links.

## Keep decisions across threads

- Put project rules or build commands that teammates share into a versioned file such as `AGENTS.md`. Reference it in the prompt if the agent needs to act on a specific section.
- Agents keep a small [project memory](../apps/brain.md) of decisions, constraints, your preferences and verified gotchas. Nothing from it is added to your prompt; the agent searches memory with `memory_search` when the task calls for it. To make sure an earlier decision is used, say so: “Check memory for how we chose the export format.”
- To keep a decision, ask the agent to remember it, with the reason and its source. It saves one memory with `memory_save` and says so in one line. Review or correct memories in **Brain → Memories**.
- Use **Settings → AI and agents → Rules** for standing instructions. Use **Chat context** in the same group to control default project documents and code map context.

Before adding sensitive context, check the selected model and routing for supporting tasks. See [Privacy and security](../reference/privacy-and-security.md).
