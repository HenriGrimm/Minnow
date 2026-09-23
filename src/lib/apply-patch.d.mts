export interface PatchHunk { anchor: string; before: string[]; after: string[]; eof: boolean; ops?: string[] }
export interface PatchFile { kind: string; path: string; move?: string; hunks: PatchHunk[]; content: string }
export function parsePatch(patch: unknown): PatchFile[];
export function patchText(text: string, hunks: PatchHunk[], label?: string): string;
