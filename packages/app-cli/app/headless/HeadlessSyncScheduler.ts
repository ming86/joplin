import Synchronizer, { SyncStartOptions } from '@joplin/lib/Synchronizer';
import type { SyncSchedulingPolicy } from '@joplin/lib/registry';
import shim from '@joplin/lib/shim';

/** One coalesced native sync request, with callers waiting for that request's completion. */
interface PendingSync {
	/** Full sync requests retain their own options when partial requests arrive later. */
	options: SyncStartOptions;
	/** Earliest full-sync deadline, or the latest partial-sync debounce deadline. */
	due: number;
	/** Whether this request must respect the existing mobile-data policy. */
	wifiCheck: boolean;
	/** Waiting callers, resolved together when this request finishes or is cancelled. */
	resolve: { resolve: ()=> void; reject: (error: unknown)=> void }[];
}

/** Schedule native headless sync without overlapping runs or postponing inbound checks on edits. */
export default class HeadlessSyncScheduler implements SyncSchedulingPolicy {
	/** Fixed periodic inbound clock; native runs do not reset it. */
	private interval_: ReturnType<typeof shim.setInterval> | null = null;
	/** One wake-up for the current pending deadline. */
	private timeout_: ReturnType<typeof shim.setTimeout> | null = null;
	/** The only waiting request; later requests merge into it. */
	private request_: PendingSync | null = null;
	/** Held across authentication and the entire native run. */
	private running_ = false;
	/** Shutdown prevents callbacks and synchronizer follow-ups from reviving the scheduler. */
	private stopped_ = false;

	/** Bind native execution and pending status, with interval measured in milliseconds. */
	public constructor(
		private readonly run_: (options: SyncStartOptions, wifiCheck: boolean)=> Promise<unknown>,
		private readonly pendingChanged_: (pending: boolean)=> void,
		private readonly intervalMs_: number,
		private readonly reportError_: ()=> void,
	) {}

	/** A queued request remains pending even while another run is active. */
	public get pending() { return this.request_ !== null; }

	/** Detect the existing upload-only step sequence; all other requests retain full-sync priority. */
	private isPartial(options: SyncStartOptions) {
		return options.syncSteps?.toString() === Synchronizer.partialSyncSteps.toString();
	}

	/** Merge requests before any asynchronous work, so authentication cannot race another request. */
	public schedule(delay: number, options: SyncStartOptions, wifiCheck: boolean): Promise<void> {
		if (this.stopped_) return Promise.resolve();
		const due = Date.now() + delay;
		const promise = new Promise<void>((resolve, reject) => {
			if (!this.request_) {
				this.request_ = { options, due, wifiCheck, resolve: [{ resolve, reject }] };
			} else {
				const previousPartial = this.isPartial(this.request_.options);
				const nextPartial = this.isPartial(options);
				if (previousPartial && !nextPartial) {
					this.request_.options = options;
					this.request_.due = Math.min(this.request_.due, due);
				} else if (!previousPartial && !nextPartial) {
					this.request_.due = Math.min(this.request_.due, due);
				} else if (previousPartial && nextPartial) {
					this.request_.options = options;
					this.request_.due = due;
				}
				// An explicit request may run even if a periodic request needs a Wi-Fi check.
				this.request_.wifiCheck = this.request_.wifiCheck && wifiCheck;
				this.request_.resolve.push({ resolve, reject });
			}
		});
		this.pendingChanged_(true);
		this.arm();
		return promise;
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
		this.pendingChanged_(false);
		try {
			await this.run_(request.options, request.wifiCheck);
			for (const caller of request.resolve) caller.resolve();
		} catch (error) {
			for (const caller of request.resolve) caller.reject(error);
		} finally {
			this.running_ = false;
			this.pendingChanged_(this.pending);
			// A failure consumes its own request; only a new edit/tick can request another run.
			this.arm();
		}
	}

	/** Run inbound checks on a fixed clock, independent of local debounce and run completion. */
	public setupRecurrentSync() {
		if (this.stopped_ || this.interval_) return;
		this.interval_ = shim.setInterval(async () => {
			try {
				await this.schedule(0, {}, true);
			} catch {
				this.reportError_();
			}
		}, this.intervalMs_);
	}

	/** Resolve queued callers and remove all timers without touching the active native run. */
	public stop() {
		this.stopped_ = true;
		if (this.interval_) shim.clearInterval(this.interval_);
		if (this.timeout_) shim.clearTimeout(this.timeout_);
		this.interval_ = null;
		this.timeout_ = null;
		for (const caller of this.request_?.resolve ?? []) caller.resolve();
		this.request_ = null;
		this.pendingChanged_(false);
	}
}
