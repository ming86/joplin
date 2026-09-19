import type { AccountService } from './index.mjs';
export interface McpSession {
    handle(message: unknown): Promise<unknown>;
    close(): void;
}
export function createMcpSession(service: AccountService, options?: { allowWrites?: boolean; maxConcurrent?: number }): McpSession;
