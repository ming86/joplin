import Logger from '@joplin/utils/Logger';
import JoplinDatabase from './JoplinDatabase';
import Setting from './models/Setting';
import shim from './shim';
import SyncTargetRegistry from './SyncTargetRegistry';
import { AnyAction, Dispatch } from 'redux';
import Synchronizer, { SyncStartOptions } from './Synchronizer';
import BaseSyncTarget from './BaseSyncTarget';

/** Headless timing policy; the registry still owns native synchronization execution. */
export interface SyncSchedulingPolicy {
	/** Whether a request is waiting for the current operation or its due time. */
	readonly pending: boolean;
	/** Coalesce a request and resolve when that request has been serviced or cancelled. */
	schedule(delay: number, options: SyncStartOptions, wifiCheck: boolean): Promise<void>;
	/** Start periodic inbound checks without resetting an existing timer. */
	setupRecurrentSync(): void;
	/** Cancel future requests; an already running native operation is drained separately. */
	stop(): void;
}

/** Construct a policy around the registry's existing authenticated, context-saving execution path. */
export type SyncSchedulingPolicyFactory = (
	run: (options: SyncStartOptions, wifiCheck: boolean)=> Promise<unknown>,
	pendingChanged: (pending: boolean)=> void,
)=> SyncSchedulingPolicy;

class Registry {

	/** Present only while the headless service owns synchronization scheduling. */
	private syncSchedulingPolicy_: SyncSchedulingPolicy | null = null;
	private syncTargets_: Record<number, BaseSyncTarget> = {};
	private logger_: Logger = null;
	private schedSyncCalls_: boolean[] = [];
	private waitForReSyncCalls_: boolean[] = [];
	private setupRecurrentCalls_: boolean[] = [];
	private timerCallbackCalls_: boolean[] = [];
	private showErrorMessageBoxHandler_: (message: string)=> void;
	private scheduleSyncId_: ReturnType<typeof shim.setTimeout> = null;
	private recurrentSyncId_: ReturnType<typeof shim.setInterval> = null;
	private db_: JoplinDatabase;
	private isOnMobileData_ = false;
	private dispatch_: Dispatch = (() => {}) as Dispatch;

	public logger() {
		if (!this.logger_) {
			// console.warn('Calling logger before it is initialized');
			return new Logger();
		}

		return this.logger_;
	}

	public setLogger(l: Logger) {
		this.logger_ = l;
	}

	public setShowErrorMessageBoxHandler(v: (message: string)=> void) {
		this.showErrorMessageBoxHandler_ = v;
	}

	public showErrorMessageBox(message: string) {
		if (!this.showErrorMessageBoxHandler_) return;
		this.showErrorMessageBoxHandler_(message);
	}

	public setDispatch(dispatch: Dispatch) {
		this.dispatch_ = dispatch;
	}

	private dispatch(action: AnyAction) {
		return this.dispatch_(action);
	}

	// If isOnMobileData is true, the doWifiConnectionCheck is not set
	// and the sync.mobileWifiOnly setting is true it will cancel the sync.
	public setIsOnMobileData(isOnMobileData: boolean) {
		this.isOnMobileData_ = isOnMobileData;
	}

	public resetSyncTarget(syncTargetId: number = null) {
		if (syncTargetId === null) syncTargetId = Setting.value('sync.target');
		delete this.syncTargets_[syncTargetId];
	}

	public syncTargetNextcloud() {
		return this.syncTarget(SyncTargetRegistry.nameToId('nextcloud'));
	}

	// There is a delay of at least 1 second to avoid using excessive data usage, as the full note contents are uploaded every time a change is made.
	// On desktop this delay is longer, to avoid distraction to the user due to the sync button continually stopping and starting spinning
	public syncAsYouTypeInterval() {
		if (shim.isElectron()) {
			return 15 * 1000;
		} else {
			return 1000;
		}
	}

	public defaultScheduleInterval() {
		return 1000 * 10;
	}

	public syncTarget = (syncTargetId: number = null) => {
		if (syncTargetId === null) syncTargetId = Setting.value('sync.target');
		if (this.syncTargets_[syncTargetId]) return this.syncTargets_[syncTargetId];

		const SyncTargetClass = SyncTargetRegistry.classById(syncTargetId);
		if (!this.db()) throw new Error('Cannot initialize sync without a db');

		const target = new SyncTargetClass(this.db());
		target.setLogger(this.logger());
		this.syncTargets_[syncTargetId] = target;
		return target;
	};

