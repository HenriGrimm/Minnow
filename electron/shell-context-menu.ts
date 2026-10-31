import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

/** Native roles preserve editing history and the composer's paste/attachment handlers. */
export function buildShellEditMenu(params: Pick<ContextMenuParams, 'isEditable' | 'editFlags'>): MenuItemConstructorOptions[] {
  if (!params.isEditable) return [];
  const flags = params.editFlags;
  return [
    { role: 'undo', enabled: flags.canUndo },
    { role: 'redo', enabled: flags.canRedo },
    { type: 'separator' },
    { role: 'cut', enabled: flags.canCut },
    { role: 'copy', enabled: flags.canCopy },
    { role: 'paste', enabled: flags.canPaste },
    { type: 'separator' },
    { role: 'selectAll', enabled: flags.canSelectAll },
  ];
}
