-- Run only AFTER a SQLCipher connection has been keyed and verified. This file
-- defines relational structure; ordinary SQLite does NOT become encrypted by
-- applying it. Phase 1.5 tests structure only. Phase 2B owns persistence/indexing.
PRAGMA foreign_keys = ON;
BEGIN;
PRAGMA application_id = 1246971185; -- JSE1
PRAGMA user_version = 1;
CREATE TABLE index_config (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation INTEGER NOT NULL UNIQUE CHECK (generation > 0),
    embedding_space_id TEXT NOT NULL,
    space_fingerprint TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK (dimensions > 0),
    metric TEXT NOT NULL CHECK (metric = 'cosine'),
    normalization TEXT NOT NULL CHECK (normalization IN ('none', 'l2')),
    preprocessing_version TEXT NOT NULL,
    chunker_version TEXT NOT NULL,
    UNIQUE (generation, dimensions)
);
CREATE TABLE note_state (
    note_id TEXT PRIMARY KEY CHECK (length(note_id) = 32),
    generation INTEGER NOT NULL REFERENCES index_config (generation),
    source_fingerprint TEXT,
    source_updated_time INTEGER,
    state TEXT NOT NULL CHECK (state IN ('pending', 'indexed', 'error', 'deleted')),
    error_code TEXT,
    retry_after INTEGER,
    UNIQUE (note_id, generation)
);
CREATE TABLE chunks (
    generation INTEGER NOT NULL,
    note_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
    content_hash TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector BLOB NOT NULL CHECK (typeof(vector) = 'blob' AND length(vector) = dimensions * 4),
    excerpt TEXT,
    PRIMARY KEY (generation, note_id, ordinal),
    FOREIGN KEY (generation, dimensions) REFERENCES index_config (generation, dimensions),
    FOREIGN KEY (note_id, generation) REFERENCES note_state (note_id, generation) ON DELETE CASCADE
);
CREATE TABLE sync_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    event_cursor TEXT,
    rescan_checkpoint TEXT
);
COMMIT;
-- float32 little-endian vectors. Persist pending IDs and event_cursor together.
-- Replace a note's chunks and indexed-state marker in ONE transaction. Publish
-- only after checking source_fingerprint against current Joplin content; later
-- invalidation/result validation handles races across the two independent DBs.
-- A new generation initially pauses semantic queries. Delete old chunks and
-- note_state before changing index_config, then requeue/rescan. FTS stays usable.
-- Credentials, DB keys and provider tokens must never be put in these tables.