	// This can be used when some data has been modified and we want to make
	// sure it gets synced. So we wait for the current sync operation to
	// finish (if one is running), then we trigger a sync just after.
	public waitForSyncFinishedThenSync = async () => {
		if (!Setting.value('sync.target')) {
			this.logger().info('waitForSyncFinishedThenSync - cancelling because no sync target is selected.');
			return;
		}

		this.waitForReSyncCalls_.push(true);
		try {
			const synchronizer = await this.syncTarget().synchronizer();
			await synchronizer.waitForSyncToFinish();
			await this.scheduleSync(0);
		} finally {
			this.waitForReSyncCalls_.pop();
		}
	};

	/** Install a service-specific timing policy without changing other clients' scheduling. */
	public setSyncSchedulingPolicy(factory: SyncSchedulingPolicyFactory | null) {
		this.syncSchedulingPolicy_?.stop();
		this.syncSchedulingPolicy_ = factory ? factory(
			(options, wifiCheck) => this.scheduleSync_(0, options, wifiCheck),
			pending => this.dispatch({ type: 'SYNC_PENDING_UPDATE', value: pending }),
		) : null;
	}

	/** Null means the standard client scheduler supplies its existing Redux pending flag. */
	public syncSchedulingPending(): boolean | null {
		return this.syncSchedulingPolicy_?.pending ?? null;
	}

	public scheduleSync = async (delay: number = null, syncOptions: SyncStartOptions = null, doWifiConnectionCheck = false) => {
		if (this.syncSchedulingPolicy_) {
			return this.syncSchedulingPolicy_.schedule(delay ?? this.defaultScheduleInterval(), syncOptions ?? {}, doWifiConnectionCheck);
		}
		return this.scheduleSync_(delay, syncOptions, doWifiConnectionCheck);
	};

	/** Execute the established scheduler path, including authentication, context and error handling. */
	private scheduleSync_ = async (delay: number = null, syncOptions: SyncStartOptions = null, doWifiConnectionCheck = false) => {
		this.schedSyncCalls_.push(true);

		try {
			if (delay === null) delay = this.defaultScheduleInterval();
			if (syncOptions === null) syncOptions = {};

			let promiseResolve: ((value?: unknown)=> void) = null;
			let promiseReject: (error: unknown)=> void = null;
			const promise = new Promise((resolve, reject) => {
				promiseResolve = resolve;
				promiseReject = reject;
			});

			if (this.scheduleSyncId_) {
				shim.clearTimeout(this.scheduleSyncId_);
				this.scheduleSyncId_ = null;
			}

			const syncTargetId = Setting.value('sync.target');
			const isAuthenticated = syncTargetId ? await this.syncTarget(syncTargetId).isAuthenticated() : false;
			const isPartialSync = syncOptions.syncSteps?.toString() === Synchronizer.partialSyncSteps.toString();

			if (isAuthenticated && isPartialSync) {
				// Only dispatch the event if a partial sync is scheduled, which is triggered by making a change
				this.dispatch({ type: 'SYNC_PENDING_UPDATE', value: true });
			}

			if (Setting.value('env') === 'dev' && delay !== 0) {
				// this.logger().info('Schedule sync DISABLED!!!');
				// return;
			}

			this.logger().debug('Scheduling sync operation...', delay);

			const timeoutCallback = async () => {
				this.timerCallbackCalls_.push(true);
				let newContext;

				try {
					this.scheduleSyncId_ = null;
					this.logger().info('Preparing scheduled sync');

					if (doWifiConnectionCheck && Setting.value('sync.mobileWifiOnly') && this.isOnMobileData_) {
						this.logger().info('Sync cancelled because we\'re on mobile data');
						promiseResolve();
						return;
					}

					const syncTargetId = Setting.value('sync.target');

					if (!syncTargetId) {
						this.logger().info('Sync cancelled - no sync target is selected.');
						promiseResolve();
						return;
					}

					if (!(await this.syncTarget(syncTargetId).isAuthenticated())) {
						this.dispatch({
							type: 'MUST_AUTHENTICATE',
							value: true,
						});
						this.logger().info('Synchroniser is missing credentials - manual sync required to authenticate.');
						promiseResolve();
						return;
					}
					this.dispatch({
						type: 'MUST_AUTHENTICATE',
						value: false,
					});

					let syncStage = 'initialize-synchronizer';
					try {
						const sync = await this.syncTarget(syncTargetId).synchronizer();

						syncStage = 'load-context';
						const contextKey = `sync.${syncTargetId}.context`;
						let context = Setting.value(contextKey);
						try {
							context = context ? JSON.parse(context) : {};
						} catch (error) {
							syncOptions.onError?.(error, 'parse-context');
							// Clearing the context is inefficient since it means all items are going to be re-downloaded
							// however it won't result in duplicate items since the synchroniser is going to compare each
							// item to the current state.
							this.logger().warn(`Could not parse JSON sync context ${contextKey}:`, context);
							this.logger().info('Clearing context and starting from scratch');
							context = null;
						}

						try {
							syncStage = 'synchronize';
							this.logger().info('Starting scheduled sync');
							const options = { ...syncOptions, context: context };
							if (!options.saveContextHandler) {
								options.saveContextHandler = (newContext: unknown) => {
									Setting.setValue(contextKey, JSON.stringify(newContext));
								};
							}
							newContext = await sync.start(options);
							syncStage = 'save-context';
							Setting.setValue(contextKey, JSON.stringify(newContext));
						} catch (error) {
							if (error.code === 'alreadyStarted') {
								this.logger().info(error.message);
								newContext = null; // Prevent resetting syncPending to false if another sync is triggered while one is in progress
							} else {
								promiseResolve();
								throw error;
							}
						}
					} catch (error) {
						syncOptions.onError?.(error, syncStage);
						this.logger().info('Could not run background sync:');
						this.logger().info(error);
					}
					this.setupRecurrentSync();
					promiseResolve();

				} catch (error) {
					// Preparation (including the second authentication check) must settle the
					// scheduled operation even though timer callbacks have no awaiting caller.
					promiseReject(error);
				} finally {
					if (newContext === undefined) {
						// If the logic in the try block returns before executing the sync, ensure syncPending is reset back to false
						this.dispatch({ type: 'SYNC_PENDING_UPDATE', value: false });
					}

					this.timerCallbackCalls_.pop();
				}
			};

			if (delay === 0) {
				void timeoutCallback();
			} else {
				this.scheduleSyncId_ = shim.setTimeout(timeoutCallback, delay);
			}
			return promise;

		} finally {
			this.schedSyncCalls_.pop();
		}
	};

