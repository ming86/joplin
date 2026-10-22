import { rpcError } from './session.mjs';

// Newline-delimited UTF-8 JSON with concurrent dispatch allows cancellation to be
// read while an HTTP-backed tool is still in progress.
export function serveStdio(session, { input = process.stdin, output = process.stdout } = {}) {
	let buffer = Buffer.alloc(0);
	let closing = false;
	let failed = false;
	let writing = Promise.resolve();
	const pending = new Set();
	let resolveDone;
	const done = new Promise(resolve => { resolveDone = resolve; });
	function send(response) {
		if (!response || finished) return;
		const line = `${JSON.stringify(response)}\n`;
		writing = writing.then(() => new Promise((resolve, reject) => output.write(line, error => error ? reject(error) : resolve())))
			.catch(() => { void close(true); });
		// Keep the request pending until stdout finishes its reply, including queued writes.
		return writing;
	}
	async function close(error = false) {
		failed ||= error;
		if (closing) return done;
		closing = true;
		input.pause(); input.removeListener('data', onData);
		session.close();
		// Real backend requests honor abort. The bound also covers a broken test/custom backend.
		const timer = setTimeout(() => finish(true), 5000);
		await Promise.allSettled([...pending]);
		await writing;
		clearTimeout(timer);
		finish(failed);
		return done;
	}
	let finished = false;
	function finish(error) {
		if (finished) return;
		finished = true;
		input.removeListener('end', onEnd); input.removeListener('error', onError);
		output.removeListener('error', onError);
		resolveDone({ failed: error });
	}
	function onError() { void close(true); }
	function onEnd() {
		if (buffer.length) { send(rpcError(null, -32700, 'Incomplete JSON frame')); buffer = Buffer.alloc(0); }
		void close();
	}
	function onData(chunk) {
		buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
		let boundary;
		while (!closing && (boundary = buffer.indexOf(10)) !== -1) {
			const frame = buffer.subarray(0, boundary); buffer = buffer.subarray(boundary + 1);
			let message;
			try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); }
			catch { send(rpcError(null, -32700, 'Parse error')); continue; }
			// This outer limit includes cheap protocol methods to bound pipelined input.
			if (pending.size >= 64 && message?.method !== 'notifications/cancelled') { send(rpcError(null, -32000, 'Too many pending requests')); void close(true); return; }
			const operation = session.handle(message).then(send).catch(() => send(rpcError(null, -32603, 'Internal error')));
			pending.add(operation); void operation.finally(() => pending.delete(operation));
		}
	}
	input.on('data', onData); input.once('end', onEnd); input.on('error', onError); output.on('error', onError);
	return { done, close };
}
