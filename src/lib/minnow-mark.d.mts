export declare const MINNOW_MARK_ROWS: readonly string[];
export declare const MINNOW_MARK_COLS: number;
export declare const MINNOW_MARK_ROW_COUNT: number;
export declare function minnowMarkCells(): Array<{ r: number; c: number }>;
export declare function minnowMarkPath(opts: {
  cell: number;
  step: number;
  x?: number;
  y?: number;
  radius?: number;
}): string;
export declare const MINNOW_MARK_VECTOR: Readonly<{ viewBox: string; d: string }>;
export declare const MINNOW_MARK_PIXEL: Readonly<{ viewBox: string; d: string }>;