	public setupRecurrentSync() {
		if (this.syncSchedulingPolicy_) {
			this.syncSchedulingPolicy_.setupRecurrentSync();
			return;
		}
		this.setupRecurrentCalls_.push(true);

		try {
			if (this.recurrentSyncId_) {
				shim.clearInterval(this.recurrentSyncId_);
				this.recurrentSyncId_ = null;
			}

			if (!Setting.value('sync.interval')) {
				this.logger().debug('Recurrent sync is disabled');
			} else {
				this.logger().debug(`Setting up recurrent sync with interval ${Setting.value('sync.interval')}`);

				if (Setting.value('env') === 'dev') {
					this.logger().info('Recurrent sync operation DISABLED!!!');
					return;
				}

				this.recurrentSyncId_ = shim.setInterval(() => {
					this.logger().info('Running background sync on timer...');
					void this.scheduleSync(0, null, true);
				}, 1000 * Setting.value('sync.interval'));
			}
		} finally {
			this.setupRecurrentCalls_.pop();
		}
	}

	public setDb = (v: JoplinDatabase) => {
		this.db_ = v;
	};

	public db() {
		return this.db_;
	}

	private cancelTimers_() {
		if (this.recurrentSyncId_) {
			shim.clearInterval(this.recurrentSyncId_);
			this.recurrentSyncId_ = null;
		}
		if (this.scheduleSyncId_) {
			shim.clearTimeout(this.scheduleSyncId_);
			this.scheduleSyncId_ = null;
		}
	}

	public cancelTimers = async () => {
		this.logger().info('Cancelling sync timers');
		this.syncSchedulingPolicy_?.stop();
		this.cancelTimers_();

		return new Promise((resolve) => {
			const cancellationPoll = shim.setInterval(() => {
				// ensure processing complete
				if (!this.setupRecurrentCalls_.length && !this.schedSyncCalls_.length && !this.timerCallbackCalls_.length && !this.waitForReSyncCalls_.length) {
					this.cancelTimers_();
					shim.clearInterval(cancellationPoll);
					resolve(null);
				}
			}, 100);
		});
	};

}

export type { Registry };

const reg = new Registry();

// eslint-disable-next-line import/prefer-default-export
export { reg };
