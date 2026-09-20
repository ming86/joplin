// Page-memory state only. No note database, token storage, or offline write queue.
const operationId = () => crypto.randomUUID().replaceAll('-', '');
export class Draft {
	value = null;
	base = null;
	pending = null;
	load(result) {
		this.value = { kind: 'update', noteId: result.note.id, notebookId: result.note.parent_id, title: result.note.title, body: result.note.body, baseVersion: result.version, editable: result.editable };
		this.base = { title: result.note.title, body: result.note.body };
		this.pending = null;
	}
	create(notebookId) {
		this.value = { kind: 'create', notebookId, title: '', body: '', editable: true, operationId: operationId() };
		this.base = { title: '', body: '' }; this.pending = null;
	}
	get dirty() { return !!this.pending || (!!this.value && (this.value.title !== this.base.title || this.value.body !== this.base.body)); }
	edit(title, body) {
		if (!this.value?.editable || this.pending) return;
		this.value.title = title; this.value.body = body;
	}
	submit() {
		if (this.pending) return structuredClone(this.pending);
		if (!this.value?.editable) throw new Error('No editable note selected.');
		const v = this.value;
		this.pending = { kind: v.kind, operationId: v.operationId ?? operationId(), title: v.title, body: v.body,
			...(v.kind === 'create' ? { notebookId: v.notebookId } : { noteId: v.noteId, baseVersion: v.baseVersion }) };
		return structuredClone(this.pending);
	}
	// Only known pre-write rejections unlock edits. Transport failures stay pending.
	rejectKnown() { this.pending = null; }
	rebase(result) {
		if (this.pending || this.value?.kind !== 'update' || result.note.id !== this.value.noteId || !result.editable) throw new Error('Cannot rebase this draft.');
		this.value.baseVersion = result.version;
		this.base = { title: result.note.title, body: result.note.body };
	}
	clear() { this.value = null; this.base = null; this.pending = null; }
}
