import { ServiceError, requireValue, identifier } from './errors.mjs';

/** Validate a Joplin resource id before using it in a backend path. */
const attachmentId = value => {
	requireValue(typeof value === 'string' && /^[a-f0-9]{32}$/.test(value), 'invalid_attachment_id');
	return value;
};

/** Match the account service's note eligibility rule for resource listings. */
const noteEligible = note => note?.encryption_applied === 0 && !note.deleted_time && !note.is_locked;

/** Require native metadata to identify an unencrypted, unlocked resource. */
const attachmentEligible = attachment => attachment?.encryption_applied === 0
	&& attachment?.encryption_blob_encrypted === 0
	&& attachment?.is_locked === 0;

const metadataFields = [
	'id', 'title', 'mime', 'file_extension', 'size', 'created_time', 'updated_time',
	'encryption_applied', 'encryption_blob_encrypted', 'is_locked',
];

/** Keep the public attachment shape within the backend's metadata allowlist. */
function publicMetadata(value, accountId) {
	requireValue(value && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string' && /^[a-f0-9]{32}$/.test(value.id), 'invalid_attachment_response');
	const output = Object.fromEntries(metadataFields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
	if (typeof value.filename === 'string') output.filename = value.filename;
	return { ...output, accountId };
}

/** Translate native resource 404s to the stable attachment-facing error code. */
async function missingResourceAsUnavailable(operation) {
	try { return await operation(); }
	catch (error) {
		if (error?.code === 'not_found') throw new ServiceError('attachment_unavailable');
		throw error;
	}
}

/** Bind attachment operations to one account and its read/write permission check. */
export function createAttachmentService({ backend, permit, accountId }) {
	requireValue(typeof backend === 'function');
	requireValue(typeof permit === 'function');
	requireValue(typeof accountId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(accountId));

	return Object.freeze({
		/** List resource metadata only after confirming the parent note is readable. */
		async listNoteAttachments(noteId, signal) {
			permit('read');
			identifier(noteId);
			const note = await backend().getNote(noteId, signal);
			if (!noteEligible(note)) throw new ServiceError('note_unavailable');
			const attachments = await backend().listNoteAttachments(noteId, signal);
			requireValue(Array.isArray(attachments), 'invalid_attachment_response');
			return attachments.map(attachment => publicMetadata(attachment, accountId));
		},
		/** Read metadata for an eligible resource without requiring a linked note. */
		async getAttachment(resourceId, signal) {
			permit('read');
			const id = attachmentId(resourceId);
			const attachment = await missingResourceAsUnavailable(() => backend().getAttachment(id, signal));
			requireValue(attachment?.id === id, 'invalid_attachment_response');
			if (!attachmentEligible(attachment)) throw new ServiceError('attachment_unavailable');
			return publicMetadata(attachment, accountId);
		},
		/** Return eligible resource metadata and the file content encoded as base64. */
		async readAttachment(resourceId, signal) {
			permit('read');
			const id = attachmentId(resourceId);
			const attachment = await missingResourceAsUnavailable(() => backend().readAttachment(id, signal));
			requireValue(attachment?.id === id && typeof attachment.filename === 'string', 'invalid_attachment_response');
			if (!attachmentEligible(attachment)) throw new ServiceError('attachment_unavailable');
			requireValue(typeof attachment.contentBase64 === 'string', 'attachment_file_unavailable');
			return { ...publicMetadata(attachment, accountId), filename: attachment.filename, contentBase64: attachment.contentBase64 };
		},
		/** Upload one standalone resource; note bodies are changed by a separate operation. */
		async createAttachment(input, signal) {
			permit('write');
			requireValue(input && typeof input === 'object' && !Array.isArray(input), 'invalid_attachment_input');
			requireValue(Object.keys(input).every(key => ['filename', 'contentBase64', 'title', 'mime'].includes(key)), 'invalid_attachment_input');
			requireValue(typeof input.filename === 'string' && input.filename.length > 0 && typeof input.contentBase64 === 'string', 'invalid_attachment_input');
			for (const key of ['title', 'mime']) {
				if (input[key] !== undefined) requireValue(typeof input[key] === 'string', 'invalid_attachment_input');
			}
			const attachment = await backend().createAttachment({
				filename: input.filename,
				contentBase64: input.contentBase64,
				...(input.title === undefined ? {} : { title: input.title }),
				...(input.mime === undefined ? {} : { mime: input.mime }),
			}, signal);
			return publicMetadata(attachment, accountId);
		},
		/** Update an eligible resource's metadata or replace its current file bytes. */
		async updateAttachment(resourceId, input, signal) {
			permit('write');
			const id = attachmentId(resourceId);
			requireValue(input && typeof input === 'object' && !Array.isArray(input), 'invalid_attachment_input');
			requireValue(Object.keys(input).every(key => ['title', 'filename', 'mime', 'contentBase64'].includes(key)), 'invalid_attachment_input');
			requireValue(Object.values(input).some(value => value !== undefined), 'attachment_update_required');
			for (const key of ['title', 'filename', 'mime', 'contentBase64']) {
				if (input[key] !== undefined) requireValue(typeof input[key] === 'string', 'invalid_attachment_input');
			}
			if (input.filename !== undefined) requireValue(input.filename.length > 0, 'invalid_attachment_input');
			const current = await missingResourceAsUnavailable(() => backend().getAttachment(id, signal));
			requireValue(current?.id === id, 'invalid_attachment_response');
			if (!attachmentEligible(current)) throw new ServiceError('attachment_unavailable');
			const attachment = await missingResourceAsUnavailable(() => backend().updateAttachment(id, {
				...(input.title === undefined ? {} : { title: input.title }),
				...(input.filename === undefined ? {} : { filename: input.filename }),
				...(input.mime === undefined ? {} : { mime: input.mime }),
				...(input.contentBase64 === undefined ? {} : { contentBase64: input.contentBase64 }),
			}, signal));
			requireValue(attachment?.id === id, 'invalid_attachment_response');
			if (!attachmentEligible(attachment)) throw new ServiceError('attachment_unavailable');
			return publicMetadata(attachment, accountId);
		},
	});
}
