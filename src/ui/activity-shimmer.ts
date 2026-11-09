import '../styles/activity-shimmer.css';

/** Lead-in before the first ripple so it starts once the label has risen into place. */
const RIPPLE_LEAD_IN_MS = 260;
/** Stagger between letters as the ripple crest travels. */
const RIPPLE_STEP_MS = 45;
/** Longest stagger a label's entrance may take, however long the text. */
const ENTER_SPREAD_MS = 320;

/**
 * Paint `text` as the activity ripple (see `activity-shimmer.css`): screen readers get one
 * readable string; the aria-hidden letters rise in, then carry a travelling crest. Setting the
 * same text again leaves the running animation untouched, so callers may re-sync freely.
 */
export function setActivityShimmerText(label: Element, text: string, suffix = ''): void {
  let readable = label.querySelector('.activity-shimmer__text');
  let visual = label.querySelector<HTMLElement>('.activity-shimmer__visual');
  let trailing = label.querySelector('.activity-shimmer__suffix');
  if (!readable || !visual || !trailing) {
    readable = document.createElement('span');
    readable.className = 'activity-shimmer__text';
    visual = document.createElement('span');
    visual.className = 'activity-shimmer__visual';
    visual.setAttribute('aria-hidden', 'true');
    trailing = document.createElement('span');
    trailing.className = 'activity-shimmer__suffix';
    label.classList.add('activity-shimmer');
    label.replaceChildren(readable, visual, trailing);
  }

  if (readable.textContent !== text) {
    readable.textContent = text;
    visual.replaceChildren();
    const ellipsisLength = text.endsWith('…') ? 1 : text.endsWith('...') ? 3 : 0;
    const characters = Array.from(ellipsisLength ? text.slice(0, -ellipsisLength) : text);
    const visualCharacters = ellipsisLength ? [...characters, '.', '.', '.'] : characters;
    const enterStep = Math.min(16, ENTER_SPREAD_MS / Math.max(1, visualCharacters.length));
    visualCharacters.forEach((character, index) => {
      const letter = document.createElement('span');
      letter.className = 'activity-shimmer__char';
      const dotIndex = index - characters.length;
      if (dotIndex >= 0) letter.classList.add('activity-shimmer__dot');
      letter.dataset.character = character;
      // The dots pick up where the crest leaves the last letter, one bubble at a time.
      const delay = RIPPLE_LEAD_IN_MS + (dotIndex >= 0 ? characters.length * RIPPLE_STEP_MS + dotIndex * 120 : index * RIPPLE_STEP_MS);
      letter.style.setProperty('--activity-shimmer-delay', `${delay}ms`);
      letter.style.setProperty('--activity-shimmer-enter-delay', `${Math.round(index * enterStep)}ms`);
      visual.appendChild(letter);
    });
    visual.style.setProperty('--activity-shimmer-duration', `${Math.max(2200, characters.length * RIPPLE_STEP_MS + (ellipsisLength ? 240 : 0) + 1400)}ms`);
  }

  if (trailing.textContent !== suffix) trailing.textContent = suffix;
}
