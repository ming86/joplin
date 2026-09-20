export class ServiceError extends Error { constructor(code: string, outcomeUnknown?: boolean); readonly code: string; readonly outcomeUnknown: boolean; retryAfterMs?: number; }
export type EmbeddingPurpose = 'document' | 'query';
export interface EmbeddingSpace {
    id: string;
    revision: string;
    dimensions: number;
    preprocessingVersion: string;
    normalization?: 'none' | 'l2';
    documentPrefix?: string;
    queryPrefix?: string;
}
export interface EmbeddingResponse {
    vectors: number[][];
    embeddingSpaceId: string;
    spaceFingerprint: string;
    inputTokens?: number;
}
export interface ProviderResponse {
    data: { index: number; embedding: number[] }[];
    usage?: { prompt_tokens?: number };
}
export type EmbeddingTransport = (preparedTexts: string[], purpose: EmbeddingPurpose, signal?: AbortSignal) => Promise<ProviderResponse>;
export function embeddingSpace(config: EmbeddingSpace): Readonly<Required<EmbeddingSpace>>;
export function embeddingFingerprint(config: EmbeddingSpace): string;
export function noteFingerprint(note: { title: string; body: string }, preprocessingVersion: string): string;
export function bindEmbeddingProvider(config: EmbeddingSpace, transport?: EmbeddingTransport): {
    readonly space: Readonly<Required<EmbeddingSpace>>;
    embed(texts: string[], purpose: EmbeddingPurpose, signal?: AbortSignal): Promise<EmbeddingResponse>;
};
export interface AccountConfiguration {
    id: string;
    subjects: string[];
    permissions?: ('read' | 'write')[];
    joplin: {
        baseUrl: string;
        token: string;
        allowInsecureHttp?: boolean;
        timeoutMs?: number;
        maxResponseBytes?: number;
    };
    semantic: { databasePath: string; keyRef: string };
    embedding?: {
        protocol: 'openai-embeddings';
        baseUrl: string;
        model: string;
        credentialRef?: string;
        remoteProcessing: boolean;
        allowInsecureHttp?: boolean;
        space: EmbeddingSpace;
    };
}
export interface Note {
    id: string;
    parent_id?: string;
    title?: string;
    body?: string;
    updated_time?: number;
    markup_language?: number;
    encryption_applied?: number;
    deleted_time?: number;
    is_locked?: number;
}
export interface Notebook { id: string; title: string; parent_id: string; }
export interface WebCreationRecord { id: string; parent_id: string; source: string; deleted_time?: number; encryption_applied?: number; is_locked?: number; }
export interface WebPlaceholder { id: string; parentId: string; receipt: string; }
export interface PageOptions { page?: number; limit?: number; }
export interface Page<T> { items: T[]; hasMore: boolean; }
export interface NewNote { parentId: string; title: string; body: string; }
export interface NoteUpdate { title?: string; body?: string; }
export interface Change { id: number; itemId: string; itemType?: number; type: number; createdTime?: number; }
export interface JoplinBackend {
    listNotebooks(options?: PageOptions, signal?: AbortSignal): Promise<Page<Notebook>>;
    listNotes(options?: PageOptions, signal?: AbortSignal): Promise<Page<Note>>;
    listNoteSummaries?(options?: PageOptions & { notebookId?: string }, signal?: AbortSignal): Promise<Page<Note>>;
    getNotebook?(id: string, signal?: AbortSignal): Promise<{ id: string; title: string }>;
    getClipRecord?(id: string, signal?: AbortSignal): Promise<WebCreationRecord>;
    createWebPlaceholder?(input: WebPlaceholder, signal?: AbortSignal): Promise<{ id: string }>;
    listIndexNotes?(options?: PageOptions, signal?: AbortSignal): Promise<Page<Note>>;
    getNote(id: string, signal?: AbortSignal): Promise<Note>;
    createNote(input: NewNote, signal?: AbortSignal): Promise<Note>;
    updateNote(id: string, input: NoteUpdate, signal?: AbortSignal): Promise<Note>;
    search(query: string, options?: PageOptions, signal?: AbortSignal): Promise<Page<Note>>;
    changes(cursor?: string, signal?: AbortSignal): Promise<Page<Change> & { cursor: string }>;
}
export interface SemanticStatus {
    state: 'unavailable' | 'indexing' | 'ready' | 'degraded'; reason?: string; embeddingSpaceId?: string;
    generation?: number; initialScanComplete?: boolean; pendingNotes?: number; indexedNotes?: number; failedNotes?: number;
    lastReconciledAt?: number | null; providerRetryAt?: number | null;
    usage?: { inputTokens: number; preparedBytes: number; successfulRequests: number };
}
export interface SearchInput extends PageOptions { query: string; mode?: 'keyword' | 'semantic' | 'hybrid'; notebookId?: string; }
export interface SearchResult {
    accountId: string; requestedMode: 'keyword' | 'semantic' | 'hybrid'; executedMode: 'keyword' | 'semantic' | 'hybrid' | null;
    semantic: SemanticStatus; items: (AccountNote & { provenance: 'keyword' | 'semantic' | 'hybrid'; score?: number; semanticExcerpt?: string; chunk?: { ordinal: number; start: number; end: number; offsetUnit: 'utf8-byte' } })[];
    hasMore: boolean; candidateWindow?: number; truncated?: boolean; notebookId?: string;
}
export interface SemanticBackend { readonly accountId: string; status(): SemanticStatus; search(input: SearchInput, signal?: AbortSignal): Promise<SearchResult>; }

export type AccountNote = Note & { accountId: string };
export interface AccountService {
    readonly accountId: string;
    status(): { accountId: string; semantic: SemanticStatus };
    listNotebooks(options?: PageOptions, signal?: AbortSignal): Promise<Page<Notebook & { accountId: string }>>;
    listNotes(options?: PageOptions, signal?: AbortSignal): Promise<Page<AccountNote>>;
    listNoteSummaries(options?: PageOptions & { notebookId?: string }, signal?: AbortSignal): Promise<Page<AccountNote>>;
    getNotebook(id: string, signal?: AbortSignal): Promise<{ id: string; title: string }>;
    getWebCreationRecord(id: string, signal?: AbortSignal): Promise<WebCreationRecord>;
    createWebPlaceholder(input: WebPlaceholder, signal?: AbortSignal): Promise<{ id: string }>;
    getNote(id: string, signal?: AbortSignal): Promise<AccountNote>;
    createNote(input: NewNote, signal?: AbortSignal): Promise<AccountNote>;
    updateNote(id: string, input: NoteUpdate, signal?: AbortSignal): Promise<AccountNote>;
    changes(cursor?: string, signal?: AbortSignal): Promise<Page<Change> & { accountId: string; cursor: string }>;
    search(input: SearchInput, signal?: AbortSignal): Promise<SearchResult>;
    embed(texts: string[], purpose: EmbeddingPurpose, signal?: AbortSignal): Promise<EmbeddingResponse & { accountId: string }>;
}
export interface AccountRegistry { forPrincipal(verifiedSubject: string, accountId: string): AccountService; }
export function createAccountRegistry(configurations: AccountConfiguration[], factories?: {
    makeSemanticBackend?: (configuration: AccountConfiguration) => SemanticBackend | null;
    makeBackend?: (configuration: AccountConfiguration) => JoplinBackend;
    makeEmbeddingTransport?: (configuration: AccountConfiguration) => EmbeddingTransport | undefined;
}): AccountRegistry;
