import Synchronizer, { SyncStartOptions } from '@joplin/lib/Synchronizer';
import type { SyncSchedulingPolicy } from '@joplin/lib/registry';
import shim from '@joplin/lib/shim';

type SyncIntent = 'full' | 'upload' | 'poll';

/** One coalesced native sync request, with callers waiting for that request's completion. */
interface PendingSync {
	/** Distinguishes a lightweight remote check from a local upload request. */
	intent: SyncIntent;
	/** Full sync requests retain their own options when lower-priority requests arrive later. */
	options: SyncStartOptions;
	/** Earliest full/poll deadline, or the latest upload debounce deadline. */
	due: number;
	/** Whether this request must respect the existing mobile-data policy. */
	wifiCheck: boolean;
	/** Waiting callers, resolved together when this request finishes or is cancelled. */
	resolve: { resolve: ()=> void; reject: (error: unknown)=> void }[];
}

/** Schedule native headless sync without overlapping runs or postponing inbound checks on edits. */
export default class HeadlessSyncScheduler implements SyncSchedulingPolicy {
	/** One-shot delay to the next remote check, measured from the last run's completion. */
	private pollTimeout_: ReturnType<typeof shim.setTimeout> | null = null;
	/** Delay until the next periodic full sync after the previous one settles. */
	private fullTimeout_: ReturnType<typeof shim.setTimeout> | null = null;
	/** One wake-up for the current pending deadline. */
	private timeout_: ReturnType<typeof shim.setTimeout> | null = null;
	/** The only waiting request; later requests merge into it. */
	private request_: PendingSync | null = null;
	/** Held across authentication and the entire native run. */
	private running_ = false;
	/** Intent of the active request, used to pause remote polls during a full sync. */
	private runningIntent_: SyncIntent | null = null;
	/** Shutdown prevents callbacks and synchronizer follow-ups from reviving the scheduler. */
	private stopped_ = false;
	/** Recurrent timers are installed once, even while one-shot callbacks are being handled. */
	private recurrentSyncSetup_ = false;

	/** Bind native execution and pending status. Cadences are measured in milliseconds. */
	public constructor(
		private readonly run_: (options: SyncStartOptions, wifiCheck: boolean)=> Promise<unknown>,
		private readonly pendingChanged_: (pending: boolean)=> void,
		private readonly intervalMs_: number,
		private readonly reportError_: ()=> void,
		/** Wait after a periodic full sync settles before starting another; defaults to two minutes. */
		private readonly fullIntervalMs_ = 120000,
	) {}

	/** A queued request remains pending even while another run is active. */
	public get pending() { return this.request_ !== null; }

	/** Classify the explicit periodic poll separately from local upload requests. */
	private intentFor(options: SyncStartOptions): SyncIntent {
		if (options.remoteChangesOnly) return 'poll';
		return options.syncSteps?.toString() === Synchronizer.partialSyncSteps.toString() ? 'upload' : 'full';
	}

	/** Merge requests before any asynchronous work, so authentication cannot race another request. */
	public schedule(delay: number, options: SyncStartOptions, wifiCheck: boolean): Promise<void> {
		if (this.stopped_) return Promise.resolve();
		const due = Date.now() + delay;
		const intent = this.intentFor(options);
		const promise = new Promise<void>((resolve, reject) => {
			if (!this.request_) {
				this.request_ = { intent, options, due, wifiCheck, resolve: [{ resolve, reject }] };
			} else {
				this.mergeRequest_(this.request_, intent, options, due);
				// An explicit request may run even if a periodic request needs a Wi-Fi check.
				this.request_.wifiCheck = this.request_.wifiCheck && wifiCheck;
				this.request_.resolve.push({ resolve, reject });
			}
		});
		this.pendingChanged_(true);
		this.arm();
		return promise;
	}

	/** Combine queued intents without letting a poll erase a pending upload. */
	private mergeRequest_(request: PendingSync, nextIntent: SyncIntent, nextOptions: SyncStartOptions, nextDue: number) {
		const previousIntent = request.intent;

		if (previousIntent === 'full') {
			// A full sync already covers either kind of partial work.
			request.due = Math.min(request.due, nextDue);
			return;
		}

		if (nextIntent === 'full') {
			request.intent = 'full';
			request.options = nextOptions;
			request.due = Math.min(request.due, nextDue);
			return;
		}

		if (previousIntent === nextIntent) {
			if (nextIntent === 'upload') {
				// Keep the established latest-edit debounce and latest upload options.
				request.options = nextOptions;
				request.due = nextDue;
			} else {
				// Poll ticks coalesce without moving an earlier poll deadline later.
				request.due = Math.min(request.due, nextDue);
			}
			return;
		}

		// A poll and an upload together become a full sync, preserving auxiliary
		// options while removing the fields that would limit it to either intent.
		const fullOptions: SyncStartOptions = { ...request.options, ...nextOptions };
		delete fullOptions.syncSteps;
		delete fullOptions.remoteChangesOnly;
		request.intent = 'full';
		request.options = fullOptions;
		request.due = Math.min(request.due, nextDue);
	}

