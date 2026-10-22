import type { State } from '@joplin/lib/reducer';

/** Sync operations whose numeric counters contain no item or backend details. */
const syncCounterNames = [
	'itemConflict', 'noteConflict', 'resourceConflict',
	'createRemote', 'updateRemote', 'deleteRemote',
	'createLocal', 'updateLocal', 'deleteLocal',
	'fetchingTotal', 'fetchingProcessed',
] as const;

/** The current process state and its most recent in-memory synchronization report. */
export interface HeadlessStatus {
	/** Epoch milliseconds when the live state was read. */
	observedAt: number;
	/** Authenticated profile email for the selected Joplin Server account, or null when unavailable. */
	accountEmail: string | null;
	/** Epoch milliseconds when this headless service initialized; reports reset on restart. */
	serviceStartedAt: number;
	/** Live scheduler flags and the latest report, without implying overall synchronization progress. */
	sync: {
		/** Whether synchronization is currently running. */
		running: boolean;
		/** Whether the scheduler reports a pending synchronization. */
		pending: boolean;
		/** Latest report in this process, or null before the first report with a start time. */
		report: {
			/** Last reported state; it can remain in_progress after running becomes false. */
			state: 'idle' | 'in_progress' | null;
			/** Epoch milliseconds when this reported synchronization started. */
			startTime: number | null;
			/** Epoch milliseconds when this reported synchronization completed, if reported. */
			completedTime: number | null;
			/** Present operation counters only; these are not a global completion percentage. */
			counters: Partial<Record<typeof syncCounterNames[number], number>>;
			/** Number of errors in this report; error contents are deliberately excluded. */
			errorCount: number;
		} | null;
	};
	/** Worker state plus existing missing-key and disabled-item indicators. */
	decryption: {
		/** Last worker state reported through Redux, or null for an unknown state. */
		state: 'idle' | 'started' | null;
		/** Last reported batch while started; values may belong to a previous batch or run until updated. Neither value describes the global backlog. */
		batch: {
			/** Last reported zero-based item index, not a completed-item count. */
			itemIndex: number;
			/** Last reported batch size, which may precede the active run until updated. */
			itemCount: number;
		} | null;
		/** Whether Redux currently lists at least one master key as not loaded. */
		missingMasterKey: boolean;
		/** Existing records disabled after repeated attempts; not a count of all failures. */
		disabledItemCount: number;
	};
}

/** The authenticated API methods needed to read the current account profile. */
interface HeadlessAccountApi {
	/** User ID from the loaded server session. */
	userId: string;
	/** Load or refresh the server session. */
	loadSession(): Promise<void>;
	/** Read a JSON API resource. */
	exec(method: string, path: string): Promise<{ email?: unknown }>;
}

/** Return the authenticated profile email for a selected Joplin Server variant. */
export async function getHeadlessAccountEmail(
	syncTargetId: unknown,
	getApi: ()=> Promise<HeadlessAccountApi>,
): Promise<string | null> {
	if (typeof syncTargetId !== 'number' || ![9, 10, 11].includes(syncTargetId)) return null;

	const api = await getApi();
	await api.loadSession();
	if (!api.userId) return null;

	const user = await api.exec('GET', `api/users/${api.userId}`);
	return typeof user?.email === 'string' && user.email.trim() ? user.email : null;
}

/** Select a finite, nonnegative number without forwarding arbitrary report values. */
function safeNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Copy the explicitly supported fields, excluding raw errors and item details. */
export function summarizeHeadlessState(
	state: State,
	disabledItemCount: number,
	serviceStartedAt: number,
	accountEmail: string | null = null,
): HeadlessStatus {
	const sourceReport = state.syncReport;
	const startTime = safeNumber(sourceReport.startTime);
	const counters: HeadlessStatus['sync']['report']['counters'] = {};
	for (const name of syncCounterNames) {
		const value = safeNumber(sourceReport[name]);
		if (value !== null) counters[name] = value;
	}
	const worker = state.decryptionWorker;
	return {
		observedAt: Date.now(),
		accountEmail,
		serviceStartedAt,
		sync: {
			running: state.syncStarted,
			pending: state.syncPending,
			report: startTime === null ? null : {
				state: sourceReport.state === 'idle' || sourceReport.state === 'in_progress' ? sourceReport.state : null,
				startTime,
				completedTime: safeNumber(sourceReport.completedTime),
				counters,
				errorCount: sourceReport.errors.length,
			},
		},
		decryption: {
			state: worker.state === 'idle' || worker.state === 'started' ? worker.state : null,
			batch: worker.state === 'started' ? { itemIndex: worker.itemIndex, itemCount: worker.itemCount } : null,
			missingMasterKey: state.notLoadedMasterKeys.length > 0,
			disabledItemCount,
		},
	};
}

/** Register the read-only status action and fixed additional headless actions. */
export function createHeadlessActionApi(
	getState: ()=> State,
	getDisabledItemCount: ()=> Promise<number>,
	getAccountEmail: ()=> Promise<string | null>,
	extraActions: Record<string, unknown> = Object.create(null),
) {
	const serviceStartedAt = Date.now();
	// Null prototypes keep inherited object methods outside the service/action allowlist.
	// Put status last so callers cannot replace the reserved action.
	const actions = Object.assign(Object.create(null), extraActions, {
		status: async () => {
			try {
				const disabledItemCount = await getDisabledItemCount();
				const accountEmail = await getAccountEmail();
				return summarizeHeadlessState(getState(), disabledItemCount, serviceStartedAt, accountEmail);
			} catch {
				// REST returns exception messages, so acquisition errors must not expose database details.
				throw new Error('Headless status unavailable.');
			}
		},
	});
	return Object.assign(Object.create(null), { headless: () => actions });
}
