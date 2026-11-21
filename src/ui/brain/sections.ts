import type { BrainSectionId } from '../brain-page';
import { renderCodeSection } from './code-section';
import { renderMemoriesSection } from './memories-section';
import { renderProposalsSection } from './proposals-section';
import { renderSettingsSection } from './settings-section';

/** Render a Brain section on first activation. */
export async function renderBrainSection(
  section: BrainSectionId,
): Promise<void> {
  switch (section) {
    case 'proposals':
      await renderProposalsSection();
      break;
    case 'memories':
      await renderMemoriesSection();
      break;
    case 'code':
      await renderCodeSection();
      break;
    case 'settings':
      await renderSettingsSection();
      break;
    default:
      break;
  }
}
