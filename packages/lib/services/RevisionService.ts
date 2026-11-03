import ItemChange from '../models/ItemChange';
import Note from '../models/Note';
import Folder from '../models/Folder';
import Setting from '../models/Setting';
import Revision, { RevisionContent } from '../models/Revision';
import BaseModel, { DeleteOptions } from '../BaseModel';
import ItemChangeUtils from './ItemChangeUtils';
import shim from '../shim';
import BaseService from './BaseService';
import { _ } from '../locale';
import { ItemChangeEntity, NoteEntity, RevisionEntity } from './database/types';
import Logger from '@joplin/utils/Logger';
import isNoteLockEnabled from './noteLock/isNoteLockEnabled';
import NoteLockNote from './noteLock/NoteLockNote';
import { MarkupLanguage } from '../../renderer';
import { substrWithEllipsis } from '../string-utils';
const { sprintf } = require('sprintf-js');
import { wrapError } from '../errorUtils';
import { Mutex } from 'async-mutex';
import fastDeepEqual = require('fast-deep-equal');
import { reportHeadlessPerformance } from './HeadlessPerformance';

const logger = Logger.create('RevisionService');

export default class RevisionService extends BaseService {

	public static instance_: RevisionService;

	private changedSinceCollectionCache_: Set<string> = new Set();
	private maintenanceCalls_: boolean[] = [];
	private maintenanceTimer1_: ReturnType<typeof shim.setTimeout> = null;
	private maintenanceTimer2_: ReturnType<typeof shim.setInterval> = null;
	private isCollecting_ = false;
	/** Completed notes in the active collector run; null between runs, and invalidated when history is cleared. */
	private collectionCompletedNoteIds_: Set<string> = null;
	public isRunningInBackground_ = false;
	/** Active item locks; each entry counts its current owner and queued callers. */
	private revisionMutexes_ = new Map<string, { mutex: Mutex; users: number }>();

	public static instance() {
		if (this.instance_) return this.instance_;
		this.instance_ = new RevisionService();
		return this.instance_;
	}

	// An "old note" is a note which is without any history, or has not had a revision created since the defined oldNoteInterval.
	// Originally this concept was introduced to define a note that was created before the revision service existed, but actually
	// this also applies to any note that is history-less, which is also the case for notes which have been imported, or notes which
	// had their note history deleted by the user or by the revision cleaner.
	// These notes are without revisions so the first time they are modified, a copy of the original note is saved. The goal is to
	// have at least one revision in case the note is deleted or modified as a result of a bug or user mistake.
	// Also, because of the fact that the revision collection will not always create a revision for the latest change (due to the
	// intervalBetweenRevisions restriction), it is beneficial to determine an old note based on an interval rather than solely on
	// the existence of at least 1 revision for a note. Therefore it is beneficial for the old note concept to include any note
	// which has not been changed since the defined oldNoteInterval.
	public oldNoteCutOffDate_() {
		return Date.now() - Setting.value('revisionService.oldNoteInterval');
	}

	/** Whether a successful note save has occurred since collection; querying does not mark it. */
	public changedSinceCollection(noteId: string) {
		return this.changedSinceCollectionCache_.has(noteId);
	}

	/** Mark only a successfully saved note as having an outstanding collector change. */
	public markChangedSinceCollection(noteId: string) {
		this.changedSinceCollectionCache_.add(noteId);
	}

	/** Coordinate one item's history; callbacks must not reacquire the same item lock. SQLite still serializes transactions. */
	public async withRevisionLock<T>(itemId: string, action: ()=> Promise<T>, itemType = BaseModel.TYPE_NOTE): Promise<T> {
		const key = `${itemType}:${itemId}`;
		let entry = this.revisionMutexes_.get(key);
		if (!entry) {
			entry = { mutex: new Mutex(), users: 0 };
			this.revisionMutexes_.set(key, entry);
		}
		entry.users++;
		const queuedAt = Date.now();
		let acquiredAt: number;
		try {
			return await entry.mutex.runExclusive(async () => {
				acquiredAt = Date.now();
				try {
					return await action();
				} finally {
					reportHeadlessPerformance(logger, { stage: 'historyLock', itemType, itemId, waitMs: acquiredAt - queuedAt, holdMs: Date.now() - acquiredAt });
				}
			});
		} finally {
			entry.users--;
			if (!entry.users) this.revisionMutexes_.delete(key);
		}
	}

