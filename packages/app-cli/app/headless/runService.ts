import { EventEmitter } from 'events';

interface ServiceOperations {
	start: ()=> Promise<void>;
	stop: ()=> Promise<void>;
	ready: ()=> void;
	timedOut: ()=> void;
}

export const runService = async (operations: ServiceOperations, signals: EventEmitter = process, shutdownTimeoutMs = 30000) => {
	let requested = false;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	let resolveStop: ()=> void;
	const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
	const requestStop = () => {
		if (requested) return;
		requested = true;
		deadline = setTimeout(operations.timedOut, shutdownTimeoutMs);
		resolveStop();
	};
	signals.on('SIGINT', requestStop);
	signals.on('SIGTERM', requestStop);
	try {
		await operations.start();
		if (!requested) operations.ready();
		await stopped;
	} finally {
		// Bind failures also get bounded cleanup; never release a live profile on timeout.
		requestStop();
		try {
			await operations.stop();
		} finally {
			clearTimeout(deadline);
			signals.removeListener('SIGINT', requestStop);
			signals.removeListener('SIGTERM', requestStop);
		}
	}
};
