export type RouterTaskType = 'general' | 'coding' | 'ux-design' | 'debugging' | 'code-review' | 'planning' | 'research' | 'writing';
export declare const ROUTER_TASK_TYPES: readonly RouterTaskType[];
export declare const ROUTER_TASK_CRITERIA: Record<RouterTaskType, string>;
export declare function isRouterTaskType(value: unknown): value is RouterTaskType;
export declare function formatRouterTaskTypeLabel(value: string): string;
