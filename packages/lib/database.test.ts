import { setupDatabaseAndSynchronizer, switchClient } from './testing/test-utils';
import BaseModel from './BaseModel';
import Note from './models/Note';
import { ConditionalSaveConflictError } from './database';
import { SqlParams } from './services/database/types';

describe('database', () => {
	beforeEach(async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);
	});

	it('should not modify cached field names', (async () => {
		const db = BaseModel.db();

		const fieldNames = db.tableFieldNames('notes');
		const fieldCount = fieldNames.length;
		fieldNames.push('type_');

		expect(fieldCount).toBeGreaterThan(0);
		expect(db.tableFieldNames('notes').length).toBe(fieldCount);
	}));

	it('should conditionally save a loaded row and its following queries together', async () => {
		const db = BaseModel.db();
		const note = await Note.save({ title: 'Original' });
		const expectedItem = await db.selectOne('SELECT * FROM notes WHERE id = ?', [note.id]);
		await db.exec('CREATE TABLE conditional_save_success_history (title TEXT)');
		await BaseModel.save.call(Note, { id: note.id, title: 'Updated' }, {
			expectedItem,
			nextQueries: [{ sql: 'INSERT INTO conditional_save_success_history VALUES (?)', params: ['Updated'] }],
		});

		expect((await db.selectOne('SELECT title FROM notes WHERE id = ?', [note.id])).title).toBe('Updated');
		expect(await db.selectAll('SELECT title FROM conditional_save_success_history')).toEqual([{ title: 'Updated' }]);
	});

	it('should reject a stale row without saving it or running following queries', async () => {
		const db = BaseModel.db();
		const note = await Note.save({ title: 'Original' });
		const expectedItem = await db.selectOne('SELECT * FROM notes WHERE id = ?', [note.id]);
		await db.exec('CREATE TABLE conditional_save_stale_history (title TEXT)');
		// Change a field outside the requested patch without relying on timestamps.
		await db.exec('UPDATE notes SET body = ? WHERE id = ?', ['Concurrent body', note.id]);

		await expect(BaseModel.save.call(Note, { id: note.id, title: 'Stale update' }, {
			expectedItem,
			nextQueries: [{ sql: 'INSERT INTO conditional_save_stale_history VALUES (?)', params: ['Stale update'] }],
		})).rejects.toBeInstanceOf(ConditionalSaveConflictError);

		expect(await db.selectOne('SELECT title, body FROM notes WHERE id = ?', [note.id])).toEqual({ title: 'Original', body: 'Concurrent body' });
		expect(await db.selectAll('SELECT * FROM conditional_save_stale_history')).toEqual([]);
	});

	it('should match nullable fields in conditional update predicates', async () => {
		/** A table with a nullable value for exercising BaseModel's generated predicate. */
		class NullableModel extends BaseModel {
			/** Name of this test's persisted table. */
			public static tableName() { return 'conditional_nullable'; }
			/** Persisted fields included in the loaded row comparison. */
			public static fieldNames() { return ['id', 'value']; }
		}

		const db = BaseModel.db();
		await db.exec('CREATE TABLE conditional_nullable (id TEXT PRIMARY KEY, value TEXT)');
		await db.exec('INSERT INTO conditional_nullable VALUES (?, NULL)', ['nullable']);
		const expectedItem = await db.selectOne('SELECT * FROM conditional_nullable');
		const query = NullableModel.saveQuery({ id: 'nullable', value: 'Updated' }, { expectedItem });
		await db.transactionExecBatch([query]);
		expect(await db.selectOne('SELECT value FROM conditional_nullable')).toEqual({ value: 'Updated' });
	});

	it('should roll back a conditional save when a following insert fails', async () => {
		const db = BaseModel.db();
		const note = await Note.save({ title: 'Original' });
		const expectedItem = await db.selectOne('SELECT * FROM notes WHERE id = ?', [note.id]);
		await db.exec('CREATE TABLE conditional_save_rollback_history (id INTEGER PRIMARY KEY)');
		await db.exec('INSERT INTO conditional_save_rollback_history VALUES (1)');

		await expect(BaseModel.save.call(Note, { id: note.id, title: 'Rolled back' }, {
			expectedItem,
			nextQueries: [{ sql: 'INSERT INTO conditional_save_rollback_history VALUES (1)' }],
		})).rejects.toThrow(/UNIQUE constraint failed/);

		expect(await db.selectOne('SELECT * FROM notes WHERE id = ?', [note.id])).toEqual(expectedItem);
		expect(await db.selectAll('SELECT * FROM conditional_save_rollback_history')).toEqual([{ id: 1 }]);
	});

	it('should check read-only assertions and roll back preceding writes on a mismatch', async () => {
		const db = BaseModel.db();
		await db.exec('CREATE TABLE row_count_assertions (id INTEGER PRIMARY KEY, value TEXT)');
		await db.exec('INSERT INTO row_count_assertions VALUES (1, ?)', ['Original']);

		await expect(db.transactionExecBatch([
			{ sql: 'SELECT id FROM row_count_assertions WHERE id = ?', params: [1], expectedRowCount: 1 },
			{ sql: 'UPDATE row_count_assertions SET value = ?', params: ['Uncommitted'] },
			{ sql: 'SELECT id FROM row_count_assertions WHERE id = ?', params: [1], expectedRowCount: 0 },
		])).rejects.toBeInstanceOf(ConditionalSaveConflictError);
		expect(await db.selectOne('SELECT value FROM row_count_assertions')).toEqual({ value: 'Original' });

		// A batch containing only an assertion must also check its result count.
		await expect(db.transactionExecBatch([
			{ sql: 'SELECT id FROM row_count_assertions', expectedRowCount: 0 },
		])).rejects.toBeInstanceOf(ConditionalSaveConflictError);
	});

	it('should isolate ordinary reads and writes from a failing batch transaction', async () => {
		const db = BaseModel.db();
		await db.exec('CREATE TABLE transaction_isolation (id INTEGER PRIMARY KEY, value TEXT)');
		await db.exec('INSERT INTO transaction_isolation VALUES (1, ?)', ['Original']);

		// Hold the transaction after BEGIN so ordinary calls arrive while it owns
		// the connection. They must execute only after its rollback completes.
		let resumeUpdate: ()=> void;
		const updateGate = new Promise<void>(resolve => { resumeUpdate = resolve; });
		let reportUpdateStarted: ()=> void;
		const updateStarted = new Promise<void>(resolve => { reportUpdateStarted = resolve; });
		const driver = db.driver();
		const originalExec = driver.exec.bind(driver);
		const execSpy = jest.spyOn(driver as { exec: (sql: string, params?: SqlParams)=> Promise<unknown> }, 'exec').mockImplementation(async (sql, params) => {
			if (sql === 'UPDATE transaction_isolation SET value = ? WHERE id = 1') {
				reportUpdateStarted();
				await updateGate;
			}
			return originalExec(sql, params);
		});

		try {
			const batch = db.transactionExecBatch([
				{ sql: 'UPDATE transaction_isolation SET value = ? WHERE id = 1', params: ['Uncommitted'] },
				'INSERT INTO transaction_isolation VALUES (1, \'Duplicate\')',
			]);
			const rejectedBatch = expect(batch).rejects.toThrow(/UNIQUE constraint failed/);
			await updateStarted;
			const ordinaryRead = db.selectOne('SELECT value FROM transaction_isolation WHERE id = 1');
			const ordinaryWrite = db.exec('INSERT INTO transaction_isolation VALUES (2, ?)', ['Ordinary write']);
			resumeUpdate();
			await rejectedBatch;
			expect(await ordinaryRead).toEqual({ value: 'Original' });
			await ordinaryWrite;
			expect(await db.selectAll('SELECT * FROM transaction_isolation ORDER BY id')).toEqual([
				{ id: 1, value: 'Original' },
				{ id: 2, value: 'Ordinary write' },
			]);
		} finally {
			resumeUpdate();
			execSpy.mockRestore();
		}
	});

});