	/** Hold all affected note locks in stable order, preserving multi-note clear semantics. */
	public async withNoteRevisionLocks<T>(noteIds: string[], action: ()=> Promise<T>): Promise<T> {
		const ids = [...new Set(noteIds)].sort();
		const acquire = (index: number): Promise<T> => index === ids.length ? action() : this.withRevisionLock(ids[index], () => acquire(index + 1));
		return acquire(0);
	}

	public removeChangedSinceCollection(noteId: string) {
		this.changedSinceCollectionCache_.delete(noteId);
	}

	private noteMetadata_(note: NoteEntity) {
		const excludedFields = ['type_', 'title', 'body', 'created_time', 'updated_time', 'encryption_applied', 'encryption_cipher_text', 'is_conflict', 'user_data'];
		const md: Record<string, unknown> = {};
		const noteRecord = note as unknown as Record<string, unknown>;
		for (const k in note) {
			if (excludedFields.indexOf(k) >= 0) continue;
			md[k] = noteRecord[k];
		}

		if (note.user_updated_time === note.updated_time) delete md.user_updated_time;
		if (note.user_created_time === note.created_time) delete md.user_created_time;

		return md;
	}

	/** Normalize exactly the fields native revision diffs retain, excluding automatic timestamps. */
	public noteRevisionContent(note: NoteEntity): RevisionContent {
		return { title: note.title || '', body: note.body || '', metadata: this.noteMetadata_(note) };
	}

	/** Whether native history must start with full contents instead of depending on the previous revision. */
	public startsNewRevisionChain(note: NoteEntity, parent: RevisionEntity): boolean {
		return !parent || !!parent.is_locked !== !!note.is_locked || (isNoteLockEnabled() && NoteLockNote.isLocked(note));
	}

	/** Build an unsaved native diff or standalone lock snapshot; null means no tracked diff remains. */
	public prepareNoteRevision(note: NoteEntity, parent: RevisionEntity, parentContent: RevisionContent, itemUpdatedTime = note.updated_time): RevisionEntity {
		const content = this.noteRevisionContent(note);
		// Lock transitions sever ancestry even with the feature off. With it on, ciphertext
		// snapshots always stand alone so clearing plaintext history cannot orphan them.
		const startsNewChain = this.startsNewRevisionChain(note, parent);
		const base = startsNewChain ? null : parentContent;
		const revision: RevisionEntity = {
			parent_id: startsNewChain ? '' : parent.id,
			item_type: BaseModel.TYPE_NOTE,
			item_id: note.id,
			// Captures can be newer than a subsequently synced note. Keep native parent selection
			// and timestamp-based reconstruction ordered even when the note's timestamp is earlier.
			item_updated_time: Math.max(itemUpdatedTime, parent ? parent.item_updated_time + 1 : 0),
			// Retain the marker with the feature off too: the body still contains ciphertext.
			is_locked: note.is_locked ? 1 : 0,
			title_diff: Revision.createTextPatch(base?.title || '', content.title),
			body_diff: Revision.createTextPatch(base?.body || '', content.body),
			metadata_diff: Revision.createObjectPatch(base?.metadata || {}, content.metadata),
		};
		return Revision.isEmptyRevision(revision) ? null : revision;
	}

	/** Persist sampled history, retaining collection intervals and independent ciphertext snapshots. */
	public async createNoteRevision_(note: NoteEntity, parentRevId: string = null, bypassInterval = false): Promise<RevisionEntity> {
		return this.withRevisionLock(note.id, () => this.createNoteRevisionUnlocked_(note, parentRevId, bypassInterval));
	}

	/** Prepare and persist sampled history while the caller owns this note's lock. */
	private async createNoteRevisionUnlocked_(note: NoteEntity, parentRevId: string = null, bypassInterval = false): Promise<RevisionEntity> {
		try {
			const parentRev = parentRevId ? await Revision.load(parentRevId) : await Revision.latestRevision(BaseModel.TYPE_NOTE, note.id);

			const lockStateChanged = parentRev && !!parentRev.is_locked !== !!note.is_locked;
			const lockedSnapshot = isNoteLockEnabled() && NoteLockNote.isLocked(note);
			if (parentRev && (!lockStateChanged || lockedSnapshot) && !bypassInterval && Date.now() - parentRev.updated_time < Setting.value('revisionService.intervalBetweenRevisions')) return null;
			const parentContent = this.startsNewRevisionChain(note, parentRev) ? null : await Revision.mergeDiffs(parentRev);
			const output = this.prepareNoteRevision(note, parentRev, parentContent);
			return output ? Revision.save(output) : null;
		} catch (error) {
			const newError = wrapError(`Could not create revision for note: ${note.id}`, error);
			throw newError;
		}
	}

