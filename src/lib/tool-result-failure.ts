import { isImpeccableDetectFindingsResult } from './impeccable-detect-result';

export function isToolResultFailure(content: unknown): boolean {
  return typeof content === 'string'
    && content.trimStart().startsWith('Error:')
    && !isImpeccableDetectFindingsResult(content);
}
