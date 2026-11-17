/** Star toggle that marks one reasoning level as the model's favorite (MIN-1047). */

import { formatReasoningEffortLabel } from '../lib/reasoning-effort';
import type { ReasoningEffortOption } from '../types';
import { iconHtml } from './icon';

/** One reasoning choice plus its favorite star, as siblings (never nested buttons). */
export function wrapReasoningChoiceWithFavorite(
  choice: HTMLButtonElement,
  level: ReasoningEffortOption | null,
  favorite: ReasoningEffortOption | undefined,
  disabled = false,
): HTMLDivElement {
  const option = document.createElement('div');
  option.className = 'composer-model-reasoning__option';
  option.append(choice);
  if (!level || level === 'off') return option;
  const starred = favorite === level;
  const label = formatReasoningEffortLabel(level);
  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'composer-model-reasoning__favorite';
  star.dataset.reasoningFavorite = level;
  star.setAttribute('aria-pressed', String(starred));
  star.setAttribute('aria-label', starred
    ? `Unfavorite ${label} for this model`
    : `Favorite ${label} for this model`);
  star.title = starred
    ? `${label} is your favorite for this model. Click to use the model default.`
    : `Use ${label} by default for this model`;
  star.innerHTML = iconHtml(starred ? 'starFilled' : 'star');
  star.disabled = disabled;
  option.append(star);
  return option;
}
