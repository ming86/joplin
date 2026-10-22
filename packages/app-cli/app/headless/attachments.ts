import { UserSideValidationError } from '@joplin/lib/BaseModel';
import JoplinError from '@joplin/lib/JoplinError';
import * as mimeUtils from '@joplin/lib/mime-utils';
import Resource from '@joplin/lib/models/Resource';
import Setting from '@joplin/lib/models/Setting';
import { fileExtension, safeFileExtension } from '@joplin/utils/path';
import type { ResourceEntity } from '@joplin/lib/services/database/types';
import shim from '@joplin/lib/shim';
import { fromBuffer as fileTypeFromBuffer } from 'file-type';
import { validateHeaderValue } from 'http';

/** A new attachment supplied entirely as bytes, without access to a caller's filesystem. */
interface CreateAttachmentInput {
	/** Pathless original filename used for the title and native extension. */
	filename: string;
	/** Exact attachment bytes encoded as canonical padded base64. */
	contentBase64: string;
	/** Optional display title, otherwise the original filename. */
	title?: string;
	/** Explicit MIME, including an empty string; omitted MIME uses native inference. */
	mime?: string;
}

/** Supported changes to one existing, decrypted and unlocked attachment. */
interface UpdateAttachmentInput {
	/** Existing native resource ID. */
	id: string;
	/** New pathless filename; also supplies the title unless title is explicit. */
	filename?: string;
	/** Replacement bytes; omitted content leaves the existing bytes unchanged. */
	contentBase64?: string;
	/** New display title. */
	title?: string;
	/** New MIME; metadata-only changes otherwise preserve the current MIME. */
	mime?: string;
}

/** Final resource metadata used by the sidecar to verify readability without exposing paths. */
type AttachmentMetadata = Pick<ResourceEntity, 'id' | 'title' | 'mime' | 'file_extension' | 'size' | 'created_time' | 'updated_time' | 'encryption_applied' | 'encryption_blob_encrypted' | 'is_locked'>;

/** A known failure established before any resource metadata or bytes are changed. */
interface AttachmentFailure {
	/** Stable public error information. */
	error: {
		/** Machine-readable reason for rejecting the request. */
		code: string;
		/** Bounded explanation without stored resource content or paths. */
		message: string;
		/** No resource write was attempted. */
		applied: false;
	};
}

/** Validated resource changes and the current blob path needed for a native rename. */
interface PreparedAttachment {
	/** Complete final metadata for path calculation and native validation. */
	resource: ResourceEntity;
	/** Existing metadata, or null when creating a new attachment. */
	current: ResourceEntity | null;
	/** New bytes, or undefined for a metadata-only edit. */
	contentBase64?: string;
}

/** Typed prewrite failures that can safely promise that nothing was applied. */
const knownErrorCodes = new Set([
	'invalid_attachment_input',
	'unsupported_attachment_property',
	'empty_attachment_update',
	'attachment_unavailable',
	'validation_error',
]);

