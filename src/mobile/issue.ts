/** One issue: properties, description, agent work, linked chats, sub-issues and comments. */

import {
  addIssueComment,
  deleteIssue,
  findIssueById,
  listIssues,
  scheduleSaveIssues,
  updateIssue,
} from '../state/issues-store';
import { subscribeIssuesChanges } from '../state/issues-events';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import { findPriority, findStatus, findType, isClosedStatus, sortedPriorities, sortedStatuses, sortedTypes } from '../issues/taxonomy';
import { resolveIssuePriorityIcon, resolveIssueStatusIcon, resolveIssueTypeIcon } from '../issues/type-icons';
import { setAssistantBubbleContent } from '../markdown/renderer';
import { sessionState } from '../state/sessions';
import type { IssueCard, IssueComment } from '../types';
import { screenHeader } from './chrome';
import { el, emptyState, haptic, icon, iconButton, shortTime } from './dom';
import { agentBadge, labelChip, priorityGlyph, statusGlyph, typeGlyph } from './issues';
import { popScreen, type MobileScreen } from './nav';
import { confirmSheet, openActionSheet, pickFromSheet, promptSheet } from './sheet';

export interface IssueScreenDeps {
  openChat(chatId: string): void;
  openIssue(issueId: string): void;
  openFile(path: string): void;
}

async function toast(message: string, variant: 'success' | 'error' = 'success'): Promise<void> {
  const { showToast } = await import('../ui/toast');
  showToast(message, variant);
}

function save(issueId: string, patch: Parameters<typeof updateIssue>[1]): void {
  updateIssue(issueId, patch);
  scheduleSaveIssues();
  haptic();
}

function propRow(label: string, value: HTMLElement, onClick?: () => void): HTMLElement {
  const content = [el('span', { className: 'm-prop__label', text: label }), el('span', { className: 'm-prop__value' }, value)];
  if (!onClick) return el('div', { className: 'm-prop' }, ...content);
  return el(
    'button',
    { className: 'm-prop m-prop--button', attrs: { type: 'button' }, on: { click: onClick } },
    ...content,
    icon('fi-rr-angle-small-right', 16),
  );
}

function withText(glyph: HTMLElement, text: string): HTMLElement {
  return el('span', { className: 'm-inline' }, glyph, el('span', { text }));
}

function commentNode(comment: IssueComment): HTMLElement {
  const bodyNode = el('div', { className: 'm-md' });
  setAssistantBubbleContent(bodyNode, comment.body);
  const author = comment.authorKind === 'user' ? (comment.author || 'You') : comment.authorKind === 'agent' ? (comment.author || 'Agent') : 'Minnow';
  return el(
    'article',
    { className: `m-comment m-comment--${comment.authorKind}` },
    el(
      'header',
      { className: 'm-comment__head' },
      el('span', { className: 'm-comment__author', text: author }),
      el('span', { className: 'm-comment__time', text: shortTime(comment.createdAt) }),
    ),
    bodyNode,
  );
}

