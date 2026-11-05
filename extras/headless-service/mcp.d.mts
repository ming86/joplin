import type { AccountService } from './index.mjs';
/** Logical byte reservations with one request, response, or retained-data lifetime. */
export interface PayloadOwner {
    /** Shared process allowance used by related operations. */
    readonly capacity: PayloadCapacity;
    /** Bytes currently retained by this owner. */
    readonly usedBytes: number;
    /** Reserve a known nonnegative byte count before retaining its payload; throws when capacity is exhausted. */
    reserve(byteCount: number): void;
    /** Release all owned bytes once; repeated cleanup is harmless. */
    release(): void;
}
/** Shared logical byte allowance for one MCP process. */
export interface PayloadCapacity {
    /** Bytes currently retained by all owners. */
    readonly usedBytes: number;
    /** Maximum aggregate reserved bytes. */
    readonly limitBytes: number;
    /** Create an owner using fixed internal diagnostic names. */
    createOwner(diagnostics?: { operation?: string; stage?: string }): PayloadOwner;
}
/** Transport-provided owners retained through request processing and response cleanup. */
export interface McpPayloadContext {
    /** Input bytes retained until the operation settles. */
    requestPayload?: PayloadOwner;
    /** Output bytes retained until response storage is released. */
    responsePayload?: PayloadOwner;
}
/** Text and contextual download metadata for an immutable UTF-8 export. */
export interface McpTextFileInput {
    /** Exact text to encode as UTF-8. */
    text: string;
    /** Download filename displayed to the caller. */
    filename: string;
    /** Media type, including charset when appropriate. */
    mimeType: string;
}
/** Shared export store supplied by a process composition root. */
export interface McpNoteFileResources {
    /** Export a native note snapshot and optionally charge its response bytes. */
    exportNote(note: { id: string; title?: string; body: string; revision_id: string; markup_language?: number }, responsePayload?: PayloadOwner): unknown;
    /** Export text, reserving retained and encoded response bytes before publishing its URI. */
    exportText(input: McpTextFileInput, responsePayload?: PayloadOwner): unknown;
    /** Export related files atomically; failure retains none of the batch's new entries. */
    exportTexts(inputs: McpTextFileInput[], responsePayload?: PayloadOwner): unknown[];
    /** Read an existing export and optionally charge its response bytes. */
    read(uri: string, responsePayload?: PayloadOwner): Record<string, unknown>;
    /** List stored export descriptors without materializing their bytes. */
    list(): unknown[];
    /** Release all retained exports. */
    close(): void;
}
export interface McpSession {
    /** Shared process allowance used by this session and its transport. */
    readonly payloadCapacity: PayloadCapacity;
    /** Handle a request or consume a notification; modern cancellation suppresses the cancelled request's reply. */
    handle(message: unknown, context?: McpPayloadContext): Promise<unknown>;
    /** Abort outstanding work and reject subsequent requests. */
    close(): void;
}
/** Creates a session; 2026 requests carry protocol metadata and 2025 requests use the legacy initialization flow. */
export function createMcpSession(service: AccountService, options?: {
    /** Include write tools in the account-bound catalog. */
    allowWrites?: boolean;
    /** Include attachment write tools when allowWrites also permits writes; defaults to true. */
    allowAttachmentWrites?: boolean;
    /** Maximum simultaneous tool calls, from 1 through 32. */
    maxConcurrent?: number;
    /** Accept legacy tool requests without retaining initialization state; modern requests are always independent. */
    stateless?: boolean;
    /** Process-owned allowance shared across sessions, transports, and file operations. */
    payloadCapacity?: PayloadCapacity;
    /** Process-owned export store that remains open when this session closes. */
    noteFileResources?: McpNoteFileResources;
}): McpSession;
