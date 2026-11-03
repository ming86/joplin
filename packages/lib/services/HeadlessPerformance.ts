import type Logger from '@joplin/utils/Logger';

/** Content-free native stage records accepted by the optional headless timing reporter. */
export type HeadlessPerformanceRecord = {
	/** Per-item history coordination, including time queued before acquisition. */
	stage: 'historyLock';
	/** Native item model type. */
	itemType: number;
	/** Native item ID; no title or contents are included. */
	itemId: string;
	/** Milliseconds spent waiting for the item's history lock. */
	waitMs: number;
	/** Milliseconds spent holding the item's history lock. */
	holdMs: number;
} | {
	/** Native note save or read-capture transaction, including the shared SQLite wait. */
	stage: 'noteTransaction';
	/** Native note ID. */
	noteId: string;
	/** Fixed operation that owns the transaction. */
	operation: 'create' | 'read-capture' | 'unchanged-edit' | 'update';
	/** Total operation time in milliseconds. */
	elapsedMs: number;
} | {
	/** Rebase transaction after native history deletion. */
	stage: 'historyPruneRebaseTransaction';
	/** Native item model type. */
	itemType: number;
	/** Native item ID. */
	itemId: string;
	/** Transaction time in milliseconds. */
	elapsedMs: number;
	/** Number of surviving revisions rebased by the transaction. */
	revisionCount: number;
} | {
	/** One native search execution, without the search expression or matched content. */
	stage: 'nativeSearch';
	/** Search time in milliseconds. */
	elapsedMs: number;
	/** Native result count before live-note resolution. */
	resultCount: number;
} | {
	/** Live eligibility metadata resolution for native ranked search IDs. */
	stage: 'searchMetadata';
	/** Metadata resolution time in milliseconds. */
	elapsedMs: number;
	/** Number of live ranked notes. */
	liveCount: number;
	/** Number of readable live ranked notes. */
	readableCount: number;
} | {
	/** Body hydration for only the requested native search page. */
	stage: 'searchPageHydration';
	/** Page hydration time in milliseconds. */
	elapsedMs: number;
	/** Requested page membership before readable-note filtering. */
	pageCount: number;
	/** Number of readable notes returned. */
	returnedCount: number;
} | {
	/** One scoped grep candidate body page, without selection IDs or content. */
	stage: 'scopedBodyRead';
	/** Page read time in milliseconds. */
	elapsedMs: number;
	/** Number of candidate bodies returned. */
	returnedCount: number;
	/** Whether another candidate page remains. */
	hasMore: boolean;
};

/** Receives only the fixed stage records defined above; transports belong to the headless host. */
export type HeadlessPerformanceReporter = (record: HeadlessPerformanceRecord)=> void;

/** Installed only by a headless host; ordinary applications use their existing native logger. */
let reporter: HeadlessPerformanceReporter = null;

/** Install the headless host's timing sink, or remove it when that host stops. */
export function setHeadlessPerformanceReporter(value: HeadlessPerformanceReporter | null): void {
	reporter = value;
}

/** Keep native debug logging and independently forward the same safe record to the headless host. */
export function reportHeadlessPerformance(logger: Pick<Logger, 'debug'>, record: HeadlessPerformanceRecord): void {
	const { stage, ...fields } = record;
	logger.debug(stage, fields);
	reporter?.(record);
}
