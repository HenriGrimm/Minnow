import { createIconButton } from './components/button';

function navigateBackToChat(): void {
  void import('../os/router').then(({ returnToChat }) => returnToChat());
}

export function createBackToChatButton(onClick = navigateBackToChat): HTMLButtonElement {
  return createIconButton({ icon: 'back', label: 'Back to chat', className: 'back-to-chat', onClick });
}
