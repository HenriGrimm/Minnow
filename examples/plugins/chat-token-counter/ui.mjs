export default function activate(ctx) {
  // Read the ledger snapshot; adding snapshots together would double-count requests.
  ctx.mountSlot('chat.throughput', () => {
    const counter = document.createElement('span');
    counter.className = 'stat-unit';
    counter.setAttribute('aria-label', 'Cumulative chat tokens');
    const unsubscribe = ctx.onChatUsage(usage => {
      const total = usage?.totals.totalTokens ?? 0;
      const compact = total.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
      counter.textContent = ` · ${compact} total`;
      counter.setAttribute('aria-label', `${total.toLocaleString()} cumulative chat tokens`);
      counter.title = `${total.toLocaleString()} tokens in completed requests in this chat, including prompt and completion tokens. Live estimates are excluded.`;
    });
    return { element: counter, dispose: unsubscribe };
  });

  const app = ctx.registerApp({ id: 'usage', name: 'Token usage', icon: 'grid', description: 'Chat and workspace token totals' }, root => {
    root.style.cssText = 'padding:24px;overflow:auto;color:var(--mn-fg);background:var(--mn-bg)';
    const heading = document.createElement('h1');
    heading.textContent = 'Token usage';
    const summary = document.createElement('p');
    summary.setAttribute('role', 'status');
    const note = document.createElement('p');
    note.textContent = 'Totals count completed requests, including repeated prompt tokens. Clearing a chat clears its ledger. Deleted chats are excluded from workspace totals.';
    root.append(heading, summary, note);
    const paint = () => {
      const usage = ctx.getChatUsage();
      const workspace = ctx.getWorkspaceUsage();
      const total = usage?.totals;
      summary.textContent = `Chat: ${(total?.totalTokens ?? 0).toLocaleString()} tokens (${(total?.promptTokens ?? 0).toLocaleString()} input, ${(total?.completionTokens ?? 0).toLocaleString()} output). Workspace: ${workspace.totals.totalTokens.toLocaleString()} tokens across ${workspace.chatCount} chats.`;
    };
    const chatSubscription = ctx.onChatUsage(paint);
    const workspaceSubscription = ctx.onWorkspaceUsage(paint);
    return () => { chatSubscription(); workspaceSubscription(); };
  });
  ctx.registerMenu('usage', () => [{ id: 'open_usage', label: 'Token usage', onSelect: () => app.launch() }], { kinds: ['menubar.plugins', 'app.rail'] });
  ctx.registerCommand({ id: 'usage', title: 'Open token usage', group: 'Plugins', keywords: 'tokens chat usage counter', run: () => app.launch() });
  ctx.registerSlashCommand({ id: 'tokens', alias: 'tokens', label: 'Token usage', description: 'Open chat and workspace token totals', run: () => app.launch() });
}
