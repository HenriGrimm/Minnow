# Modes

A mode changes two things at once: the instructions the model gets, and the tools that exist for that turn. It is the most consequential control in the composer, and it is one click.

The product defines several mode ids for prompts and tool policy. **Four** are in the composer strip on every chat surface. The others attach to a workflow (Orchestrate, onboarding) or exist only for legacy sessions and internal routing — you do not pick them from the strip.

## The four you choose

| Mode | Behaviour |
|------|-----------|
| **General** | Balanced assistant for questions and mixed work. Broad tools with your normal approval settings. The only composer mode that can read the Minnow manual. |
| **Build** | The development default. Files, git, terminal, code intelligence, language servers, sub-agents, browser automation, the task checklist. |
| **Plan** | Read and analyse. Can run shell commands to investigate and can write **plan documents**, but the mutating file and git tools are removed. |
| **Debug** | Investigation and triage. Everything Build has, plus local diagnostics, aimed at the Issues tracker. |

### What Plan mode actually blocks

Plan mode is the one people misunderstand, so it is worth being precise. Removed: `append_file`, `insert_at_line`, `replace_text_in_file`, `move_file`, `copy_file`, `delete_path`, all git writes, and settings changes. Kept: `save_file` and `make_directory`, restricted to plan documents under `documentation/plans/`. Also kept: shell execution, because planning genuinely needs to run a test or list a directory to be any good. **`issue_*` tools stay available** so a planning turn can search, file, update, and attach a plan to an Issues card — that is tracker state, not a repo edit.

So Plan can look anywhere and can run things, but it cannot rewrite your code. If you want a spec without touching the repo, this is the mode.

## Modes you enter (not on the strip)

| Mode | Where it comes from |
|------|---------------------|
| **Orchestrate** | The Orchestrate hub. Coordinates a board: reads code, delegates tasks, cannot spawn free-form sub-agents or write files itself. |
| **Onboarding** | First-run setup only. A deliberately safe demo set: no shell, no writes. |

Orchestrate has one deliberate asymmetry worth knowing: it can call `delegate_tasks` to start board work, but `spawn_sub_agent` is denied. Delegation on a board goes through the board, so the work is visible and recoverable, not hidden inside an unmanaged sub-agent.

## Tool access at a glance

Rough shape of what each composer mode can reach. "Read" means read-only variants; "write" means the mutating ones.

| Capability | General | Build | Plan | Debug |
|------------|:-------:|:-----:|:----:|:-----:|
| Files read | ● | ● | ● | ● |
| Files write | ● | ● | plans only | ● |
| Git read | ● | ● | ● | ● |
| Git write | ● | ● | ○ | ● |
| Shell / run code | ● | ● | ● | ● |
| Code intelligence, language servers | ● | ● | ● | ● |
| Web search and fetch | ● | ● | ● | ● |
| Browser automation | ● | ● | ● | ● |
| Brain (read and write) | ● | ● | ● | ● |
| Issues | ● | ● | ● | ● |
| Sub-agents | ● | ● | ● | ● |
| Settings | read + write | ○ | ○ | ○ |
| Diagnostics | ○ | ○ | ○ | ● |
| Minnow manual | ● | ○ | ○ | ○ |
| Task checklist (`todo_write`) | ○ | ● | ○ | ● |

Two entries surprise people:

- **Build cannot read the Minnow manual.** Developer modes keep a tighter payload budget; they read your repository and `documentation/context.md` directly instead. Ask product questions in General.
- **Only General can change settings** among the composer modes. Appearance tools are not in the composer modes at all — use **Settings** for theme and wallpaper. A coding agent should not be reconfiguring your app mid-task.

## Modes are a ceiling, not a grant

Mode allowlists and your permissions are two separate gates, and a tool must pass both:

1. The mode must allow the tool at all.
2. Your permission for it must be **Ask** or **Full**, not **Off**.

So turning a tool to Full does not make it available in Plan mode, and a mode allowing a tool does not skip your approval. See [Tools and permissions](tools-and-permissions.md).

MCP and plugin tools are the exception: they bypass the mode matrix and are gated by your permission settings only.

## Practical mode picking

| You are doing | Mode |
|---------------|------|
| Asking how something works, drafting text, general help | **General** |
| Implementing a feature in an open project | **Build** |
| Writing a spec or design you do not want acted on yet | **Plan** |
| Chasing a bug, reading logs, filing what you find | **Debug** |
| Turning a plan into parallel delivery work | **Orchestrate** board |
| A big ambiguous idea that needs interrogating first | **Plan** |

You can change mode mid-conversation; it takes effect from the next message. Board-managed chats are the exception — the orchestrator owns their mode and the selector is hidden, so a task agent cannot quietly escalate its own permissions.

## Related

- [Tools and permissions](tools-and-permissions.md)
- [Skills and slash commands](../chat/skills-and-commands.md)
- [Orchestrate boards](../orchestrate/boards.md)
