#!/usr/bin/env node
// Opt-in read-only probe. Start the already configured headless core separately.
// No credentials/E2EE configuration, notes, model requests or databases are created.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAccountRegistry, ServiceError } from '../index.mjs';

function check(value, code) { if (!value) throw new ServiceError(code); }
function privateFile(filename) {
	check(typeof filename === 'string' && path.isAbsolute(filename), 'absolute_private_path_required');
	check((fs.statSync(filename).mode & 0o077) === 0, 'private_file_permissions_required');
	return fs.readFileSync(filename, 'utf8');
}

export async function checkAccount(input, record = () => {}) {
	check(input.confirmRealCore === true, 'real_core_confirmation_required');
	check(typeof input.expectedNoteId === 'string' && /^[a-f0-9]{32}$/.test(input.expectedNoteId), 'test_note_id_required');
	check(typeof input.searchQuery === 'string' && input.searchQuery.length > 0, 'test_search_query_required');
	const config = {
		id: input.accountId, subjects: [input.subject], permissions: ['read'],
		joplin: { baseUrl: input.baseUrl, token: privateFile(input.apiTokenFile).trim() },
		semantic: { databasePath: input.semanticDatabasePath, keyRef: input.semanticKeyRef },
		embedding: {
			protocol: 'openai-embeddings', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-contract-provider', remoteProcessing: false,
			space: { id: 'fake-contract-2d', revision: 'not-a-real-model', dimensions: 2, preprocessingVersion: 'contract-v1' },
		},
	};
	let providerAccount;
	const registry = createAccountRegistry([config], { makeEmbeddingTransport: account => async (texts, purpose) => {
		providerAccount = account.id;
		check(purpose === 'query', 'unexpected_embedding_purpose');
		return { data: texts.map((_, index) => ({ index, embedding: [1, 0] })) };
	} });
	const service = registry.forPrincipal(input.subject, input.accountId);
	await service.listNotebooks({ limit: 1 });
	const note = await service.getNote(input.expectedNoteId);
	check(note.id === input.expectedNoteId && note.accountId === input.accountId, 'note_binding_failed');
	record('PASS account-read-through-real-core');
	const result = await service.search({ query: input.searchQuery, mode: 'keyword', limit: 100 });
	check(result.items.some(item => item.id === input.expectedNoteId && item.accountId === input.accountId), 'expected_note_not_in_search');
	await service.changes();
	record('PASS keyword-and-events-through-real-core');
	const semantic = await service.search({ query: input.searchQuery, mode: 'semantic' });
	check(semantic.executedMode === null && semantic.semantic.state === 'unavailable', 'semantic_status_incorrect');
	const embedded = await service.embed(['synthetic contract check only'], 'query');
	check(embedded.accountId === input.accountId && providerAccount === input.accountId && embedded.vectors[0].length === 2, 'provider_account_binding_failed');
	record('PASS unavailable-state-and-fake-provider-contract');
	return { status: 'PASS', core: 'operator-configured-real-core', embedding: 'fake-provider-only', writes: 0 };
}

async function main() {
	try {
		const result = await checkAccount(JSON.parse(privateFile(process.argv[2])), message => console.log(message));
		console.log('PASS phase15-account-smoke');
		console.log(JSON.stringify(result));
	} catch (error) {
		console.error(`FAIL ${error instanceof ServiceError ? error.code : 'account_smoke_failed'}`);
		process.exitCode = 1;
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main();
