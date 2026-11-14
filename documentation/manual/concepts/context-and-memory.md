# Give Minnow the context it needs

## Point to the evidence

Put the goal, expected outcome, and relevant file or error in the same prompt. Attach an image for a visual bug and include the route or steps that reproduce it. Open the thread card if you are unsure which checkout the prompt will use.

> In `src/search.ts`, find why the empty query returns every note. The expected result is an empty list. Add or update the test for an empty query, then run that test.

If the agent missed a constraint, send it again explicitly. The context indicator by the composer helps spot long threads. When old turns have been compacted, attach the precise file or quote the exact requirement you need preserved. For a clean start, open a new thread and hand over the goal, current status, and links.

## Keep decisions across threads

- Put project rules or build commands that teammates share into a versioned file such as `AGENTS.md`. Reference it in the prompt if the agent needs to act on a specific section.
- Save decisions you want to retrieve later in [Brain](../apps/brain.md). Ask for a concise title, the decision, and its source. Open the saved note to verify it.
- Use **Settings → AI and agents → Rules** for standing instructions. Use **Chat context** in the same group to control default project documents, Brain context, and code map context.

Before adding sensitive context, check the selected model and routing for supporting tasks. See [Privacy and security](../reference/privacy-and-security.md).
