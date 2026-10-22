import ClipperServer, { isAllowedPairingOrigin, isPairingPath } from './ClipperServer';
import Setting from './models/Setting';
import { setupDatabaseAndSynchronizer, switchClient } from './testing/test-utils';

describe('ClipperServer', () => {

	test.each([
		// The router strips all leading slashes, so the gate must too, otherwise
		// e.g. //auth would skip the check but still reach the auth handler.
		['/auth', true],
		['/auth/check', true],
		['//auth', true],
		['///auth/check', true],
		['auth', true],
		['/notes', false],
		['/auth_other', false],
		['', false],
	])('should identify pairing path %s -> %s', (pathname, expected) => {
		expect(isPairingPath(pathname)).toBe(expected);
	});

	test.each([
		// Web origins must be rejected: these are the CSRF vector.
		['http://attacker.example', false],
		['https://attacker.example', false],
		['http://127.0.0.1:41184', false],
		['https://localhost', false],

		// Extension origins are the legitimate caller.
		['chrome-extension://some-extension-id', true],
		['moz-extension://11111111-2222-3333-4444-555555555555', true],
		['safari-web-extension://ABCDEF', true],

		// No Origin (native clients, curl) is not a browser CSRF vector.
		['', true],
		[undefined as unknown as string, true],

		// Malformed origins are rejected.
		['not a url', false],
	])('should decide pairing origin %s -> %s', (origin, expected) => {
		expect(isAllowedPairingOrigin(origin)).toBe(expected);
	});

	it('should return BaseModel validation errors as a plain bad-request response', async () => {
		await setupDatabaseAndSynchronizer(1);
		await switchClient(1);

		const server = new ClipperServer();
		let port: number = null;
		server.setDispatch(action => {
			if (typeof action.port === 'number') port = action.port;
		});
		server.initialize();
		await server.start({ returnWhenListening: true });

		try {
			const token = Setting.value('api.token');
			const path = `/folders${token ? `?token=${encodeURIComponent(token)}` : ''}`;
			const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
				const request = require('http').request({
					host: '127.0.0.1',
					port,
					path,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
				}, (res: import('http').IncomingMessage) => {
					const chunks: string[] = [];
					res.setEncoding('utf8');
					res.on('data', (chunk: string) => chunks.push(chunk));
					res.on('end', () => resolve({ statusCode: res.statusCode, body: chunks.join('') }));
				});
				request.on('error', reject);
				request.end(JSON.stringify({ title: 'x'.repeat(4097) }));
			});

			expect(response.statusCode).toBe(400);
			expect(JSON.parse(response.body)).toEqual({
				code: 'validation_error',
				error: 'Validation error: title must be 4096 characters or less',
			});
		} finally {
			await server.stop();
		}
	});
});
