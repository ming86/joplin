/** Non-sensitive request attributes accepted by the proxy's structured logger. */
export interface LogFields {
	/** HTTP response status. */
	status?: number;
	/** HTTP request method. */
	method?: string;
	/** Fixed route name, without query parameters. */
	path?: string;
	/** Random request correlation identifier. */
	cid?: string;
}

/** Write a fixed event name and selected request attributes without request payloads. */
function emit(level: 'info' | 'warn' | 'error', event: string, fields: LogFields): void {
	console[level](JSON.stringify({ event, ...fields }));
}

/** Small structured logger; callers must use fixed event and route names. */
export const log = {
	/** Record an expected operation or result. */
	info: (event: string, fields: LogFields = {}): void => emit('info', event, fields),
	/** Record a rejected request without including thrown errors. */
	warn: (event: string, fields: LogFields = {}): void => emit('warn', event, fields),
	/** Record an internal failure without including thrown errors. */
	error: (event: string, fields: LogFields = {}): void => emit('error', event, fields),
};
