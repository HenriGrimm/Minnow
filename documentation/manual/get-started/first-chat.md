# Make and review your first change

Start with an open project folder and a [connected model](connect-a-model.md). Use a Git checkout if you want to follow the diff and commit steps. Pick a small, reversible task, such as correcting an instruction in the README. If you only want to look around, stop after the first prompt.

1. In Code, select **New thread** at the top of the thread list. Pick a model from the selector in the composer.
2. Send this prompt, adjusting the filename if needed.

   > /ask Read README.md and the project's scripts. How do I run the project and its tests? Cite the files you used.

   You should get commands grounded in files from this workspace. If the model gives generic instructions, ask it to show the file it read. If the model picker is empty, [check the connection](connect-a-model.md#when-the-picker-stays-empty).
3. Send a concrete follow-up such as “Compare the test command in README.md with the package scripts. If they differ, fix the README command only and tell me how you verified it.” Leave off **/ask** when you want edits.
4. If a tool approval appears, read the command or path and check the workspace. Choose **Allow once** for the intended action, or deny it and tell the agent what to do instead. See [Tools and permissions](../concepts/tools-and-permissions.md).
5. Open the **Side panel**. Select **+** if the panel already has tabs, then choose **Diff**. Select the changed file to inspect its patch. If **Diff** is unavailable, choose **Open workspace diff** beside it and check the selected checkout. Open **Terminal** to run the relevant check yourself.

For a change that needs a design decision first, start a turn with [**/plan**](../chat/skills-and-commands.md#workflow-skills). Keep distinct tasks in separate threads so their context and diffs are easy to find.
