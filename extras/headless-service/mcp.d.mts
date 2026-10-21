import type { AccountService } from './index.mjs';
export interface McpSession {
    /** Handle a request or consume a notification; modern cancellation suppresses the cancelled request's reply. */
    handle(message: unknown): Promise<unknown>;
    /** Abort outstanding work and reject subsequent requests. */
    close(): void;
}
/** Creates a session; 2026 requests carry protocol metadata and 2025 requests use the legacy initialization flow. */
export function createMcpSession(service: AccountService, options?: {
    /** Include write tools in the account-bound catalog. */
    allowWrites?: boolean;
    /** Maximum simultaneous tool calls, from 1 through 32. */
    maxConcurrent?: number;
    /** Accept legacy tool requests without retaining initialization state; modern requests are always independent. */
    stateless?: boolean;
}): McpSession;
