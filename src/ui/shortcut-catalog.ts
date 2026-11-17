import { inputId, type KeyInput } from './input-bindings';

export interface ShortcutEntry { target: KeyInput; title: string; group: string }
/** Physical Ctrl and Cmd alternatives remain separate so either can be changed independently. */
export function shortcutCatalog(): ShortcutEntry[] {
  const rows: ShortcutEntry[] = [];
  const add = (group: string, title: string, keys: string[]) => {
    for (const chord of keys) {
      for (const resolved of chord.includes('Mod+') ? [chord.replace('Mod+', 'Ctrl+'), chord.replace('Mod+', 'Cmd+')] : [chord]) {
        const parts = resolved.split('+');
        const key = parts.pop()!;
        rows.push({ title, group, target: { kind: 'key', key, ctrl: parts.includes('Ctrl'), meta: parts.includes('Cmd'), alt: parts.includes('Alt'), shift: parts.includes('Shift') } });
      }
    }
  };
  add('Shell', 'Command palette / selection Quick Edit', ['Mod+k']);
  add('Shell', 'Command palette', ['Mod+Shift+p']);
  add('Shell', 'Keyboard shortcuts help', ['Shift+?']);
  add('Shell', 'Cycle recent apps / editor tabs', ['Ctrl+Tab', 'Ctrl+Shift+Tab']);
  add('Shell', 'Quick capture issue', ['Mod+i']);
  add('Chat', 'New chat', ['Mod+n']);
  add('Chat', 'Previous / next chat', ['Ctrl+ArrowUp', 'Ctrl+ArrowDown']);
  add('Chat', 'Model picker', ['Mod+m']);
  add('Chat', 'Send message / confirm focused action', ['Enter']);
  add('Chat', 'New line in composer', ['Shift+Enter']);
  add('Chat', 'Skill picker', ['/']);
  add('Chat', 'Tool approval choices', ['1', '2', '3']);
  add('Code', 'Thread card', ['Mod+.']);
  add('Code', 'Toggle side panel', ['Mod+j']);
  add('Code', 'Toggle terminal', ['Ctrl+`']);
  add('Code', 'Save current file', ['Mod+s']);
  add('Code', 'Close viewer tab', ['Mod+w']);
  add('Editor', 'Completion', ['Ctrl+ ', 'Alt+`', 'Alt+i']);
  add('Editor', 'Accept suggestion / indent', ['Tab', 'Shift+Tab']);
  add('Editor', 'Accept next word', ['Mod+ArrowRight']);
  add('Editor', 'Accept suggestion / submit', ['Mod+Enter']);
  add('Editor', 'Format document', ['Shift+Alt+f']);
  add('Editor', 'Undo / redo', ['Mod+z', 'Mod+Shift+z', 'Ctrl+y']);
  add('Editor', 'Find / replace', ['Mod+f', 'Mod+h']);
  add('Editor', 'Go to definition / rename', ['F12', 'F2']);
  add('Navigation', 'Dismiss / cancel', ['Escape']);
  add('Navigation', 'Move / select in focused view', ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' ']);
  add('Navigation', 'Context menu', ['ContextMenu', 'Shift+F10']);
  add('Issues and launchers', 'Focused-view actions (status, priority, assignee, labels, project, surfaces)', ['s', 'p', 'u', 'l', 'g', 'j', 'k', 'd', 't', 'f', 'b', 'a', 'i', 'n', 'm']);
  add('Issues', 'Assign agent / triage / new issue', ['Shift+a', 'Shift+y', 'Shift+n', 'Shift+c', 'Backspace']);
  add('Issues', 'Move rank', ['Alt+ArrowUp', 'Alt+ArrowDown']);
  add('Issues', 'Move board column', ['Shift+ArrowLeft', 'Shift+ArrowRight']);
  add('Files', 'Select all / copy / cut / paste / delete', ['Mod+a', 'Mod+c', 'Mod+x', 'Mod+v', 'Delete']);
  const seen = new Set<string>();
  return rows.filter((row) => { const id = inputId(row.target); if (seen.has(id)) return false; seen.add(id); return true; });
}
