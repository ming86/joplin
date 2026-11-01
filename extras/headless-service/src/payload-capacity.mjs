import { ServiceError } from './errors.mjs';
import { logOperationError } from './diagnostics.mjs';

/** Aggregate bytes retained by active requests and file operations in one MCP process. */
export const defaultActivePayloadBytes = 128 * 1024 * 1024;
/** Aggregate UTF-8 export bytes retained until their advertised expiry in one MCP process. */
export const defaultRetainedExportBytes = 256 * 1024 * 1024;

/**
 * Account for logical payload bytes shared by operations in one process.
 * Owners retain their reservations until their request, response, or stored data is released.
 * @param {{limitBytes?: number}} options Aggregate byte allowance.
 */
export function createPayloadCapacity({ limitBytes = defaultActivePayloadBytes } = {}) {
	if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) throw new Error('invalid_payload_capacity');
	/** Bytes currently reserved by all live owners. */
	let usedBytes = 0;
	/** Shared allowance referenced by each owner so nested file operations use the same budget. */
	const capacity = Object.freeze({
		/** Bytes retained by all live owners. */
		get usedBytes() { return usedBytes; },
		/** Maximum aggregate number of reserved bytes. */
		limitBytes,
		/**
		 * Create an independent lifetime for bytes held by one operation or response.
		 * @param {{operation?: string, stage?: string}} diagnostics Fixed internal operation and stage names.
		 */
		createOwner({ operation = 'payload_operation', stage } = {}) {
			/** Bytes retained by this owner, including any earlier successful reservations. */
			let ownedBytes = 0;
			/** Released owners cannot acquire new bytes and cannot subtract capacity twice. */
			let released = false;
			return Object.freeze({
				/** Process allowance for child operations with a separate lifetime. */
				capacity,
				/** Bytes retained by this owner. */
				get usedBytes() { return ownedBytes; },
				/**
				 * Reserve a known nonnegative byte count before retaining its payload.
				 * A rejected reservation leaves both owner and process accounting unchanged.
				 * @param {number} byteCount Actual bytes about to be retained by the caller.
				 * @throws {ServiceError} resource_capacity_exceeded when the bytes cannot fit.
				 */
				reserve(byteCount) {
					if (released) throw new Error('payload_owner_released');
					if (byteCount > limitBytes - usedBytes) {
						const message = ownedBytes + byteCount > limitBytes
							? `${operation} exceeds the payload byte capacity.`
							: `${operation} cannot complete while payload byte capacity is occupied.`;
						const error = new ServiceError('resource_capacity_exceeded', false, message, {
							diagnostics: { operation, stage, usedBytes, requestedBytes: byteCount, limitBytes },
						});
						logOperationError(error);
						throw error;
					}
					ownedBytes += byteCount;
					usedBytes += byteCount;
				},
				/** Release all bytes once; repeated cleanup is harmless. */
				release() {
					if (released) return;
					usedBytes -= ownedBytes;
					ownedBytes = 0;
					released = true;
				},
			});
		},
	});
	return capacity;
}
