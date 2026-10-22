/** Service failure with a stable code and an optional safe public message. */
export class ServiceError extends Error {
    /** @param code Stable machine-readable code. @param outcomeUnknown Whether a write may have committed. @param message Safe public message, defaulting to the code. */
    constructor(code: string, outcomeUnknown?: boolean, message?: string);
    readonly code: string;
    readonly outcomeUnknown: boolean;
    retryAfterMs?: number;
}
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
/** JSON values retained in a native note revision's metadata snapshot. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
/** Current note snapshot returned with its native revision precondition. */
export interface RevisionNote extends Note {
    /** Native Joplin revision id used as the update precondition. */
    revision_id: string;
    /** Previous native revision id, or null when this is the first captured revision. */
    previous_revision_id?: string | null;
    /** Whether an update changed the note and captured a new revision. */
    changed?: boolean;
}
/** Result of a protected update, including whether a revision was captured. */
export interface UpdatedRevisionNote extends RevisionNote {
    previous_revision_id: string | null;
    changed: boolean;
}
/** Compact row in a note's native revision history. */
export interface NoteRevisionSummary {
    /** Native Joplin revision id. */
    revision_id: string;
    /** Capture time in Unix epoch milliseconds. */
    captured_time: number;
    /** Parent revision id, or null for the first revision in the chain. */
    parent_revision_id: string | null;
}
/** Immutable historical note snapshot reconstructed from native revision data. */
export interface NoteRevisionSnapshot {
    /** Original note id, including if the live note was deleted. */
    note_id: string;
    /** Native Joplin revision id. */
    revision_id: string;
    /** Capture time in Unix epoch milliseconds. */
    captured_time: number;
    /** Historical note title. */
    title: string;
    /** Historical note body. */
    body: string;
    /** JSON-safe tracked metadata from the historical note. */
    metadata: Record<string, JsonValue>;
}
/** One before-and-after metadata field in a revision comparison. */
export interface NoteRevisionMetadataChange {
    /** Changed metadata field name. */
    field: string;
    /** Value before the change, preserving whether the property existed. */
    from: { present: true; value: JsonValue } | { present: false };
    /** Value after the change, preserving whether the property exists. */
    to: { present: true; value: JsonValue } | { present: false };
}
/** Text and metadata differences between two native note revisions. */
export interface NoteRevisionComparison {
    /** Original note id. */
    note_id: string;
    /** Revision used as the comparison base. */
    from_revision_id: string;
    /** Compared-to revision id. */
    to_revision_id: string;
    /** Whether the destination is the latest current revision. */
    to_current: boolean;
    /** Unified patch for title changes. */
    title_diff: string;
    /** Unified patch for body changes. */
    body_diff: string;
    /** Tracked metadata changes. */
    metadata_changes: NoteRevisionMetadataChange[];
}
/** Compact row for a note conflict currently stored on this device. */
export interface ConflictSummary {
    /** Native id of the conflict note. */
    id: string;
    /** Title of the conflict note. */
    title: string;
    /** Native id of the note it conflicts with, or an empty string when no original is linked. */
    conflict_original_id: string;
    /** Creation time in Joplin's millisecond timestamp format. */
    created_time: number;
    /** Update time in Joplin's millisecond timestamp format. */
    updated_time: number;
}
/** Current native snapshot returned when one conflict side is available. */
export interface ConflictSnapshot {
    /** Native note id. */
    id: string;
    /** Native parent notebook id; the special root uses an empty string. */
    parent_id: string;
    /** Current note title. */
    title: string;
    /** Current note body. */
    body: string;
    /** Creation time in Joplin's millisecond timestamp format. */
    created_time: number;
    /** Update time in Joplin's millisecond timestamp format. */
    updated_time: number;
    /** Whether this item is a to-do, encoded as 0 or 1. */
    is_todo: number;
    /** To-do completion time in milliseconds, or 0 while open. */
    todo_completed: number;
    /** Native Joplin markup language value. */
    markup_language: number;
    /** Whether this item is a conflict note, encoded as 0 or 1. */
    is_conflict: number;
    /** Original note id linked to this conflict, or an empty string when unlinked. */
    conflict_original_id: string;
}
/** One side of a device-local conflict, with content only when available. */
export interface ConflictSide {
    /** Native note id, or null when no note is linked to this side. */
    id: string | null;
    /** Why the side can or cannot be read on this device. */
    status: 'available' | 'missing' | 'trashed' | 'encrypted' | 'locked' | 'unlinked';
    /** Current note snapshot. Present only when status is `available`. */
    note?: ConflictSnapshot;
}
/** Current conflict copy and original side as stored on this device. */
export interface ConflictReadResult {
    /** Conflict copy created by synchronization. */
    conflict: ConflictSide;
    /** Current original note associated with the conflict. */
    original: ConflictSide;
}
/** Input for listing a page of device-local note conflicts. */
export type ConflictListInput = PageOptions;
/** Input for reading both sides of one device-local note conflict. */
export interface ConflictReadInput {
    /** Native id of a conflict note returned by listConflicts. */
    id: string;
}
/** Input for listing a page of native revisions. */
export interface NoteRevisionListInput extends PageOptions {
    /** Note whose revision history should be listed. */
    note_id: string;
}
/** Input for reading one immutable native note revision. */
export interface NoteRevisionReadInput {
    /** Original note id. */
    note_id: string;
    /** Native Joplin revision id. */
    revision_id: string;
}
/** Input for comparing one revision with another or with the latest revision. */
export interface NoteRevisionCompareInput {
    /** Original note id. */
    note_id: string;
    /** Revision used as the comparison base. */
    from_revision_id: string;
    /** Optional destination revision; omission selects the latest revision. */
    to_revision_id?: string;
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
/** Result of moving a notebook subtree to Joplin Trash. */
export interface DeletedNotebookResult {
    /** Trashed notebook id. */
    id: string;
    /** Always true after the backend move succeeds. */
    trashed: true;
    /** Account that owns the notebook. */
    accountId: string;
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
/** Protected note update; include the base revision and at least one change. */
export interface RevisionNoteUpdate extends NoteUpdate {
    /** Current native revision id returned by readNoteWithRevision. */
    base_revision_id: string;
}
/** Notebook update; include a title and/or parent id. Empty parent id selects the root. */
export interface NotebookUpdate {
    /** Optional replacement notebook title. */
    title?: string;
    /** Optional destination notebook id, or an empty string for the root. */
    parent_id?: string;
}
/** Attachment metadata returned by account-facing operations. */
export interface AttachmentMetadata {
    /** Joplin resource id. */
    id: string;
    /** Pathless display filename when supplied by the backend. */
    filename?: string;
    /** Display title, when set. */
    title?: string | null;
    /** MIME type, when set. */
    mime?: string | null;
    /** Resource filename extension. */
    file_extension?: string | null;
    /** Stored byte count. */
    size?: number;
    /** Creation time in Unix epoch milliseconds. */
    created_time?: number;
    /** Last update time in Unix epoch milliseconds. */
    updated_time?: number;
    /** Whether Joplin has encrypted the resource metadata. */
    encryption_applied?: 0 | 1;
    /** Whether Joplin has encrypted the resource file bytes. */
    encryption_blob_encrypted?: 0 | 1;
    /** Whether the resource is locked by Joplin's encryption state. */
    is_locked?: 0 | 1;
}
/** Backend attachment metadata includes a pathless display filename. */
export interface BackendAttachment extends AttachmentMetadata {
    /** Filename safe to expose to callers; never a local storage path. */
    filename: string;
}
/** Metadata-only attachment returned by an account service. */
export interface AccountAttachment extends AttachmentMetadata {
    /** Account that owns the resource. */
    accountId: string;
}
/** Attachment bytes returned by the account service as standard base64. */
export interface ReadableAccountAttachment extends AccountAttachment {
    /** Pathless display filename. */
    filename: string;
    /** Complete file bytes encoded as standard base64. */
    contentBase64: string;
}
/** Standalone resource upload input; linking it to a note is a separate body update. */
export interface CreateAttachmentInput {
    /** Pathless filename to store for the resource. */
    filename: string;
    /** Complete file bytes encoded as standard base64. */
    contentBase64: string;
    /** Optional resource display title. */
    title?: string;
    /** Optional MIME type. */
    mime?: string;
}
/** Include at least one metadata field or a complete replacement of the current bytes. */
export interface UpdateAttachmentInput {
    /** Optional replacement display title. */
    title?: string;
    /** Optional pathless filename; Joplin derives the stored extension from it. */
    filename?: string;
    /** Optional replacement MIME type. */
    mime?: string;
    /** Optional complete replacement file bytes encoded as standard base64. */
    contentBase64?: string;
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
    /** Read current note data and capture its native revision id for a protected update. */
    readNoteWithRevision(id: string, signal?: AbortSignal): Promise<RevisionNote>;
    /** Apply note changes only if the supplied native revision id is still current. */
    updateNoteWithRevision(id: string, input: RevisionNoteUpdate, signal?: AbortSignal): Promise<UpdatedRevisionNote>;
    /** List one page of a note's immutable native revision history. */
    listNoteRevisions(input: NoteRevisionListInput, signal?: AbortSignal): Promise<Page<NoteRevisionSummary>>;
    /** Read one immutable historical note snapshot. */
    readNoteRevision(input: NoteRevisionReadInput, signal?: AbortSignal): Promise<NoteRevisionSnapshot>;
    /** Compare historical snapshots, defaulting the destination to the latest revision. */
    compareNoteRevisions(input: NoteRevisionCompareInput, signal?: AbortSignal): Promise<NoteRevisionComparison>;
    /** List one page of note conflicts stored on this device. */
    listConflicts(input: ConflictListInput, signal?: AbortSignal): Promise<Page<ConflictSummary>>;
    /** Read the current conflict copy and original note sides stored on this device. */
    readConflict(input: ConflictReadInput, signal?: AbortSignal): Promise<ConflictReadResult>;
    createNote(input: NewNote, signal?: AbortSignal): Promise<Note>;
    updateNote(id: string, input: NotePatch, signal?: AbortSignal): Promise<Note>;
    /** Create a notebook in the backend. */
    createNotebook?(input: NewNotebook, signal?: AbortSignal): Promise<Notebook>;
    /** Rename or move a notebook using native notebook update semantics. */
    updateNotebook(id: string, input: NotebookUpdate, signal?: AbortSignal): Promise<Notebook>;
    /** Move a notebook and its subtree to Joplin Trash. */
    deleteNotebook(id: string, signal?: AbortSignal): Promise<void>;
    /** Read safe tag metadata by id. */
    getTag(id: string, signal?: AbortSignal): Promise<Tag>;
    /** Rename a tag using Joplin's native title validation. */
    updateTag(id: string, input: { title: string }, signal?: AbortSignal): Promise<Tag>;
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
    /** List linked resource metadata for a note, following every core API page. */
    listNoteAttachments(noteId: string, signal?: AbortSignal): Promise<BackendAttachment[]>;
    /** Read metadata for one Joplin resource. */
    getAttachment(resourceId: string, signal?: AbortSignal): Promise<BackendAttachment>;
    /** Read one resource's current bytes as standard base64. */
    readAttachment(resourceId: string, signal?: AbortSignal): Promise<BackendAttachment & { contentBase64: string }>;
    /** Upload a standalone Joplin resource; this does not change a note body. */
    createAttachment(input: CreateAttachmentInput, signal?: AbortSignal): Promise<BackendAttachment>;
    /** Update resource metadata and/or replace the current resource bytes. */
    updateAttachment(resourceId: string, input: UpdateAttachmentInput, signal?: AbortSignal): Promise<BackendAttachment>;
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
    /** Email configured for the Joplin account in the core, or null when unavailable. */
    accountEmail: string | null;
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
    /** Local account binding ID selected by the configured registry. */
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
/** Current note snapshot returned with its native revision identifier. */
export interface AccountRevisionNote extends RevisionNote {
    /** Account that supplied the note. */
    accountId: string;
}
/** Current revision note with readable notebook and tag labels. */
export interface ReadableAccountRevisionNote extends AccountRevisionNote {
    /** Readable parent notebook title, or null when there is no readable parent. */
    notebook_title: string | null;
    /** Titles of readable tags attached to the note. */
    tags: string[];
}
/** Result of a protected update enriched with its account identity. */
export interface AccountUpdatedRevisionNote extends UpdatedRevisionNote {
    /** Account that supplied the note. */
    accountId: string;
}
/** Revision history row enriched with its account identity. */
export interface AccountNoteRevisionSummary extends NoteRevisionSummary {
    /** Account that supplied the revision. */
    accountId: string;
}
/** Historical snapshot enriched with its account identity. */
export interface AccountNoteRevisionSnapshot extends NoteRevisionSnapshot {
    /** Account that supplied the revision. */
    accountId: string;
}
/** Revision comparison enriched with its account identity. */
export interface AccountNoteRevisionComparison extends NoteRevisionComparison {
    /** Account that supplied the revisions. */
    accountId: string;
}
/** One account-bound page of native note revision history. */
export interface AccountNoteRevisionPage {
    /** Account that supplied the revisions. */
    accountId: string;
    /** Revision rows in newest-first order. */
    items: AccountNoteRevisionSummary[];
    /** Whether a later page is available. */
    hasMore: boolean;
}
/** One account-bound page of device-local note conflicts. */
export interface AccountConflictPage {
    /** Account that supplied the conflicts. */
    accountId: string;
    /** Current conflict note rows in native order. */
    items: ConflictSummary[];
    /** Whether a later page is available. */
    hasMore: boolean;
}
/** Conflict sides returned with their account identity. */
export interface AccountConflictReadResult extends ConflictReadResult {
    /** Account that supplied both conflict sides. */
    accountId: string;
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
    /** Read an eligible note with its native revision id and readable labels. */
    readNoteWithRevision(id: string, signal?: AbortSignal): Promise<ReadableAccountRevisionNote>;
    /** Apply changes only when the current native revision matches the supplied base id. */
    updateNoteWithRevision(id: string, input: RevisionNoteUpdate, signal?: AbortSignal): Promise<AccountUpdatedRevisionNote>;
    /** List one account-bound page of native note revisions. */
    listNoteRevisions(input: NoteRevisionListInput, signal?: AbortSignal): Promise<AccountNoteRevisionPage>;
    /** Read an immutable historical snapshot, including after live-note deletion. */
    readNoteRevision(input: NoteRevisionReadInput, signal?: AbortSignal): Promise<AccountNoteRevisionSnapshot>;
    /** Compare two native revisions, defaulting the destination to the latest. */
    compareNoteRevisions(input: NoteRevisionCompareInput, signal?: AbortSignal): Promise<AccountNoteRevisionComparison>;
    /** List one account-bound page of device-local note conflicts. */
    listConflicts(input?: ConflictListInput, signal?: AbortSignal): Promise<AccountConflictPage>;
    /** Read both current sides of one device-local note conflict. */
    readConflict(input: ConflictReadInput, signal?: AbortSignal): Promise<AccountConflictReadResult>;
    /** Add and remove tags by trimmed, case-insensitive title. */
    manageTags(input: ManageTagsInput, signal?: AbortSignal): Promise<ManageTagsResult>;
    /** List all readable tags. */
    listTags(signal?: AbortSignal): Promise<TagListResult>;
    /** Rename a readable tag while preserving its existing note assignments. */
    renameTag(id: string, title: string, signal?: AbortSignal): Promise<Tag & { accountId: string }>;
    /** Update a notebook title, parent, or both. */
    updateNotebook(id: string, input: NotebookUpdate, signal?: AbortSignal): Promise<Notebook & { accountId: string }>;
    /** Move a notebook subtree to Joplin Trash. */
    deleteNotebook(id: string, signal?: AbortSignal): Promise<DeletedNotebookResult>;
    /** Create a standalone tag without attaching it to a note. */
    createTag(title: string, signal?: AbortSignal): Promise<Tag & { accountId: string }>;
    /** List attachment metadata linked to an eligible note. */
    listNoteAttachments(noteId: string, signal?: AbortSignal): Promise<AccountAttachment[]>;
    /** Read metadata for an eligible, unlocked resource. */
    getAttachment(resourceId: string, signal?: AbortSignal): Promise<AccountAttachment>;
    /** Read an eligible, unlocked resource and return its bytes as base64. */
    readAttachment(resourceId: string, signal?: AbortSignal): Promise<ReadableAccountAttachment>;
    /** Upload a standalone resource; linking it in a note body is a separate update. */
    createAttachment(input: CreateAttachmentInput, signal?: AbortSignal): Promise<AccountAttachment>;
    /** Rename or replace an eligible, unlocked resource. */
    updateAttachment(resourceId: string, input: UpdateAttachmentInput, signal?: AbortSignal): Promise<AccountAttachment>;
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
