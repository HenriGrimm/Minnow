import { createIcon, type IconName } from '../ui/icon';
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
export function button(label: string, action: () => void, primary = false, icon?: IconName): HTMLButtonElement {
  const node = el('button', '', `home-button${primary ? ' home-button--primary' : ''}`);
  node.type = 'button'; if (icon) node.append(createIcon(icon)); node.append(el('span', label)); node.onclick = action; return node;
}
export function age(at: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - at) / 60000));
  return mins < 1 ? 'just now' : mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
}
