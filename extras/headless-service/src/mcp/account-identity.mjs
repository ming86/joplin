/** Successful profile emails and pending lookups shared by all MCP sessions for a service. */
const identities = new WeakMap();

/** Known result records that carry the bound account's identity at their root. */
const rootIdentityTools = new Set([
	'list_notes', 'search_notes', 'read_note', 'get_note',
	'list_note_revisions', 'read_note_revision', 'compare_note_revisions',
	'list_conflicts', 'read_conflict', 'update_notebook', 'delete_notebook',
	'create_tag', 'rename_tag', 'read_attachment', 'create_attachment', 'update_attachment',
	'list_trash', 'restore_note', 'restore_notebook', 'list_attachment_notes',
]);

/** Nested result rows that carry account identity; other dictionaries remain opaque. */
const identityRows = new Map([
	['list_notes', 'items'],
	['list_note_revisions', 'items'],
	['list_note_attachments', 'attachments'],
]);

/** Read a usable authenticated profile email without inventing a fallback identity. */
function profileEmail(status) {
	return typeof status?.accountEmail === 'string' && status.accountEmail.trim() ? status.accountEmail : null;
}

/** Replace only an existing service identity, leaving native fields and nested metadata untouched. */
function presentRecord(value, accountEmail) {
	if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'accountId')) return value;
	const { accountId: _accountId, ...record } = value;
	return { ...record, accountEmail };
}

/**
 * Present public MCP account identities using the authenticated Joplin profile email.
 * Missing status support, unavailable email, and failed auxiliary lookups yield null;
 * they never turn a successful operation into a failure. Successful emails are cached
 * for the bound service lifetime, and concurrent lookups share one status request.
 * Call this on result metadata before serializing text or building resource results.
 */
export function createAccountResultPresenter(service) {
	let identity = identities.get(service);
	if (!identity) {
		identity = { email: null, pending: null };
		identities.set(service, identity);
	}

	/** Resolve auxiliary identity once per concurrent group, retaining successful emails. */
	async function resolveEmail() {
		if (identity.email !== null) return identity.email;
		if (typeof service.status !== 'function') return null;
		if (!identity.pending) {
			identity.pending = Promise.resolve().then(() => service.status())
				.then(status => {
					const email = profileEmail(status);
					if (email !== null) identity.email = email;
					return identity.email;
				}, () => identity.email)
				.finally(() => { identity.pending = null; });
		}
		return identity.pending;
	}

	/** Project only catalog-defined account records; status retains its diagnostic binding ID. */
	return async function present(toolName, value) {
		if (!value || typeof value !== 'object' || Object.hasOwn(value, 'error')) return value;
		if (toolName === 'get_status') {
			const email = profileEmail(value);
			if (email !== null) identity.email = email;
			return { ...value, accountEmail: email };
		}
		const rowKey = identityRows.get(toolName);
		const rows = rowKey && Array.isArray(value[rowKey]) ? value[rowKey] : [];
		const hasRoot = rootIdentityTools.has(toolName) && Object.hasOwn(value, 'accountId');
		if (!hasRoot && !rows.some(row => row && Object.hasOwn(row, 'accountId'))) return value;
		const email = await resolveEmail();
		const result = hasRoot ? presentRecord(value, email) : { ...value };
		if (rowKey && Array.isArray(value[rowKey])) result[rowKey] = rows.map(row => presentRecord(row, email));
		return result;
	};
}