	public async collectRevisions() {
		if (this.isCollecting_) return;
		this.isCollecting_ = true;
		this.collectionCompletedNoteIds_ = new Set();
		try {
			await this.collectRevisions_();
		} finally {
			this.collectionCompletedNoteIds_ = null;
			this.isCollecting_ = false;
		}
	}

	/** Keep one ordered collector cursor, acquiring only the affected note lock for each change. */
	private async collectRevisions_() {

		await ItemChange.waitForAllSaved();

		const doneNoteIds = this.collectionCompletedNoteIds_;

		try {
			while (true) {
				// See synchronizer test units to see why changes coming
				// from sync are skipped.
				const changes: ItemChangeEntity[] = await ItemChange.modelSelectAll(
					`
					SELECT id, item_id, type, before_change_item
					FROM item_changes
					WHERE item_type = ?
					AND source != ?
					AND source != ?
					AND id > ?
					ORDER BY id ASC
					LIMIT 10
				`,
					[BaseModel.TYPE_NOTE, ItemChange.SOURCE_SYNC, ItemChange.SOURCE_DECRYPTION, Setting.value('revisionService.lastProcessedChangeId')],
				);

				if (!changes.length) break;

				for (let i = 0; i < changes.length; i++) {
					const change = changes[i];
					const noteId = change.item_id;

					try {
						await this.withRevisionLock(noteId, async () => {
							// A clear can replace this row while collection waits. Leave its replacement
							// to normal cursor order rather than skipping other notes' intervening changes.
							if (!await ItemChange.modelSelectOne('SELECT id FROM item_changes WHERE id = ?', [change.id])) return;
							if (change.type === ItemChange.TYPE_UPDATE && !doneNoteIds.has(noteId)) {
								const note = await Note.modelSelectOne('SELECT * FROM notes WHERE id = ? AND is_conflict = 0 AND encryption_applied = 0', [noteId]);
								const oldNote = change.before_change_item ? JSON.parse(change.before_change_item) : null;

								if (note) {
									const latest = await Revision.latestRevision(BaseModel.TYPE_NOTE, note.id);
									const latestContent = this.startsNewRevisionChain(note, latest) ? null : await Revision.mergeDiffs(latest);
									// Immediate MCP capture already retained both sides. Do not append the queued old
									// snapshot after that newer result when the collector later sees its ItemChange.
									const alreadyCaptured = latestContent && latest.item_updated_time >= note.updated_time && fastDeepEqual(latestContent, this.noteRevisionContent(note));
									let oldNoteSaved = false;

									if (!alreadyCaptured && oldNote && oldNote.updated_time < this.oldNoteCutOffDate_()) {
										// This is where we save the original version of this old note
										// We need to use the more recent timestamp, because if the last update was a long time ago, the revision could get immediately removed by the cleaner
										// We also want to avoid creating 2 revisions with exactly the same timestamp, so deduct 1 ms from the timestamp on the old revision to avoid this
										oldNote.updated_time = note.updated_time - 1;
										oldNote.user_updated_time = oldNote.updated_time;
										const rev = await this.createNoteRevisionUnlocked_(oldNote);
										if (rev) {
											oldNoteSaved = true;
											logger.debug(sprintf('collectRevisions: Saved revision %s (old note)', rev.id));
										}
									}

									const rev = alreadyCaptured ? null : await this.createNoteRevisionUnlocked_(note, null, oldNoteSaved);
									if (rev) logger.debug(sprintf('collectRevisions: Saved revision %s (Last rev was more than %d ms ago)', rev.id, Setting.value('revisionService.intervalBetweenRevisions')));
									doneNoteIds.add(noteId);

									this.changedSinceCollectionCache_.delete(noteId);
								}
							}

							if (change.type === ItemChange.TYPE_DELETE && !!change.before_change_item) {
								const note = JSON.parse(change.before_change_item);
								const revExists = await Revision.revisionExists(BaseModel.TYPE_NOTE, note.id, note.updated_time);
								if (!revExists) {
									const rev = await this.createNoteRevisionUnlocked_(note);
									if (rev) logger.debug(sprintf('collectRevisions: Saved revision %s (for deleted note)', rev.id));
								}
								doneNoteIds.add(noteId);
							}
						});
					} catch (error) {
						if (error.code === 'revision_encrypted') {
							throw error;
						} else {
							// If any revision creation fails, we continue
							// processing the other changes. It seems a rare bug
							// in diff-match-patch can cause the creation of
							// revisions to fail in some case. It should be rare
							// and it's best to continue processing the other
							// changes. The alternative would be to stop here
							// and fix the bug, but in the meantime revisions
							// will no longer be generated.

							// The drawback is that once a change has been
							// skipped it will never be processed again because
							// the error will be in the past (before
							// revisionService.lastProcessedChangeId)
							//
							// https://github.com/laurent22/joplin/issues/5531
							logger.error(`collectRevisions: Processing one of the changes for note ${noteId} failed. Other changes will still be processed. Error was: `, error);
							logger.error('collectRevisions: Change context:', { id: change.id, noteId, type: change.type });
						}
					}

					Setting.setValue('revisionService.lastProcessedChangeId', change.id);
				}
			}
		} catch (error) {
			if (error.code === 'revision_encrypted') {
				// One or more revisions are encrypted - stop processing for now
				// and these revisions will be processed next time the revision
				// collector runs.
				logger.info('collectRevisions: One or more revision was encrypted. Processing was stopped but will resume later when the revision is decrypted.', error);
			} else {
				// This should not happen anymore because we handle the error in
				// the loop above.
				logger.error('collectRevisions:', error);
			}
		}

		await Setting.saveAll();
		await ItemChangeUtils.deleteProcessedChanges();

		logger.info(`collectRevisions: Created revisions for ${doneNoteIds.size} notes`);
	}

