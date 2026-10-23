import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createBinaryFileReader, createNoteBodyFileReader } from '../src/mcp/note-file-input.mjs';

/** Build a Node-compatible fake transport that connects through the supplied DNS callback. */
function transport({ readerFactory = createNoteBodyFileReader, addresses = [{ address: '93.184.216.34', family: 4 }], chunks = [Buffer.from('body')], status = 200, stalled = false, dnsError = null } = {}) {
	const seen = { lookups: 0, requests: 0, connected: false, requestDestroyed: false, response: null };
	const read = readerFactory({
		lookup(host, options, callback) {
			seen.lookups++;
			assert.equal(host, 'files.example');
			assert.deepEqual(options, { all: true, verbatim: true });
			queueMicrotask(() => callback(dnsError, addresses));
		},
		request(url, options, callback) {
			seen.requests++;
			seen.url = url;
			seen.options = options;
			const req = new EventEmitter();
			const abort = () => {
				const error = new Error('signed URL must never escape');
				seen.response?.destroy(error);
				req.emit('error', error);
			};
			options.signal.addEventListener('abort', abort, { once: true });
			req.destroy = () => { seen.requestDestroyed = true; options.signal.removeEventListener('abort', abort); };
			req.end = () => options.lookup(url.hostname, { all: true }, (error, result) => {
				if (error) { req.emit('error', error); return; }
				seen.connected = true;
				seen.addresses = result;
				const response = stalled ? new Readable({ read() {} }) : Readable.from(chunks);
				response.statusCode = status;
				seen.response = response;
				callback(response);
			});
			return req;
		},
	});
	return { read, seen };
}

/** A client file reference may include a signed query; no service credentials are supplied. */
const file = { download_url: 'https://files.example/note.md?signature=secret', file_id: 'file-123' };

/** Assert safe, definite-before-save service failure semantics. */
async function fails(operation, code) {
	await assert.rejects(operation, error => {
		assert.equal(error.code, code);
		assert.equal(error.message, code);
		assert.equal(error.outcomeUnknown, false);
		return true;
	});
}

test('downloads exact binary bytes across chunks without UTF-8 decoding', async () => {
	const bytes = Buffer.from([0x00, 0xef, 0xbb, 0xbf, 0xff, 0xc3, 0x28, 0x00, 0x80]);
	const { read, seen } = transport({
		readerFactory: createBinaryFileReader,
		chunks: [bytes.subarray(0, 2), bytes.subarray(2, 6), bytes.subarray(6)],
	});
	const result = await read(file);
	assert.ok(Buffer.isBuffer(result));
	assert.deepEqual(result, bytes);
	assert.equal(seen.lookups, 1);
	assert.equal(seen.requestDestroyed, true);
	assert.equal(seen.response.destroyed, true);
});

test('downloads exact multi-megabyte UTF-8 text with BOM, line endings, and split codepoints', async () => {
	const body = '\ufeff# Note\r\n' + 'é😀\n'.repeat(600000) + '\r\n';
	const bytes = Buffer.from(body);
	const { read, seen } = transport({ chunks: [bytes.subarray(0, 14), bytes.subarray(14, 27), bytes.subarray(27)] });
	assert.equal(await read(file), body);
	assert.equal(seen.lookups, 1);
	assert.deepEqual(seen.addresses, [{ address: '93.184.216.34', family: 4 }]);
	assert.equal(seen.options.agent, false);
	assert.deepEqual(seen.options.headers, { 'Accept-Encoding': 'identity' });
	assert.equal(seen.requestDestroyed, true);
	assert.equal(seen.response.destroyed, true);
});

test('rejects malformed and incomplete UTF-8 instead of replacing bytes', async () => {
	for (const chunks of [[Buffer.from([0xc3, 0x28])], [Buffer.from([0xe2, 0x82])]]) {
		const { read, seen } = transport({ chunks });
		await fails(read(file), 'note_file_invalid_utf8');
		assert.equal(seen.response.destroyed, true);
	}
});

test('rejects non-HTTPS, credentials, and private or reserved IP literals before requesting', async () => {
	const cases = [
		['http://files.example/x', 'note_file_invalid_url'],
		['https://user:password@files.example/x', 'note_file_invalid_url'],
		...['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '198.18.0.1', '192.0.2.1', '224.0.0.1', '[::1]', '[fc00::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[2001:db8::1]', '[2002:7f00:1::]'].map(host => [`https://${host}/x`, 'note_file_unsafe_url']),
	];
	for (const [download_url, code] of cases) {
		const { read, seen } = transport();
		await fails(read({ ...file, download_url }), code);
		assert.equal(seen.requests, 0, download_url);
	}
});

test('validates every DNS address used by the connection and blocks mixed public/private answers', async () => {
	for (const address of ['10.0.0.1', '127.0.0.1', '169.254.1.1', '::1', 'fd00::1', '2001:db8::1']) {
		const { read, seen } = transport({ addresses: [{ address: '93.184.216.34', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }] });
		await fails(read(file), 'note_file_unsafe_url');
		assert.equal(seen.lookups, 1);
		assert.equal(seen.connected, false);
		assert.equal(seen.requestDestroyed, true);
	}
});

test('accepts public IPv6 DNS results through the connection lookup', async () => {
	const addresses = [{ address: '2606:4700:4700::1111', family: 6 }];
	const { read, seen } = transport({ addresses });
	assert.equal(await read(file), 'body');
	assert.deepEqual(seen.addresses, addresses);
});

test('rejects redirects and non-success responses without following another URL', async () => {
	for (const status of [301, 302, 307, 400, 403, 500]) {
		const { read, seen } = transport({ status });
		await fails(read(file), 'note_file_download_failed');
		assert.equal(seen.requests, 1);
		assert.equal(seen.response.destroyed, true);
	}
});

test('maps DNS failures to safe errors', async () => {
	const { read, seen } = transport({ dnsError: new Error('secret signed URL') });
	await fails(read(file), 'note_file_download_failed');
	assert.equal(seen.connected, false);
});

test('respects cancellation before downloading and while streaming, closing the transport', async () => {
	const before = new AbortController();
	before.abort();
	const first = transport();
	await fails(first.read(file, before.signal), 'request_cancelled');
	assert.equal(first.seen.requests, 0);
	const during = new AbortController();
	const second = transport({ stalled: true });
	const pending = second.read(file, during.signal);
	await new Promise(resolve => setImmediate(resolve));
	during.abort();
	await fails(pending, 'request_cancelled');
	assert.equal(second.seen.requestDestroyed, true);
	assert.equal(second.seen.response.destroyed, true);
});
