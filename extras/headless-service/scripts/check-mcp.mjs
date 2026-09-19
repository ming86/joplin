#!/usr/bin/env node
// Read-only wire smoke using our small reference client, NOT host/SDK certification.
import assert from 'node:assert/strict';
import { StdioTestClient } from './lib/stdio-client.mjs';
let client;
try {
	assert.ok(process.argv[2], 'A configuration path is required');
	client = new StdioTestClient(process.argv[2]);
	const init = await client.initialize();
	const catalog = await client.request('tools/list');
	for (const name of ['get_status', 'get_note', 'list_notes', 'list_notebooks', 'search_notes']) assert.ok(catalog.tools.some(tool => tool.name === name));
	console.log('PASS mcp-initialize-and-tool-discovery');
	for (const name of ['get_status', 'list_notebooks', 'list_notes']) assert.equal((await client.call(name)).isError, false);
	if (process.argv[3]) assert.equal((await client.call('get_note', { id: process.argv[3] })).isError, false);
	const search = await client.call('search_notes', { query: process.argv[4] ?? 'mcp', mode: 'keyword', limit: 5 });
	assert.equal(search.isError, false);
	if (process.argv[3] && process.argv[4]) assert.ok(search.structuredContent.items.some(n => n.id === process.argv[3]));
	console.log('PASS mcp-account-read-and-keyword-requests');
	await client.close(); assert.equal(client.child.exitCode, 0);
	console.log(`PASS mcp-read-smoke (protocol ${init.protocolVersion}; no writes or model calls)`);
} catch {
	console.error('FAIL mcp-read-smoke; inspect local configuration and service availability');
	process.exitCode = 1;
} finally { if (client) await client.close(); }