	/** Prune expired history through the native model, which coordinates each affected item. */
	public async deleteOldRevisions(ttl: number) {
		return Revision.deleteOldRevisions(ttl);
	}

	/** Reconstruct a selected native revision while excluding pruning and history clearing for its item. */
	public async revisionNote(revisions: RevisionEntity[], index: number) {
		if (index < 0 || index >= revisions.length) throw new Error(`Invalid revision index: ${index}`);
		const selected = revisions[index];
		// Native viewers may supply an in-memory history snapshot. Keep it intact; merging
		// that complete list performs no database reads and cannot mix pre/post-prune rows.
		return this.withRevisionLock(selected.item_id, () => this.revisionNoteUnlocked_(selected, revisions), selected.item_type);
	}

	/** Reconstruct a complete native snapshot while the caller holds the item's history lock. */
	private async revisionNoteUnlocked_(revision: RevisionEntity, revisions: RevisionEntity[]) {
		const merged = await Revision.mergeDiffs(revision, revisions);

		const output: NoteEntity = {
			title: merged.title,
			body: merged.body,
			...merged.metadata,
		};
		output.updated_time = output.user_updated_time;
		output.created_time = output.user_created_time;
		(output as NoteEntity & { type_?: number }).type_ = BaseModel.TYPE_NOTE;
		if (!('markup_language' in output)) output.markup_language = MarkupLanguage.Markdown;

		return output;
	}

	public restoreFolderTitle() {
		return _('Restored Notes');
	}

	public async restoreFolder() {
		let folder = await Folder.loadByFields({
			title: this.restoreFolderTitle(),
			deleted_time: 0,
		});
		if (!folder) {
			folder = await Folder.save({ title: this.restoreFolderTitle() });
		}
		return folder;
	}

	/** Restore a retained snapshot into a new note; index 0 selects the latest and 1 its predecessor. */
	public async restoreNoteById(noteId: string, reverseRevIndex: number): Promise<NoteEntity> {
		const note = await this.withRevisionLock(noteId, async () => {
			const revisions = await Revision.allByType(BaseModel.TYPE_NOTE, noteId);
			if (!revisions.length) throw new Error(`No revision for note "${noteId}"`);
			const revIndex = revisions.length - 1 - reverseRevIndex;
			if (revIndex < 0 || revIndex >= revisions.length) throw new Error(`Invalid revision index: ${revIndex}`);
			return this.revisionNoteUnlocked_(revisions[revIndex], revisions);
		});
		return this.importRevisionNote(note);
	}

