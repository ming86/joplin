import { rpcError } from './session.mjs';
import { logOperationError } from '../diagnostics.mjs';
import { createPayloadCapacity } from '../payload-capacity.mjs';
import { ServiceError } from '../errors.mjs';

/** Serve newline-delimited UTF-8 JSON while allowing concurrent cancellation messages. */
export function serveStdio(session, { input = process.stdin, output = process.stdout, payloadCapacity = session.payloadCapacity ?? createPayloadCapacity() } = {}) {
	/** Chunks belonging only to the unfinished frame; completed frames own separate reservations. */
	let parts = [];
	let framePayload = newRequestPayload();
	let closing = false;
	let failed = false;
	let finished = false;
	let writing = Promise.resolve();
	const pending = new Set();
	let resolveDone;
	const done = new Promise(resolve => { resolveDone = resolve; });

	/** Allocate one reservation for a frame, including bytes received before its newline. */
	function newRequestPayload() { return payloadCapacity.createOwner({ operation: 'stdio', stage: 'request_frame' }); }
	/** Allocate response storage that outlives dispatch until its queued write completes. */
	function newResponsePayload() { return payloadCapacity.createOwner({ operation: 'stdio', stage: 'response' }); }
	/** Queue complete replies and retain their caller-owned payloads through the write callback. */
	function send(response) {
		if (!response || finished) return;
		const line = `${JSON.stringify(response)}\n`;
		writing = writing.then(() => {
			if (finished) return;
			return new Promise((resolve, reject) => output.write(line, error => error ? reject(error) : resolve()));
		}).catch(() => { void close(true); });
		return writing;
	}
	/** Track protocol errors and operations together until their replies leave the output queue. */
	function dispatch(message, requestPayload, errorResponse) {
		const responsePayload = newResponsePayload();
		const operation = (async () => {
			try {
				const response = errorResponse ?? await session.handle(message, { requestPayload, responsePayload });
				await send(response);
			} catch (error) {
				logOperationError(error, { operation: 'stdio' });
				await send(error instanceof ServiceError && error.code === 'resource_capacity_exceeded'
					? rpcError(message?.id ?? null, -32000, error.message, { code: error.code })
					: rpcError(null, -32603, 'Internal error'));
			} finally {
				requestPayload.release();
				responsePayload.release();
			}
		})();
		pending.add(operation);
		void operation.finally(() => pending.delete(operation));
	}
	/** Stop collection, abort the session, and give pending operations a bounded drain. */
	function close(error = false) {
		failed ||= error;
		if (closing) return done;
		closing = true;
		input.pause(); input.removeListener('data', onData);
		parts = [];
		framePayload.release();
		session.close();
		// A backend that ignores abort keeps its reservations until it actually settles.
		const timer = setTimeout(() => finish(true), 5000);
		void (async () => {
			await Promise.allSettled([...pending]);
			await writing;
			clearTimeout(timer);
			finish(failed);
		})();
		return done;
	}
	/** Complete shutdown without releasing storage still owned by a running operation. */
	function finish(error) {
		if (finished) return;
		finished = true;
		input.removeListener('end', onEnd); input.removeListener('error', onError);
		output.removeListener('error', onError);
		resolveDone({ failed: error });
	}
	/** Convert input and output stream failures into the existing failed shutdown result. */
	function onError() { void close(true); }
	/** Reject an incomplete final frame before draining already dispatched operations. */
	function onEnd() {
		if (parts.length) {
			const requestPayload = framePayload;
			parts = [];
			framePayload = newRequestPayload();
			dispatch(undefined, requestPayload, rpcError(null, -32700, 'Incomplete JSON frame'));
		}
		void close();
	}
	/** Reserve each frame segment before retaining it, even when no newline has arrived. */
	function onData(chunk) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		let offset = 0;
		while (!closing && offset < bytes.length) {
			const boundary = bytes.indexOf(10, offset);
			const end = boundary === -1 ? bytes.length : boundary + 1;
			try {
				framePayload.reserve(end - offset);
				parts.push(bytes.subarray(offset, end));
			} catch (error) {
				const requestPayload = framePayload;
				parts = [];
				framePayload = newRequestPayload();
				dispatch(undefined, requestPayload, rpcError(null, -32000, error.message, { code: error.code }));
				void close(true);
				return;
			}
			offset = end;
			if (boundary === -1) return;
			const requestPayload = framePayload;
			const frame = Buffer.concat(parts);
			parts = [];
			framePayload = newRequestPayload();
			let message;
			try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); }
			catch { dispatch(undefined, requestPayload, rpcError(null, -32700, 'Parse error')); continue; }
			// Include cheap protocol methods in pipeline admission while allowing cancellation through.
			if (pending.size >= 64 && message?.method !== 'notifications/cancelled') {
				dispatch(undefined, requestPayload, rpcError(null, -32000, 'Too many pending requests'));
				void close(true);
				return;
			}
			dispatch(message, requestPayload);
		}
	}
	input.on('data', onData); input.once('end', onEnd); input.on('error', onError); output.on('error', onError);
	return { done, close };
}
