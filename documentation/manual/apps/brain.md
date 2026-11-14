# Save and find project knowledge in Brain

Open **Brain** from the command palette. Use it for decisions or context you want to retrieve in a later thread.

## Save a decision and check it

1. Open **Edit** to create a page, or ask the agent to save a named page in Brain.
2. Include the decision, a reason, the scope (workspace or shared), and the source file or issue. For example, “Save a page titled *Export dates* for this workspace. Exports use UTC. Link the CSV contract and record that the UI continues to display local time.”
3. Find the page in **Graph** and read the body to verify the content and scope. Use **Assign to this workspace** when a page belongs with the current checkout.
4. In a later thread, ask for the page by name or ask the agent to search Brain and cite what it found. For an older conversation that already retrieved context, ask it to read the current page explicitly.

## Review suggestions and index code

- Check **Proposals** for suggested memories. Approve useful entries and correct or reject inaccurate ones. Use **Brain → Settings** to control synthesis and embeddings.
- Use **Ingest** to bring in a source. Review the pages produced before relying on them in later prompts.
- Open **Code** to inspect the workspace's index. Rebuild or refresh it if symbols are missing, then confirm the index belongs to the checkout you are investigating.
- Use **Lint** to generate a cleanup plan for stale pages or broken links. Read the proposed changes before running them.

For settings and operating instructions for Minnow itself, open the [Minnow manual](../reference/wiki-and-brain.md).
