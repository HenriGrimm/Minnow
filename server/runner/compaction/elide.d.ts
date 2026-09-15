export declare const ELIDE_MIN_CHARS = 1200;
export declare function isElidedToolStub(content: unknown): boolean;
/** Old tool result → a stub naming its row, tool and size. Short / non-tool rows come back unchanged. */
export declare function elideToolRow<T>(row: T, meta: { rowId: number | null; toolName?: string }): T;