export function createIssueScreen(issueId: string, deps: IssueScreenDeps): MobileScreen {
  const header = screenHeader({
    title: issueId,
    back: true,
    actions: [iconButton('fi-rr-menu-dots-vertical', 'Issue actions', () => openMenu())],
  });
  const content = el('div', { className: 'm-issue' });
  const body = el('div', { className: 'm-screen__body' }, content);
  const commentInput = el('textarea', {
    className: 'm-composer__input',
    attrs: { rows: 1, placeholder: 'Add a comment', 'aria-label': 'Add a comment', enterkeyhint: 'send' },
  });
  const commentSend = el(
    'button',
    { className: 'm-composer__send', attrs: { type: 'submit', 'aria-label': 'Post comment', disabled: true } },
    icon('fi-rr-paper-plane', 16),
  );
  const commentForm = el('form', { className: 'm-composer' }, commentInput, commentSend);
  const root = el('section', { className: 'm-screen m-issue-screen', dataset: { screen: `issue:${issueId}` } }, header.el, body, commentForm);
  let visible = false;
  let frame = 0;

  commentInput.addEventListener('input', () => {
    commentSend.disabled = !commentInput.value.trim();
    commentInput.style.height = 'auto';
    commentInput.style.height = `${Math.min(commentInput.scrollHeight, 160)}px`;
  });
  commentForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = commentInput.value.trim();
    if (!text) return;
    if (addIssueComment(issueId, { body: text, authorKind: 'user' })) {
      scheduleSaveIssues();
      commentInput.value = '';
      commentInput.style.height = '';
      commentSend.disabled = true;
      haptic();
      requestAnimationFrame(() => {
        body.scrollTop = body.scrollHeight;
      });
    }
  });

  async function startWork(issue: IssueCard): Promise<void> {
    const mode = await pickFromSheet('Work on this issue', [
      { value: 'build' as const, label: 'Build', description: 'An agent implements it in this workspace.', glyph: 'fi-sr-hammer' },
      { value: 'plan' as const, label: 'Plan', description: 'Write a plan first, without changing code.', glyph: 'fi-sr-clipboard-list' },
      { value: 'debug' as const, label: 'Debug', description: 'Investigate the cause before fixing.', glyph: 'fi-sr-bug' },
      { value: 'general' as const, label: 'Discuss', description: 'Talk it through in a chat.', glyph: 'fi-sr-comment-dots' },
    ]);
    if (!mode) return;
    const { runIssueWorkspaceChat } = await import('../chat/issues/workspace-chat');
    const result = await runIssueWorkspaceChat(issue.id, mode);
    if (!result.ok) {
      void toast(result.error ?? 'Could not start', 'error');
      if (result.chatId) deps.openChat(result.chatId);
      return;
    }
    if (result.chatId) deps.openChat(result.chatId);
  }

  function render(): void {
    frame = 0;
    const issue = findIssueById(issueId);
    if (!issue) {
      content.replaceChildren(emptyState({ glyph: 'fi-rr-ticket', title: 'This issue is gone', body: 'It was deleted or moved.' }));
      commentForm.hidden = true;
      return;
    }
    commentForm.hidden = false;
    const taxonomy = getIssuesTaxonomySync();
    const status = findStatus(taxonomy, issue.status);
    const priority = findPriority(taxonomy, issue.priority);
    const type = findType(taxonomy, issue.type);
    const closed = isClosedStatus(taxonomy, issue.status);
    header.setTitle(issue.id);
    header.setSubtitle(status?.label ?? issue.status);

    const nodes: (HTMLElement | null)[] = [];
    nodes.push(
      el(
        'button',
        {
          className: 'm-issue__title',
          attrs: { type: 'button', 'aria-label': 'Edit title' },
          on: {
            click: async () => {
              const next = await promptSheet({ title: 'Title', value: issue.title, confirmLabel: 'Save' });
              if (next && next !== issue.title) save(issue.id, { title: next });
            },
          },
        },
        typeGlyph(issue),
        el('span', { text: issue.title || 'Untitled' }),
      ),
    );

    nodes.push(
      el(
        'div',
        { className: 'm-props' },
        propRow('Status', withText(statusGlyph(issue.status), status?.label ?? issue.status), async () => {
          const next = await pickFromSheet('Status', sortedStatuses(taxonomy).map((item) => ({
            value: item.id, label: item.label, glyph: resolveIssueStatusIcon(item.id, item), selected: item.id === issue.status,
          })));
          if (next && next !== issue.status) save(issue.id, { status: next });
        }),
        propRow('Priority', withText(priorityGlyph(issue.priority), priority?.label ?? issue.priority), async () => {
          const next = await pickFromSheet('Priority', sortedPriorities(taxonomy).map((item) => ({
            value: item.id, label: item.label, glyph: resolveIssuePriorityIcon(item.id, item), selected: item.id === issue.priority,
          })));
          if (next && next !== issue.priority) save(issue.id, { priority: next });
        }),
        propRow('Type', withText(icon(resolveIssueTypeIcon(issue.type, type), 14), type?.label ?? issue.type), async () => {
          const next = await pickFromSheet('Type', sortedTypes(taxonomy).map((item) => ({
            value: item.id, label: item.label, glyph: resolveIssueTypeIcon(item.id, item), selected: item.id === issue.type,
          })));
          if (next && next !== issue.type) save(issue.id, { type: next });
        }),
        issue.labels.length
          ? propRow('Labels', el('span', { className: 'm-chip-row' }, ...issue.labels.map(labelChip)))
          : null,
        issue.assignee ? propRow('Assignee', el('span', { text: issue.assignee.label ?? 'You' })) : null,
        issue.planPath ? propRow('Plan', el('span', { className: 'm-mono', text: issue.planPath }), () => deps.openFile(issue.planPath!)) : null,
      ),
    );

    // Agent work
    const agent = issue.agent;
    if (agent && !['done', 'canceled'].includes(agent.phase)) {
      nodes.push(
        el(
          'section',
          { className: 'm-card m-agent-card' },
          el('div', { className: 'm-agent-card__top' }, icon('fi-rr-user-robot', 16), agentBadge(issue), el('span', { className: 'm-muted', text: shortTime(agent.updatedAt) })),
          agent.step ? el('p', { className: 'm-agent-card__step', text: agent.step }) : null,
          agent.error ? el('p', { className: 'm-error', text: agent.error }) : null,
          agent.chatId
            ? el('button', { className: 'm-btn m-btn--block', attrs: { type: 'button' }, on: { click: () => deps.openChat(agent.chatId!) } }, icon('fi-rr-comment', 16), el('span', { text: 'Open agent chat' }))
            : null,
          agent.prUrl
            ? el('a', { className: 'm-btn m-btn--block', attrs: { href: agent.prUrl, target: '_blank', rel: 'noopener noreferrer' } }, icon('fi-rr-code-pull-request', 16), el('span', { text: `Pull request #${agent.prNumber ?? ''}` }))
            : null,
        ),
      );
    } else if (!closed) {
      nodes.push(
        el(
          'button',
          { className: 'm-btn m-btn--primary m-btn--block m-issue__start', attrs: { type: 'button' }, on: { click: () => void startWork(issue) } },
          icon('fi-rr-play', 16),
          el('span', { text: 'Work on this' }),
        ),
      );
    }

    // Description
    const description = el('div', { className: 'm-md m-issue__description' });
    if (issue.description.trim()) setAssistantBubbleContent(description, issue.description);
    else description.append(el('p', { className: 'm-muted', text: 'No description.' }));
    nodes.push(
      el(
        'section',
        { className: 'm-issue__section' },
        el(
          'div',
          { className: 'm-section-head' },
          el('h2', { className: 'm-section-label', text: 'Description' }),
          el('button', {
            className: 'm-link-btn',
            text: 'Edit',
            attrs: { type: 'button' },
            on: {
              click: async () => {
                const next = await promptSheet({ title: 'Description', value: issue.description, confirmLabel: 'Save', multiline: true });
                if (next != null && next !== issue.description) save(issue.id, { description: next });
              },
            },
          }),
        ),
        description,
      ),
    );

    // Sub-issues
    const children = listIssues().filter((child) => child.parentId === issue.id);
    if (children.length || issue.parentId) {
      const rows: HTMLElement[] = [];
      if (issue.parentId) {
        const parent = findIssueById(issue.parentId);
        rows.push(
          el('button', { className: 'm-link-row', attrs: { type: 'button' }, on: { click: () => deps.openIssue(issue.parentId!) } },
            icon('fi-rr-arrow-turn-down-right', 14),
            el('span', { className: 'm-mono', text: issue.parentId }),
            el('span', { className: 'm-link-row__text', text: parent?.title ?? 'Parent issue' }),
          ),
        );
      }
      for (const child of children) {
        rows.push(
          el('button', { className: 'm-link-row', attrs: { type: 'button' }, on: { click: () => deps.openIssue(child.id) } },
            statusGlyph(child.status, 12),
            el('span', { className: 'm-mono', text: child.id }),
            el('span', { className: 'm-link-row__text', text: child.title }),
          ),
        );
      }
      nodes.push(el('section', { className: 'm-issue__section' }, el('h2', { className: 'm-section-label', text: children.length ? `Sub-issues · ${children.length}` : 'Parent' }), ...rows));
    }

    // Linked chats
    const chatIds = [...new Set([...(issue.chatIds ?? []), issue.boardChatId].filter((id): id is string => Boolean(id)))];
    const chats = chatIds
      .map((id) => sessionState?.chats.find((chat) => chat.id === id))
      .filter((chat): chat is NonNullable<typeof chat> => Boolean(chat));
    if (chats.length) {
      nodes.push(
        el(
          'section',
          { className: 'm-issue__section' },
          el('h2', { className: 'm-section-label', text: 'Chats' }),
          ...chats.map((chat) =>
            el('button', { className: 'm-link-row', attrs: { type: 'button' }, on: { click: () => deps.openChat(chat.id) } },
              icon('fi-rr-comment', 14),
              el('span', { className: 'm-link-row__text', text: chat.name || 'Chat' }),
              el('span', { className: 'm-muted', text: shortTime(chat.lastMessageAt ?? chat.updatedAt) }),
            ),
          ),
        ),
      );
    }

    // Code references
    if (issue.codeRefs?.length) {
      nodes.push(
        el(
          'section',
          { className: 'm-issue__section' },
          el('h2', { className: 'm-section-label', text: 'Code' }),
          ...issue.codeRefs.map((ref) =>
            el('button', { className: 'm-link-row', attrs: { type: 'button' }, on: { click: () => deps.openFile(ref.path) } },
              icon('fi-rr-document', 14),
              el('span', { className: 'm-link-row__text m-mono', text: ref.startLine ? `${ref.path}:${ref.startLine}` : ref.path }),
            ),
          ),
        ),
      );
    }

    // Comments
    const comments = issue.comments ?? [];
    nodes.push(
      el(
        'section',
        { className: 'm-issue__section m-comments' },
        el('h2', { className: 'm-section-label', text: comments.length ? `Comments · ${comments.length}` : 'Comments' }),
        ...(comments.length ? comments.map(commentNode) : [el('p', { className: 'm-muted', text: 'No comments yet.' })]),
      ),
    );
    nodes.push(el('p', { className: 'm-issue__footer', text: `Created ${new Date(issue.createdAt).toLocaleString()} · updated ${shortTime(issue.updatedAt)}` }));
    content.replaceChildren(...nodes.filter((node): node is HTMLElement => Boolean(node)));
  }

  function openMenu(): void {
    const issue = findIssueById(issueId);
    if (!issue) return;
    openActionSheet(issue.id, [
      {
        label: 'Copy ID',
        glyph: 'fi-rr-copy',
        run: async () => {
          try {
            await navigator.clipboard.writeText(issue.id);
            void toast(`Copied ${issue.id}`);
          } catch {
            void toast('Clipboard is not available here', 'error');
          }
        },
      },
      {
        label: 'Delete issue',
        glyph: 'fi-rr-trash',
        danger: true,
        run: async () => {
          const ok = await confirmSheet({ title: `Delete ${issue.id}?`, body: 'This cannot be undone.', confirmLabel: 'Delete', danger: true });
          if (!ok) return;
          deleteIssue(issue.id);
          scheduleSaveIssues();
          popScreen();
        },
      },
    ]);
  }

  const unsub = subscribeIssuesChanges(() => {
    if (!visible || frame) return;
    frame = requestAnimationFrame(render);
  });

  return {
    key: `issue:${issueId}`,
    el: root,
    onShow() {
      visible = true;
      render();
    },
    onHide() {
      visible = false;
    },
    dispose() {
      unsub();
      cancelAnimationFrame(frame);
    },
  };
}
