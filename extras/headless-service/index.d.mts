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
    /** Notebook selected when createNote receives no explicit notebook ID, before the sole-notebook fallback. */
    defaultNotebookId?: string;
    joplin: {
        baseUrl: string;
        token: string;
        allowInsecureHttp?: boolean;
        timeoutMs?: number;
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
    /** Creation time in Joplin's millisecond timestamp format. */
    created_time?: number;
    updated_time?: number;
    /** Whether this note is a to-do, represented as 0 or 1. */
    is_todo?: number;
    /** Completion time in milliseconds, or 0 while open. */
    todo_completed?: number;
    markup_language?: number;
    encryption_applied?: number;
    deleted_time?: number;
    is_locked?: number;
}
/** A notebook returned by the account's paged or complete listing. */
export interface Notebook {
    /** Joplin notebook ID. */
    id: string;
    /** Notebook title. */
    title: string;
    /** Parent notebook ID, or null for a top-level notebook. */
    parent_id: string | null;
}
/** A notebook with its count of eligible notes. */
export interface NotebookWithCount extends Notebook {
    /** Number of readable, non-deleted notes in this notebook. */
    note_count: number;
}
/** Complete safe notebook listing and its account binding. */
export interface NotebookListResult {
    /** Account that supplied the notebooks. */
    accountId: string;
    /** Readable notebooks with counts of eligible notes. */
    notebooks: NotebookWithCount[];
}
/** Safe tag metadata exposed by list and note operations. */
export interface Tag {
    /** Joplin tag ID. */
    id: string;
    /** Tag title. */
    title: string;
}
/** Complete safe tag listing. */
export interface TagListResult {
    /** Readable tags. */
    tags: Tag[];
}
export interface WebCreationRecord { id: string; parent_id: string; source: string; deleted_time?: number; encryption_applied?: number; is_locked?: number; }
export interface WebPlaceholder { id: string; parentId: string; receipt: string; }
export interface PageOptions { page?: number; limit?: number; }
export interface Page<T> { items: T[]; hasMore: boolean; }
/** Internal backend input after the account service resolves its notebook. */
export interface NewNote {
    /** Verified parent notebook ID. */
    parentId: string;
    /** Note title. */
    title: string;
    /** Markdown body written after an empty-body POST. */
    body: string;
    /** To-do flag encoded as the Joplin API's 0 or 1. */
    is_todo: 0 | 1;
}
/** Desktop-compatible account-service input; parentId retains the legacy web API shape. */
export interface CreateNoteInput {
    /** Note title. */
    title: string;
    /** Markdown body, defaulting to an empty string. */
    body?: string;
    /** Optional Joplin notebook ID. */
    notebook_id?: string;
    /** Create the note as a to-do. */
    is_todo?: boolean;
    /** Legacy web-service notebook ID. */
    parentId?: string;
}
/** Exact-match body operation used by updateNote. */
export interface ReplaceTextInput {
    /** Non-empty text that must occur exactly once. */
    find: string;
    /** Text inserted in place of the match. */
    replace: string;
}
/** Desktop-compatible partial note update input. */
export interface NoteUpdate {
    /** Replace the note title. */
    title?: string;
    /** Replace the entire body; this takes precedence over append, prepend, and replace_text. */
    body?: string;
    /** Add text after the current body. */
    append?: string;
    /** Add text before the current body. */
    prepend?: string;
    /** Replace one unique exact body match. */
    replace_text?: ReplaceTextInput;
    /** Move the note to this readable notebook. */
    notebook_id?: string;
    /** Set to true to complete the to-do, or false to reopen it. */
    todo_completed?: boolean;
}
/** Backend patch after Desktop update operations are resolved. */
export interface NotePatch {
    /** Replacement title. */
    title?: string;
    /** Replacement Markdown body. */
    body?: string;
    /** Verified destination notebook ID. */
    parentId?: string;
    /** Completion timestamp in milliseconds, or 0 to reopen the to-do. */
    todo_completed?: number;
}
/** Titles to add or remove from a note. Unknown added titles are created. */
export interface ManageTagsInput {
    /** Note whose tag assignments should change. */
    note_id: string;
    /** Tag titles to attach, creating unknown titles. */
    add?: string[];
    /** Tag titles to detach when the tag exists. */
    remove?: string[];
}
/** Result of adding and removing note tags. */
export interface ManageTagsResult {
    /** Note whose assignments were changed. */
    note_id: string;
    /** Titles requested for addition after trimming. */
    added: string[];
    /** Existing titles requested for removal after trimming. */
    removed: string[];
    /** Tag titles attached after the changes. */
    tags: string[];
}
/** Result of moving an eligible note to Trash. */
export interface DeletedNoteResult {
    /** Trashed note ID. */
    id: string;
    /** Always true after the backend move succeeds. */
    trashed: true;
    /** Account that owns the note. */
    accountId: string;
}
/** Account-service input for creating a notebook. */
export interface CreateNotebookInput {
    /** Non-empty notebook title. */
    title: string;
    /** Optional readable parent notebook ID. */
    parent_id?: string;
}
/** Backend input after the account service checks the parent notebook. */
export interface NewNotebook {
    /** Trimmed notebook title. */
    title: string;
    /** Optional verified parent notebook ID. */
    parentId?: string;
}
export interface Change { id: number; itemId: string; itemType?: number; type: number; createdTime?: number; }
export interface JoplinBackend {
    /** Read the fixed in-memory synchronization and decryption summary. */
    status(signal?: AbortSignal): Promise<HeadlessStatusSummary>;
    listNotebooks(options?: PageOptions, signal?: AbortSignal): Promise<Page<Notebook>>;
    /** Return every safe notebook reported by the backend. */
    listAllNotebooks?(signal?: AbortSignal): Promise<Notebook[]>;
    listNotes(options?: PageOptions & { notebookId?: string }, signal?: AbortSignal): Promise<Page<Note>>;
    listNoteSummaries?(options?: PageOptions & { notebookId?: string }, signal?: AbortSignal): Promise<Page<Note>>;
    getNotebook?(id: string, signal?: AbortSignal): Promise<{ id: string; title: string }>;
    getClipRecord?(id: string, signal?: AbortSignal): Promise<WebCreationRecord>;
    createWebPlaceholder?(input: WebPlaceholder, signal?: AbortSignal): Promise<{ id: string }>;
    listIndexNotes?(options?: PageOptions, signal?: AbortSignal): Promise<Page<Note>>;
    getNote(id: string, signal?: AbortSignal): Promise<Note>;
    createNote(input: NewNote, signal?: AbortSignal): Promise<Note>;
    updateNote(id: string, input: NotePatch, signal?: AbortSignal): Promise<Note>;
    /** Create a notebook in the backend. */
    createNotebook?(input: NewNotebook, signal?: AbortSignal): Promise<Notebook>;
    /** Return safe tag metadata currently attached to a note. */
    getNoteTags?(noteId: string, signal?: AbortSignal): Promise<Tag[]>;
    /** Return every safe tag reported by the backend. */
    listAllTags?(signal?: AbortSignal): Promise<Tag[]>;
    /** Move a note to Trash through the backend. */
    deleteNote?(id: string, signal?: AbortSignal): Promise<void>;
    /** Create a tag and return its safe metadata. */
    createTag?(title: string, signal?: AbortSignal): Promise<Tag>;
    /** Attach an existing tag to a note. */
    addTagToNote?(tagId: string, noteId: string, signal?: AbortSignal): Promise<void>;
    /** Detach a tag from a note. */
    removeTagFromNote?(tagId: string, noteId: string, signal?: AbortSignal): Promise<void>;
    search(query: string, options?: PageOptions, signal?: AbortSignal): Promise<Page<Note>>;
    /** Count all eligible keyword matches without fetching note bodies. */
    countSearchResults?(query: string, signal?: AbortSignal): Promise<number>;
    changes(cursor?: string, signal?: AbortSignal): Promise<Page<Change> & { cursor: string }>;
}
export interface SemanticStatus {
    state: 'unavailable' | 'indexing' | 'ready' | 'degraded'; reason?: string; embeddingSpaceId?: string;
    generation?: number; initialScanComplete?: boolean; pendingNotes?: number; indexedNotes?: number; failedNotes?: number;
    lastReconciledAt?: number | null; providerRetryAt?: number | null;
    usage?: { inputTokens: number; preparedBytes: number; successfulRequests: number };
}
/** Sync report counters available in the fixed core status summary. */
export interface SyncCounters {
    /** Conflicts reported for generic items. */
    itemConflict?: number;
    /** Note conflicts reported by synchronization. */
    noteConflict?: number;
    /** Resource conflicts reported by synchronization. */
    resourceConflict?: number;
    /** Items created on the remote target. */
    createRemote?: number;
    /** Items updated on the remote target. */
    updateRemote?: number;
    /** Items deleted from the remote target. */
    deleteRemote?: number;
    /** Items created in the local database. */
    createLocal?: number;
    /** Items updated in the local database. */
    updateLocal?: number;
    /** Items deleted from the local database. */
    deleteLocal?: number;
    /** Total items scheduled for fetching. */
    fetchingTotal?: number;
    /** Items fetched so far. */
    fetchingProcessed?: number;
}
/** The most recent synchronization report retained in core memory. */
export interface SyncReportSummary {
    /** Last Redux report state; it can remain `in_progress` after a sync completes. */
    state: 'idle' | 'in_progress' | null;
    /** Unix epoch milliseconds when the report began, or null before the first sync. */
    startTime: number | null;
    /** Unix epoch milliseconds when the report completed, or null if it has not completed. */
    completedTime: number | null;
    /** Available conflict, local/remote change, and fetch progress counters. */
    counters: SyncCounters;
    /** Number of sync errors, without exposing error text. */
    errorCount: number;
}
/** Live synchronization activity and the latest in-memory report. */
export interface SyncStatusSummary {
    /** Whether a synchronization is running now. */
    running: boolean;
    /** Whether another synchronization is waiting to run. */
    pending: boolean;
    /** Last in-memory synchronization report, or null before the first report. */
    report: SyncReportSummary | null;
}
/** The batch represented by the decryption worker's reported progress. */
export interface DecryptionBatchSummary {
	/** Zero-based item index within the reported batch. */
    itemIndex: number;
	/** Number of items in the reported batch. */
    itemCount: number;
}
/** Live decryption worker state and the counts exposed by core. */
export interface DecryptionStatusSummary {
    /** Current worker state, or null when no state has been recorded. */
    state: 'idle' | 'started' | null;
	/** Last reported batch while the worker is started; a new run may still show the previous batch until progress arrives. */
    batch: DecryptionBatchSummary | null;
    /** Whether at least one master key is unavailable. */
    missingMasterKey: boolean;
    /** Number of records disabled by the decryption worker. */
    disabledItemCount: number;
}
/** Fixed core process status fields that exclude note and error contents. */
export interface HeadlessStatusSummary {
    /** Unix epoch milliseconds when this summary was observed. */
    observedAt: number;
    /** Unix epoch milliseconds when this headless service process started. */
    serviceStartedAt: number;
    /** Current sync activity and the latest report. */
    sync: SyncStatusSummary;
    /** Current decryption worker state. */
    decryption: DecryptionStatusSummary;
}
/** Account-bound status combining core process state with the local semantic index. */
export interface AccountStatus extends HeadlessStatusSummary {
    /** Account selected by the configured registry binding. */
    accountId: string;
    /** Semantic index state for this account. */
    semantic: SemanticStatus;
}
export interface SearchInput extends PageOptions { query: string; mode?: 'keyword' | 'semantic' | 'hybrid'; notebookId?: string; }
export interface SearchResult {
    accountId: string; requestedMode: 'keyword' | 'semantic' | 'hybrid'; executedMode: 'keyword' | 'semantic' | 'hybrid' | null;
    semantic: SemanticStatus; items: (AccountNote & { provenance: 'keyword' | 'semantic' | 'hybrid'; score?: number; semanticExcerpt?: string; chunk?: { ordinal: number; start: number; end: number; offsetUnit: 'utf8-byte' } })[];
    hasMore: boolean;
    /** Exact eligible result count for keyword execution when the backend supports counting. */
    total?: number;
    candidateWindow?: number; truncated?: boolean; notebookId?: string;
}
export interface SemanticBackend { readonly accountId: string; status(): SemanticStatus; search(input: SearchInput, signal?: AbortSignal): Promise<SearchResult>; }

