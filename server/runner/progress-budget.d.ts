export interface ProgressBudgetResult {
  isError?: boolean;
  content?: string;
  codeChange?: {
    additions: number;
    deletions: number;
  };
}

export interface ProgressBudget {
  reset(): void;
  note(name: string, result?: ProgressBudgetResult): string | null;
}

export function createProgressBudget(enabled: boolean, maxCalls?: number): ProgressBudget;