	/** Keep one deadline while idle; requests during a run are handled by its completion. */
	private arm() {
		if (this.timeout_) shim.clearTimeout(this.timeout_);
		this.timeout_ = null;
		if (this.stopped_ || this.running_ || !this.request_) return;
		const delay = Math.max(0, this.request_.due - Date.now());
		this.timeout_ = shim.setTimeout(() => { void this.flush(); }, delay);
	}

	/** Consume only the request being run; writes arriving during it remain available afterward. */
	private async flush() {
		this.timeout_ = null;
		if (this.stopped_ || this.running_ || !this.request_) return;
		const request = this.request_;
		this.request_ = null;
		this.running_ = true;
		this.runningIntent_ = request.intent;
		if (request.intent === 'full') this.clearPollTimeout_();
		this.pendingChanged_(false);
		try {
			await this.run_(request.options, request.wifiCheck);
			for (const caller of request.resolve) caller.resolve();
		} catch (error) {
			for (const caller of request.resolve) caller.reject(error);
		} finally {
			this.running_ = false;
			this.runningIntent_ = null;
			this.pendingChanged_(this.pending);
			// A failure consumes its own request; only a new edit/tick can request another run.
			this.arm();
			if (request.intent === 'full' || request.intent === 'poll') this.scheduleNextRemotePoll_();
		}
	}

	/** Start independent remote-poll and periodic full-sync completion-based delays. */
	public setupRecurrentSync() {
		if (this.stopped_ || this.recurrentSyncSetup_) return;
		this.recurrentSyncSetup_ = true;
		this.scheduleNextRemotePoll_();
		this.scheduleNextFullSync_();
	}

	/** Schedule a remote check only when no full sync is active or already queued. */
	private scheduleNextRemotePoll_() {
		if (this.stopped_ || !this.recurrentSyncSetup_ || this.pollTimeout_) return;
		if (this.runningIntent_ === 'full' || this.request_?.intent === 'full') return;
		if (this.runningIntent_ === 'poll' || this.request_?.intent === 'poll') return;
		this.pollTimeout_ = shim.setTimeout(() => {
			this.pollTimeout_ = null;
			if (this.stopped_ || this.runningIntent_ === 'full' || this.request_?.intent === 'full') return;
			void this.scheduleRecurring_({ remoteChangesOnly: true });
		}, this.intervalMs_);
	}

	/** Cancel a remote poll deadline when a full sync takes over its work. */
	private clearPollTimeout_() {
		if (this.pollTimeout_) shim.clearTimeout(this.pollTimeout_);
		this.pollTimeout_ = null;
	}

	/** Start the next full-sync delay; only a settled periodic full sync calls this again. */
	private scheduleNextFullSync_() {
		if (this.stopped_ || this.fullTimeout_) return;
		this.fullTimeout_ = shim.setTimeout(() => {
			this.fullTimeout_ = null;
			void this.runPeriodicFullSync_();
		}, this.fullIntervalMs_);
	}

	/** Wait for the full request, including any coalesced work, before restarting its delay. */
	private async runPeriodicFullSync_() {
		try {
			await this.scheduleRecurring_({});
		} finally {
			this.scheduleNextFullSync_();
		}
	}

	/** Keep periodic errors reported while joining the same coalesced request. */
	private async scheduleRecurring_(options: SyncStartOptions) {
		try {
			await this.schedule(0, options, true);
		} catch {
			this.reportError_();
		}
	}

	/** Resolve queued callers and remove all timers without touching the active native run. */
	public stop() {
		this.stopped_ = true;
		this.clearPollTimeout_();
		if (this.fullTimeout_) shim.clearTimeout(this.fullTimeout_);
		if (this.timeout_) shim.clearTimeout(this.timeout_);
		this.fullTimeout_ = null;
		this.timeout_ = null;
		for (const caller of this.request_?.resolve ?? []) caller.resolve();
		this.request_ = null;
		this.pendingChanged_(false);
	}
}