export type AccountNote = Note & { accountId: string };
/** Account note enriched with safe notebook and tag labels. */
export interface ReadableAccountNote extends AccountNote {
    /** Readable parent notebook title, or null when there is no readable parent. */
    notebook_title: string | null;
    /** Titles of readable tags attached to the note. */
    tags: string[];
}
/** Created note identity including the chosen notebook ID. */
export interface CreatedAccountNote extends AccountNote {
    /** Notebook selected for creation. */
    notebook_id?: string;
}
export interface AccountService {
    readonly accountId: string;
    /** Read account-bound semantic state and the core process status summary. */
    status(signal?: AbortSignal): Promise<AccountStatus>;
    listNotebooks(options?: PageOptions, signal?: AbortSignal): Promise<Page<Notebook & { accountId: string }>>;
    /** Return all readable notebooks with counts from eligible note metadata. */
    listAllNotebooks(signal?: AbortSignal): Promise<NotebookListResult>;
    listNotes(options?: PageOptions & { notebookId?: string }, signal?: AbortSignal): Promise<Page<AccountNote>>;
    listNoteSummaries(options?: PageOptions & { notebookId?: string }, signal?: AbortSignal): Promise<Page<AccountNote>>;
    getNotebook(id: string, signal?: AbortSignal): Promise<{ id: string; title: string }>;
    getWebCreationRecord(id: string, signal?: AbortSignal): Promise<WebCreationRecord>;
    createWebPlaceholder(input: WebPlaceholder, signal?: AbortSignal): Promise<{ id: string }>;
    getNote(id: string, signal?: AbortSignal): Promise<AccountNote>;
    /** Read a note with its readable notebook title and tag titles. */
    readNote(id: string, signal?: AbortSignal): Promise<ReadableAccountNote>;
    /** Create a note using Desktop fields or the legacy parentId field. */
    createNote(input: CreateNoteInput, signal?: AbortSignal): Promise<CreatedAccountNote>;
    /** Create a notebook under an optional verified parent notebook. */
    createNotebook(input: CreateNotebookInput, signal?: AbortSignal): Promise<Notebook>;
    updateNote(id: string, input: NoteUpdate, signal?: AbortSignal): Promise<AccountNote>;
    /** Move an eligible note to Trash. */
    deleteNote(id: string, signal?: AbortSignal): Promise<DeletedNoteResult>;
    /** Add and remove tags by trimmed, case-insensitive title. */
    manageTags(input: ManageTagsInput, signal?: AbortSignal): Promise<ManageTagsResult>;
    /** List all readable tags. */
    listTags(signal?: AbortSignal): Promise<TagListResult>;
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