	public restoreSuccessMessage(note: NoteEntity): string {
		return _('The note "%s" has been successfully restored to the notebook "%s".', substrWithEllipsis(note.title, 0, 32), this.restoreFolderTitle());
	}

	public async importRevisionNote(note: NoteEntity): Promise<NoteEntity> {
		const toImport = { ...note };
		delete toImport.id;
		delete toImport.updated_time;
		delete toImport.created_time;
		delete toImport.encryption_applied;
		delete toImport.encryption_cipher_text;

		const folder = await this.restoreFolder();

		toImport.parent_id = folder.id;

		return Note.save(toImport);
	}

	public async maintenance() {
		this.maintenanceCalls_.push(true);
		try {
			const startTime = Date.now();
			logger.info('maintenance: Starting...');

			if (!Setting.value('revisionService.enabled')) {
				logger.info('maintenance: Service is disabled');
				// We do as if we had processed all the latest changes so that they can be cleaned up
				// later on by ItemChangeUtils.deleteProcessedChanges().
				Setting.setValue('revisionService.lastProcessedChangeId', await ItemChange.lastChangeId());
				await this.deleteOldRevisions(Setting.value('revisionService.ttlDays') * 24 * 60 * 60 * 1000);
			} else {
				logger.info('maintenance: Service is enabled');
				await this.collectRevisions();
				await this.deleteOldRevisions(Setting.value('revisionService.ttlDays') * 24 * 60 * 60 * 1000);

				logger.info(`maintenance: Done in ${Date.now() - startTime}ms`);
			}
		} catch (error) {
			logger.error('maintenance:', error);
		} finally {
			this.maintenanceCalls_.pop();
		}
	}

	public runInBackground(collectRevisionInterval: number = null) {
		if (this.isRunningInBackground_) return;
		this.isRunningInBackground_ = true;

		if (collectRevisionInterval === null) collectRevisionInterval = 1000 * 60 * 10;

		logger.info(`runInBackground: Starting background service with revision collection interval ${collectRevisionInterval}`);

		this.maintenanceTimer1_ = shim.setTimeout(() => {
			void this.maintenance();
		}, 1000 * 4);

		this.maintenanceTimer2_ = shim.setInterval(() => {
			void this.maintenance();
		}, collectRevisionInterval);
	}

	public async cancelTimers() {
		if (this.maintenanceTimer1_) {
			shim.clearTimeout(this.maintenanceTimer1_);
			this.maintenanceTimer1_ = null;
		}
		if (this.maintenanceTimer2_) {
			shim.clearInterval(this.maintenanceTimer2_);
			this.maintenanceTimer2_ = null;
		}

		return new Promise((resolve) => {
			const iid = shim.setInterval(() => {
				if (!this.maintenanceCalls_.length) {
					shim.clearInterval(iid);
					resolve(null);
				}
			}, 100);
		});
	}

	/** Clear native history and queued old content together under the affected note locks. */
	public async deleteHistoryForNote(noteIds: string | string[], options: DeleteOptions) {
		const ids = Array.isArray(noteIds) ? noteIds : [noteIds];
		await this.withNoteRevisionLocks(ids, async () => {
			await Revision.deleteHistoryForNote(ids, options);
			await this.resetHistoryState_(ids);
		});
	}

	/** Clear plaintext history and queued old content together under the affected note locks. */
	public async deleteUnencryptedHistoryForNote(noteIds: string | string[], options: DeleteOptions) {
		const ids = Array.isArray(noteIds) ? noteIds : [noteIds];
		await this.withNoteRevisionLocks(ids, async () => {
			await Revision.deleteUnencryptedHistoryForNote(ids, options);
			await this.resetHistoryState_(ids);
		});
	}

	/** Remove pre-clear collector snapshots and cache flags while the affected locks remain held. */
	private async resetHistoryState_(noteIds: string[]) {
		// Clear any cached content in the item_changes table and reset the state of the note in the revision service, to ensure that any new revisions created
		// upon revision collection do not include contents which were present prior to triggering the deletion
		for (const noteId of noteIds) {
			await ItemChange.resetOldNoteContent(noteId);
			this.removeChangedSinceCollection(noteId);
			// A later replacement change must be collected even if this run already captured
			// the history that was just removed. The note lock excludes concurrent completion.
			this.collectionCompletedNoteIds_?.delete(noteId);
		}
	}
}
