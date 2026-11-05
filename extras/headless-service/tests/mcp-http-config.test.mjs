import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMcpConfig } from '../src/mcp/config.mjs';
import { openMcpRuntime } from '../src/semantic/runtime.mjs';

function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-http-config-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const apiTokenFile = path.join(dir, 'api-token');
	const bearerTokenFile = path.join(dir, 'bearer-token');
	const configFile = path.join(dir, 'mcp.json');
	fs.writeFileSync(apiTokenFile, 'api-secret', { mode: 0o600 });
	fs.writeFileSync(bearerTokenFile, ' bearer-secret \n', { mode: 0o600 });
	const base = {
		accountId: 'alice',
		baseUrl: 'http://127.0.0.1:41185',
		apiTokenFile,
		bearerTokenFile,
	};
	const writeConfig = (overrides = {}) => {
		fs.writeFileSync(configFile, JSON.stringify({ ...base, ...overrides }));
		return configFile;
	};
	return { apiTokenFile, bearerTokenFile, configFile, writeConfig };
}

test('HTTP config reads a private bearer token and supplies listener defaults', t => {
	const f = fixture(t);
	const loaded = loadMcpConfig(f.writeConfig(), { transport: 'http' });
	assert.deepEqual(loaded.httpConfig, {
		listenHost: '127.0.0.1', listenPort: 41191, bearerToken: 'bearer-secret', allowedOrigins: [],
	});
	assert.deepEqual(loaded.accountConfig.subjects, ['local-stdio']);

	fs.chmodSync(f.bearerTokenFile, 0o644);
	assert.throws(() => loadMcpConfig(f.configFile, { transport: 'http' }), error => error.code === 'private_token_permissions_required');
});

test('HTTP config preserves explicit host, port and allowed origins', t => {
	const f = fixture(t);
	const loaded = loadMcpConfig(f.writeConfig({
		listenHost: 'mcp.example.test',
		listenPort: 42000,
		allowedOrigins: ['https://app.example.test', 'http://localhost:3000'],
	}), { transport: 'http' });
	assert.deepEqual(loaded.httpConfig, {
		listenHost: 'mcp.example.test',
		listenPort: 42000,
		bearerToken: 'bearer-secret',
		allowedOrigins: ['https://app.example.test', 'http://localhost:3000'],
	});
});

test('HTTP config requires a bearer token file', t => {
	const f = fixture(t);
	assert.throws(() => loadMcpConfig(f.writeConfig({ bearerTokenFile: undefined }), { transport: 'http' }), error => error.code === 'absolute_path_required');
});

test('stdio config does not read its optional bearer token file', t => {
	const f = fixture(t);
	const missingBearerFile = path.join(path.dirname(f.configFile), 'does-not-exist');
	const loaded = loadMcpConfig(f.writeConfig({ bearerTokenFile: missingBearerFile }));
	assert.equal(loaded.httpConfig, undefined);
});

test('attachment-write environment accepts only exact booleans and leaves account write permission unchanged', t => {
	const f = fixture(t);
	const setting = 'JOPLIN_MCP_ALLOW_ATTACHMENT_WRITES';
	const previous = process.env[setting];
	t.after(() => {
		if (previous === undefined) delete process.env[setting];
		else process.env[setting] = previous;
	});

	delete process.env[setting];
	assert.equal(loadMcpConfig(f.writeConfig({ allowWrites: true })).allowAttachmentWrites, true);
	process.env[setting] = 'true';
	assert.equal(loadMcpConfig(f.configFile).allowAttachmentWrites, true);
	process.env[setting] = 'false';
	assert.equal(loadMcpConfig(f.configFile).allowAttachmentWrites, false);
	process.env[setting] = 'true';
	const readOnly = loadMcpConfig(f.writeConfig({ allowWrites: false }));
	assert.equal(readOnly.allowWrites, false);
	assert.equal(readOnly.allowAttachmentWrites, true);

	for (const value of ['', 'TRUE', ' true']) {
		process.env[setting] = value;
		assert.throws(() => loadMcpConfig(f.configFile), error => error.code === 'invalid_mcp_configuration');
	}
});

test('MCP runtime forwards HTTP transport when semantic search is disabled', async t => {
	const f = fixture(t);
	const runtime = await openMcpRuntime(f.writeConfig({ semantic: { enabled: false } }), { transport: 'http' });
	t.after(() => runtime.close());
	assert.equal(runtime.httpConfig.bearerToken, 'bearer-secret');
	assert.equal(runtime.httpConfig.listenPort, 41191);
	assert.equal(runtime.engine, undefined);
});
