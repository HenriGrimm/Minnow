export function markMessageSteered(wrap: HTMLElement): void {
  wrap.classList.add('msg--steered');
  if (wrap.querySelector('.msg-steer-chip')) return;
  const chip = document.createElement('div');
  chip.className = 'msg-steer-chip';
  chip.textContent = 'You steered';
  chip.setAttribute('aria-hidden', 'true');
  const label = wrap.querySelector('.msg-label');
  if (label?.parentElement === wrap) {
    label.textContent = 'You steered';
    label.insertAdjacentElement('afterend', chip);
  } else {
    wrap.prepend(chip);
  }
}
