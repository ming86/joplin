import BaseItem from '../../models/BaseItem';
import Folder from '../../models/Folder';
import Note from '../../models/Note';
import Resource from '../../models/Resource';
import Setting from '../../models/Setting';
import Synchronizer from '../../Synchronizer';
import SyncTargetRegistry from '../../SyncTargetRegistry';
import { reg } from '../../registry';
import { afterAllCleanUp, createNoteAndResource, fileApi, loadEncryptionMasterKey, setupDatabaseAndSynchronizer, sleep, switchClient, synchronizer, synchronizerStart, syncTargetId } from '../../testing/test-utils';
import { fetchSyncInfo, getEncryptionEnabled, uploadSyncInfo } from './syncInfoUtils';

describe('Synchronizer.remoteChangesOnly', () => {
	let originalDispatch: Synchronizer['dispatch'];

	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await setupDatabaseAndSynchronizer(2);
		await switchClient(1);
		originalDispatch = synchronizer(1).dispatch;
		Setting.setConstant('isHeadless', true);
		// Keep the existing native database/synchronizer fixture, using its memory
		// transport to exercise the server-only scheduling intent without a server.
		fileApi().setSyncTargetId(SyncTargetRegistry.nameToId('joplinServer'));
	});

	afterEach(() => {
		jest.restoreAllMocks();
		synchronizer(1).dispatch = originalDispatch;
		Setting.setConstant('isHeadless', false);
		fileApi().setSyncTargetId(syncTargetId());
	});

	afterAll(async () => {
		await afterAllCleanUp();
	});

	it('checkpoints an empty terminal poll without scanning outgoing items or reporting a full sync', async () => {
		await synchronizerStart();
		const deltaContext = { cursor: 'after-poll', statsCache: [] as unknown[], statIdsCache: [] as string[] };
		const delta = jest.spyOn(fileApi(), 'delta').mockResolvedValueOnce({ items: [], hasMore: false, context: deltaContext });
		const itemsThatNeedSync = jest.spyOn(BaseItem, 'itemsThatNeedSync');
		const dispatch = jest.fn();
		synchronizer().dispatch = dispatch;
		const saveContextHandler = jest.fn();

		const output = await synchronizerStart(null, { remoteChangesOnly: true, saveContextHandler, throwOnError: true });

		expect(delta).toHaveBeenCalledTimes(1);
		expect(itemsThatNeedSync).not.toHaveBeenCalled();
		expect(saveContextHandler).toHaveBeenCalledWith({ delta: { cursor: 'after-poll' } });
		expect(output.delta).toEqual(deltaContext);
		expect(dispatch).toHaveBeenCalledWith({ type: 'SYNC_COMPLETED', isFullSync: false });
	});

	it('uses the original cursor for ordinary sync when an empty probe has another page', async () => {
		const originalContext = await synchronizerStart();
		const delta = jest.spyOn(fileApi(), 'delta').mockResolvedValueOnce({ items: [], hasMore: true, context: { cursor: 'unconsumed-probe' } });
		const itemsThatNeedSync = jest.spyOn(BaseItem, 'itemsThatNeedSync');
		const saveContextHandler = jest.fn();
		const dispatch = jest.fn();
		synchronizer().dispatch = dispatch;

		await synchronizerStart(null, { remoteChangesOnly: true, saveContextHandler, throwOnError: true });

		expect(delta).toHaveBeenCalledTimes(2);
		expect((delta.mock.calls[0][1] as unknown as { context: unknown }).context).toEqual(originalContext.delta);
		expect((delta.mock.calls[1][1] as unknown as { context: unknown }).context).toEqual(originalContext.delta);
		expect(itemsThatNeedSync).toHaveBeenCalled();
		expect(saveContextHandler).not.toHaveBeenCalledWith({ delta: { cursor: 'unconsumed-probe' } });
		expect(dispatch).toHaveBeenCalledWith({ type: 'SYNC_COMPLETED', isFullSync: true });
	});

	it('reconciles local edits as conflicts before applying a nonempty remote probe', async () => {
		const folder = await Folder.save({ title: 'folder' });
		const note = await Note.save({ title: 'original', parent_id: folder.id });
		await synchronizerStart();
		await switchClient(2);
		await synchronizerStart();
		await sleep(0.1);
		await Note.save({ id: note.id, title: 'remote edit' });
		await synchronizerStart();
		await switchClient(1);
		await Note.save({ id: note.id, title: 'local edit' });
		const delta = jest.spyOn(fileApi(), 'delta');

		await synchronizerStart(null, { remoteChangesOnly: true, throwOnError: true });

		expect(delta.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect((delta.mock.calls[1][1] as unknown as { context: unknown }).context).toEqual((delta.mock.calls[0][1] as unknown as { context: unknown }).context);
		expect((await Note.load(note.id)).title).toBe('remote edit');
		const conflicts = await Note.conflictedNotes();
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].title).toBe('local edit');
		expect(conflicts[0].conflict_original_id).toBe(note.id);
	});

	it('uploads resource metadata changed by preparation even when the probe is empty', async () => {
		const { resource } = await createNoteAndResource();
		await synchronizerStart();
		await sleep(0.1);
		// Resource metadata saves defer the upload notification until blob completion,
		// but their local-change generation must still make preparation run a full sync.
		jest.spyOn(Folder, 'updateAllShareIds').mockImplementationOnce(async () => {
			await Resource.save({ id: resource.id, title: 'updated during preparation' });
		});
		jest.spyOn(fileApi(), 'delta').mockResolvedValueOnce({ items: [], hasMore: false, context: { cursor: 'unconsumed-probe' } });

		await synchronizerStart(null, { remoteChangesOnly: true, throwOnError: true });

		const remote = await BaseItem.unserialize(await fileApi().get(BaseItem.systemPath(resource)));
		expect(remote.title).toBe('updated during preparation');
	});

	it('processes info.json E2EE changes and uploads newly marked items despite an empty probe', async () => {
		await loadEncryptionMasterKey();
		const folder = await Folder.save({ title: 'folder' });
		const note = await Note.save({ title: 'encrypt me', parent_id: folder.id });
		await synchronizerStart();
		await sleep(0.1);
		const remoteInfo = await fetchSyncInfo(fileApi());
		remoteInfo.e2ee = true;
		await uploadSyncInfo(fileApi(), remoteInfo);
		jest.spyOn(fileApi(), 'delta').mockResolvedValueOnce({ items: [], hasMore: false, context: { cursor: 'unconsumed-probe' } });

		await synchronizerStart(null, { remoteChangesOnly: true, throwOnError: true });

		expect(getEncryptionEnabled()).toBe(true);
		const remote = await BaseItem.unserialize(await fileApi().get(BaseItem.systemPath(note)));
		expect(remote.encryption_applied).toBe(1);
	});

	it('schedules a full follow-up when post-poll publication updates a note', async () => {
		const note = await Note.save({ title: 'published note' });
		await synchronizerStart();
		await sleep(0.1);

		jest.spyOn(fileApi(), 'delta').mockResolvedValueOnce({ items: [], hasMore: false, context: { cursor: 'after-empty-poll' } });
		jest.spyOn(Note, 'updatePublishedNotes').mockImplementationOnce(async () => {
			await Note.save({ id: note.id, title: 'publication status updated' });
		});
		const itemsThatNeedSync = jest.spyOn(BaseItem, 'itemsThatNeedSync');
		const scheduleSync = jest.spyOn(reg, 'scheduleSync').mockResolvedValue(undefined);

		await synchronizerStart(null, { remoteChangesOnly: true, throwOnError: true });

		expect(itemsThatNeedSync).toHaveBeenCalled();
		expect(scheduleSync).toHaveBeenCalledWith(reg.syncAsYouTypeInterval(), {
			syncSteps: ['update_remote', 'delete_remote', 'delta'],
		}, true);
	});

	it('does not checkpoint a probe that is cancelled while fetching', async () => {
		const originalContext = await synchronizerStart();
		let cancellation: Promise<unknown> = null;
		jest.spyOn(fileApi(), 'delta').mockImplementationOnce(async () => {
			cancellation = synchronizer().cancel();
			return { items: [], hasMore: false, context: { cursor: 'cancelled-probe' } };
		});
		const saveContextHandler = jest.fn();

		const output = await synchronizerStart(null, { remoteChangesOnly: true, saveContextHandler, throwOnError: true });
		await cancellation;

		expect(saveContextHandler).not.toHaveBeenCalled();
		expect(output).toEqual(originalContext);
		expect(synchronizer().state()).toBe('idle');
	});

	it.each([
		{ headless: false, serverTarget: true },
		{ headless: true, serverTarget: false },
	])('keeps ordinary sync for headless=$headless, serverTarget=$serverTarget', async ({ headless, serverTarget }) => {
		await synchronizerStart();
		Setting.setConstant('isHeadless', headless);
		if (!serverTarget) fileApi().setSyncTargetId(syncTargetId());
		const delta = jest.spyOn(fileApi(), 'delta');
		const itemsThatNeedSync = jest.spyOn(BaseItem, 'itemsThatNeedSync');
		const dispatch = jest.fn();
		synchronizer().dispatch = dispatch;

		await synchronizerStart(null, { remoteChangesOnly: true, throwOnError: true });

		expect(delta).toHaveBeenCalledTimes(1);
		expect(itemsThatNeedSync).toHaveBeenCalled();
		expect(dispatch).toHaveBeenCalledWith({ type: 'SYNC_COMPLETED', isFullSync: true });
	});
});
