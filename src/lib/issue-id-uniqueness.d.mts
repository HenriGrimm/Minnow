import type { IssueCard } from '../types.ts';

export function reconcileDuplicateIssueIds(issues: IssueCard[]): IssueCard[];
export function maxIssueNumberForProjectKey(issues: IssueCard[], projectKey: string): number;
