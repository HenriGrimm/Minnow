/** Overlay resize interaction, shared by mouse, touch, and pen input. */
export function bindTerminalResizeHandle(
  handle: HTMLElement,
  panel: HTMLElement,
  resize: (height: number) => void,
): void {
  let dragging = false;
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    handle.classList.add('dragging');
    handle.setPointerCapture(event.pointerId);
    startY = event.clientY;
    startHeight = panel.getBoundingClientRect().height;
    event.preventDefault();
  });

  handle.addEventListener('pointermove', (event) => {
    if (dragging) resize(startHeight + startY - event.clientY);
  });

  const stopDragging = () => {
    dragging = false;
    handle.classList.remove('dragging');
  };
  handle.addEventListener('pointerup', stopDragging);
  handle.addEventListener('pointercancel', stopDragging);
  handle.addEventListener('lostpointercapture', stopDragging);
}
