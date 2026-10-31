export function createProductionChatRuntime(options?: Record<string, any>): any;
export function setProductionChatRuntimeFactory(factory: () => any | Promise<any>): void;
export function peekProductionChatRuntime(): any | undefined;
export function publishProductionChatRuntime(runtime: any): void;
export function getProductionChatRuntime(): Promise<any>;