/** Test an own property so explicit empty strings remain distinct from omitted values. */
function hasOwn(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

/** Reject invalid action input with a bounded public error. */
function requireValue(condition: unknown, message: string, code = 'invalid_attachment_input'): asserts condition {
	if (!condition) throw new JoplinError(message, code);
}

/** Validate a single path component without changing the caller's filename. */
function requireFilename(value: unknown): asserts value is string {
	// eslint-disable-next-line no-control-regex
	requireValue(typeof value === 'string' && value.length > 0 && !/[\\/\u0000-\u001f\u007f]/.test(value) && value !== '.' && value !== '..', 'A pathless attachment filename is required.');
}

/** Decode canonical base64 rather than accepting Buffer's permissive truncation. */
function decodeBase64(value: unknown): Buffer {
	requireValue(typeof value === 'string', 'Canonical attachment base64 is required.');
	const bytes = Buffer.from(value, 'base64');
	requireValue(bytes.toString('base64') === value, 'Canonical attachment base64 is required.');
	return bytes;
}

/** Validate only the supported transport fields before using any native resource APIs. */
function validateInput(input: CreateAttachmentInput | UpdateAttachmentInput, creating: boolean) {
	requireValue(input && typeof input === 'object' && !Array.isArray(input), 'An attachment request is required.');
	const allowed = creating ? ['filename', 'contentBase64', 'title', 'mime'] : ['id', 'filename', 'contentBase64', 'title', 'mime'];
	requireValue(Object.keys(input).every(key => allowed.includes(key)), 'Unsupported attachment property.', 'unsupported_attachment_property');
	if (creating || hasOwn(input, 'filename')) requireFilename(input.filename);
	if (creating) requireValue(hasOwn(input, 'contentBase64'), 'Attachment bytes are required.');
	if (!creating) {
		const update = input as UpdateAttachmentInput;
		requireValue(typeof update.id === 'string' && /^[a-f0-9]{32}$/.test(update.id), 'A valid attachment ID is required.');
		requireValue(Object.keys(input).some(key => key !== 'id'), 'The attachment update is empty.', 'empty_attachment_update');
	}
	if (hasOwn(input, 'title')) requireValue(typeof input.title === 'string', 'The attachment title must be a string.');
	if (hasOwn(input, 'mime')) {
		requireValue(typeof input.mime === 'string', 'The attachment MIME must be a string.');
		// The Data API uses MIME as a response header; retain Node's actual header boundary.
		try {
			validateHeaderValue('Content-Type', input.mime);
		} catch {
			throw new JoplinError('The attachment MIME is not a valid header value.', 'invalid_attachment_input');
		}
	}
}

/** Match native upload inference using the existing MIME table and byte detector. */
async function inferContentType(filename: string, bytes: Buffer): Promise<{ mime: string; file_extension: string }> {
	let mime = mimeUtils.fromFilename(filename);
	let extension = safeFileExtension(fileExtension(filename));
	if (!mime) {
		const detected = await fileTypeFromBuffer(bytes);
		if (detected) {
			mime = detected.mime;
			extension = extension || detected.ext;
		} else {
			mime = 'application/octet-stream';
		}
	}
	return { mime, file_extension: extension };
}

/** Prepare final native metadata and perform every known rejection before a resource write. */
async function prepareAttachment(input: CreateAttachmentInput | UpdateAttachmentInput, creating: boolean): Promise<PreparedAttachment> {
	validateInput(input, creating);
	const bytes = hasOwn(input, 'contentBase64') ? decodeBase64(input.contentBase64) : undefined;
	const current = creating ? null : await Resource.load((input as UpdateAttachmentInput).id);
	if (!creating) {
		requireValue(current && current.encryption_applied === 0 && current.encryption_blob_encrypted === 0 && current.is_locked === 0, 'The attachment is unavailable.', 'attachment_unavailable');
		if (bytes) requireValue(await Resource.isReady(current), 'The attachment is unavailable.', 'attachment_unavailable');
	}

	const resource: ResourceEntity = creating ? { ...Resource.new(), id: Resource.generateUuid() } : { ...current };
	const hasFilename = hasOwn(input, 'filename');
	if (hasFilename) resource.file_extension = safeFileExtension(fileExtension(input.filename));
	if (creating || hasFilename) resource.title = input.filename;
	if (hasOwn(input, 'title')) resource.title = input.title;
	if (hasOwn(input, 'mime')) {
		resource.mime = input.mime;
	} else if (bytes) {
		// Prefer the native storage extension; the display filename supplies any remaining hint.
		const filename = hasFilename ? input.filename : Resource.friendlySafeFilename(current);
		Object.assign(resource, await inferContentType(filename, bytes));
	}
	if (bytes) resource.size = bytes.length;
	Resource.userSideValidation({ ...resource });
	// Native path validation also applies to extensionless resources whose MIME supplies the suffix.
	const finalPath = Resource.fullPath(resource);
	if (current && !bytes && Resource.fullPath(current) !== finalPath) {
		requireValue(await shim.fsDriver().exists(Resource.fullPath(current)), 'The attachment bytes are unavailable.', 'attachment_unavailable');
	}
	return { resource, current, ...(bytes ? { contentBase64: input.contentBase64 } : {}) };
}

/** Select complete persisted fields instead of forwarding partial save results or stored paths. */
async function attachmentMetadata(id: string): Promise<AttachmentMetadata> {
	const resource = await Resource.load(id);
	if (!resource) throw new Error('Saved attachment could not be reloaded.');
	return {
		id: resource.id,
		title: resource.title,
		mime: resource.mime,
		file_extension: resource.file_extension,
		size: resource.size,
		created_time: resource.created_time,
		updated_time: resource.updated_time,
		encryption_applied: resource.encryption_applied,
		encryption_blob_encrypted: resource.encryption_blob_encrypted,
		is_locked: resource.is_locked,
	};
}

/** Save prepared metadata and bytes through the native resource lifecycle. */
async function saveAttachment(prepared: PreparedAttachment): Promise<AttachmentMetadata> {
	const { resource, current, contentBase64 } = prepared;
	const finalPath = Resource.fullPath(resource);
	const previousPath = current ? Resource.fullPath(current) : null;
	const hasBytes = contentBase64 !== undefined;
	const tempPath = hasBytes ? `${Setting.value('tempDir')}/${Resource.generateUuid()}` : null;
	try {
		if (hasBytes) await shim.fsDriver().writeFile(tempPath, contentBase64, 'base64');
		// From this save onward, all errors escape: the action can no longer promise applied=false.
		await Resource.save(resource, { isNew: !current, userSideValidation: true });
		if (hasBytes) {
			if (current) {
				await Resource.updateResourceBlobContent(resource.id, tempPath);
			} else {
				await shim.fsDriver().copy(tempPath, finalPath);
			}
			if (previousPath && previousPath !== finalPath) await shim.fsDriver().remove(previousPath);
		} else if (previousPath !== finalPath) {
			await shim.fsDriver().move(previousPath, finalPath);
		}
		return await attachmentMetadata(resource.id);
	} finally {
		if (tempPath) await shim.fsDriver().remove(tempPath);
	}
}

/** Return only known prewrite failures in the action error envelope. */
async function attachmentAction(input: CreateAttachmentInput | UpdateAttachmentInput, creating: boolean): Promise<AttachmentMetadata | AttachmentFailure> {
	let prepared: PreparedAttachment;
	try {
		prepared = await prepareAttachment(input, creating);
	} catch (error) {
		if (error instanceof UserSideValidationError) {
			return { error: { code: 'validation_error', message: 'The attachment failed native validation.', applied: false } };
		}
		if (!(error instanceof JoplinError) || typeof error.code !== 'string' || !knownErrorCodes.has(error.code)) throw error;
		return { error: { code: error.code, message: error.message, applied: false } };
	}
	return saveAttachment(prepared);
}

/** The fixed attachment write actions exposed by the private headless service. */
export default function createHeadlessAttachmentActions() {
	return Object.assign(Object.create(null), {
		/** Create one native resource from supplied bytes and a pathless filename. */
		createAttachment: (input: CreateAttachmentInput) => attachmentAction(input, true),
		/** Change supported native metadata or replace the bytes of one existing resource. */
		updateAttachment: (input: UpdateAttachmentInput) => attachmentAction(input, false),
	});
}
