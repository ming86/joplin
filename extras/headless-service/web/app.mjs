import { Draft } from './draft.mjs';
import { previewDocument } from './preview.mjs';
const $ = id => document.getElementById(id);
const draft = new Draft();
let accountStatus, busy = false, authenticated = false, epoch = 0, listSequence = 0;
let page = 1, notebookPage = 1, search = null, latest = null, installEvent = null;
function showMessage(text) { $('save-status').textContent = text; }
function loginNeeded(message = '') {
	authenticated = false; epoch++; $('login-panel').hidden = false; $('workspace').hidden = true; $('logout').hidden = true;
	$('login-message').textContent = message; $('connection').textContent = 'Signed out';
}
async function api(route, data) {
	let response;
	try { response = await fetch(route, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000), headers: { 'X-Joplin-Web': '1', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) }); }
	catch { throw Object.assign(new Error('Connection failed. The save outcome may be unknown; keep this page open.'), { unknown: true }); }
	let result;
	try { result = await response.json(); } catch { throw Object.assign(new Error('The response could not be read. Keep the pending draft.'), { unknown: true }); }
	if (!response.ok) {
		if (response.status === 401) loginNeeded('Sign in again. Any draft in this page is retained.');
		throw Object.assign(new Error(result.error ?? `Request failed (${response.status}).`), { code: result.error, status: response.status, unknown: result.outcome === 'unknown' });
	}
	return result;
}
function controls() {
	const v = draft.value, locked = busy || !!draft.pending;
	$('title').readOnly = locked || !v?.editable; $('body').readOnly = locked || !v?.editable;
	$('save').disabled = busy || !v?.editable || !accountStatus?.allowWrites;
	$('save').textContent = draft.pending ? 'Retry same save' : 'Save';
	for (const id of ['new-note', 'notebook', 'refresh', 'reload', 'logout']) $(id).disabled = locked;
	$('new-note').disabled ||= !accountStatus?.allowWrites;
	$('discard').disabled = busy || !v;
	$('compare').disabled = busy || !v || v.kind !== 'update';
	$('rebase').disabled = locked || !latest?.editable;
	$('draft-status').textContent = draft.pending ? 'Pending outcome — fields locked' : draft.dirty ? 'Unsaved changes' : 'No unsaved changes';
	$('format').textContent = v?.kind === 'create' ? 'NEW MARKDOWN NOTE' : v?.editable ? 'MARKDOWN' : 'READ-ONLY SOURCE';
}
function preview(html) { $('preview').srcdoc = previewDocument(html); }
function clearDraft() {
	draft.clear(); latest = null;
	for (const id of ['title', 'body']) $(id).value = '';
	for (const id of ['latest-title', 'latest-body', 'save-status']) $(id).textContent = '';
	$('comparison').hidden = true; $('document').hidden = true; $('empty').hidden = false;
	preview(''); controls();
}
function display(result) {
	draft.load(result); latest = null; $('comparison').hidden = true;
	$('empty').hidden = true; $('document').hidden = false; $('title').value = draft.value.title; $('body').value = draft.value.body;
	preview(result.preview); controls();
}
function mayLeave() {
	if (busy || draft.pending) { showMessage('Resolve the pending save or explicitly discard its retry state before opening another note. Copy the draft to preserve it separately.'); return false; }
	return !draft.dirty || confirm('Discard the unsaved changes in this page?');
}
async function loadNote(id) {
	if (!mayLeave()) return;
	busy = true; controls(); const e = epoch;
	try { const result = await api(`/api/note/${id}`); if (e !== epoch) return; display(result); showMessage('Loaded from the headless client. Synchronization status is not observed.'); }
	catch (error) { showMessage(error.message); }
	finally { busy = false; controls(); }
}
async function refreshStatus() {
	const e = epoch;
	try {
		const result = await api('/api/status'); if (e !== epoch) return;
		accountStatus = result; $('connection').textContent = result.core === 'reachable' ? 'Client reachable' : 'Client unavailable';
		$('service-status').textContent = `Semantic index: ${result.semantic.state}. Synchronization: not observed.`; controls();
	} catch (error) { if (authenticated) $('connection').textContent = 'Service unavailable'; }
}
async function notebooks(append = false) {
	const e = epoch, result = await api(`/api/notebooks?page=${notebookPage}&limit=100`); if (e !== epoch) return;
	const previous = $('notebook').value;
	if (!append) { $('notebook').replaceChildren(new Option('All notebooks', '')); }
	for (const n of result.items) { const option = new Option(n.title, n.id); $('notebook').append(option); }
	$('notebook').value = previous; $('more-notebooks').hidden = !result.hasMore;
}
async function notes() {
	const seq = ++listSequence, e = epoch;
	try {
		const result = search ? await api('/api/search', { ...search, page, limit: 30 }) : await api(`/api/notes?page=${page}&limit=30${$('notebook').value ? '&notebookId=' + $('notebook').value : ''}`);
		if (seq !== listSequence || e !== epoch) return;
		$('notes').replaceChildren();
		for (const n of result.items) {
			const b = document.createElement('button'); b.className = 'note-button'; b.dataset.noteId = n.id;
			const title = document.createElement('strong'); title.textContent = n.title || '(Untitled)';
			const date = document.createElement('small'); date.textContent = Number.isFinite(n.updated_time) ? new Date(n.updated_time).toLocaleString() : '';
			b.append(title, date); b.setAttribute('aria-current', String(draft.value?.noteId === n.id)); b.addEventListener('click', () => void loadNote(n.id)); $('notes').append(b);
		}
		$('search-status').textContent = search ? `${result.executedMode ?? 'Unavailable'} search across all notebooks. Semantic: ${result.semantic.state}${result.semantic.reason ? ' (' + result.semantic.reason + ')' : ''}. ${result.items.length} results on this page.` : `${result.items.length} notes on this page.`;
		$('page-number').textContent = `Page ${page}`; $('previous').disabled = page <= 1; $('next').disabled = !result.hasMore || (search && search.mode !== 'keyword');
	} catch (error) { if (e === epoch) $('search-status').textContent = error.message; }
}
async function connected() {
	authenticated = true; epoch++; $('login-panel').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
	await refreshStatus(); if (!authenticated) return;
	notebookPage = 1; await notebooks(); await notes(); controls();
}
$('login-form').addEventListener('submit', async event => {
	event.preventDefault(); const input = $('access-key'), token = input.value; input.value = '';
	try { await api('/api/login', { token }); await connected(); } catch (error) { $('login-message').textContent = error.message; }
});
$('logout').addEventListener('click', async () => {
	if (!mayLeave()) return;
	try {
		await api('/api/logout', {}); clearDraft(); search = null; page = 1; notebookPage = 1; listSequence++;
		$('query').value = ''; $('mode').value = 'keyword';
		for (const id of ['service-status', 'search-status']) $(id).textContent = '';
		$('page-number').textContent = 'Page 1'; $('notes').replaceChildren();
		$('notebook').replaceChildren(new Option('All notebooks', ''));
		accountStatus = null; loginNeeded();
	}
	catch (error) { showMessage(error.message); }
});
$('discard').addEventListener('click', () => {
	if (busy || !draft.value) return;
	const message = draft.pending
		? 'Discard this page’s draft and pending retry state? The earlier save may already exist. Check Joplin before recreating it. This does not delete any note.'
		: 'Discard this page’s draft? This does not delete any saved note.';
	if (!confirm(message)) return;
	clearDraft();
});
$('title').addEventListener('input', () => { draft.edit($('title').value, draft.value?.body ?? ''); controls(); });
$('body').addEventListener('input', () => {
	let body = $('body').value;
	// The DOM normalizes newlines. Do not rewrite an untouched body on title edits;
	// preserve uniform CRLF on actual source edits as well.
	if (draft.value?.body.includes('\r\n') && !draft.value.body.replaceAll('\r\n', '').includes('\n')) body = body.replaceAll('\n', '\r\n');
	draft.edit(draft.value?.title ?? '', body); controls();
});
$('new-note').addEventListener('click', () => {
	if (!mayLeave()) return;
	const notebookId = $('notebook').value || $('notebook').options[1]?.value;
	if (!notebookId) return showMessage('Create a notebook in Joplin first.');
	draft.create(notebookId); $('title').value = ''; $('body').value = ''; latest = null; $('comparison').hidden = true;
	$('empty').hidden = true; $('document').hidden = false; preview('');
	showMessage(`New note destination: ${[...$('notebook').options].find(o => o.value === notebookId)?.textContent}.`); controls(); $('title').focus();
});
$('save').addEventListener('click', async () => {
	if (busy) return;
	const payload = draft.submit(); busy = true; controls(); const e = epoch;
	showMessage('Saving to the headless client…');
	try { const result = await api('/api/write', payload); if (e !== epoch) return; display(result); showMessage(result.reconciled ? 'Requested content confirmed locally. Synchronization is not confirmed.' : 'Saved locally. Synchronization is not confirmed.'); await notes(); }
	catch (error) {
		// No automatic retry, and no field edits after an ambiguous write.
		if (['stale_note', 'unsupported_note_format', 'invalid_web_content', 'operation_not_permitted'].includes(error.code)) draft.rejectKnown();
		showMessage(error.code === 'stale_note' ? 'This note changed elsewhere. Your draft is retained. Compare the latest version before merging and saving.' : `${error.message} Your draft is retained.${draft.pending ? ' Retry sends exactly the same saved request.' : ''}`);
	} finally { busy = false; controls(); }
});
$('preview-button').addEventListener('click', async () => {
	const e = epoch, value = draft.value, body = $('body').value;
	try { const result = await api('/api/preview', { body }); if (e === epoch && draft.value === value && $('body').value === body) preview(result.preview); }
	catch (error) { showMessage(error.message); }
});
$('compare').addEventListener('click', async () => {
	const id = draft.value?.noteId, e = epoch; if (!id) return;
	try { const result = await api(`/api/note/${id}`); if (e !== epoch || draft.value?.noteId !== id) return; latest = result; $('comparison').hidden = false; $('comparison').open = true; $('latest-title').textContent = latest.note.title; $('latest-body').textContent = latest.note.body; controls(); }
	catch (error) { showMessage(error.message); }
});
$('rebase').addEventListener('click', () => {
	if (!latest || draft.pending || !confirm('Keep your draft text and use this newer revision as its base? Review and merge any differences before pressing Save.')) return;
	draft.rebase(latest); showMessage('Draft retained with the selected newer base. Review your merged text before saving.'); controls();
});
$('reload').addEventListener('click', () => { if (draft.value?.noteId) void loadNote(draft.value.noteId); });
$('copy-draft').addEventListener('click', async () => { try { await navigator.clipboard.writeText(`${$('title').value}\n\n${$('body').value}`); showMessage('Draft copied to the system clipboard.'); } catch { showMessage('Clipboard access failed. Select and copy the source text manually.'); } });
$('refresh').addEventListener('click', async () => { try { notebookPage = 1; await notebooks(); await notes(); await refreshStatus(); } catch (error) { showMessage(error.message); } });
$('more-notebooks').addEventListener('click', async () => { notebookPage++; try { await notebooks(true); } catch (error) { notebookPage--; showMessage(error.message); } });
$('notebook').addEventListener('change', () => { search = null; page = 1; $('query').value = ''; void notes(); });
$('search-form').addEventListener('submit', event => { event.preventDefault(); const query = $('query').value.trim(); if (!query) return; search = { query, mode: $('mode').value }; page = 1; void notes(); });
$('clear-search').addEventListener('click', () => { search = null; $('query').value = ''; page = 1; void notes(); });
$('previous').addEventListener('click', () => { page = Math.max(1, page - 1); void notes(); });
$('next').addEventListener('click', () => { page++; void notes(); });
function connectivity() { $('offline').hidden = navigator.onLine; }
window.addEventListener('online', connectivity); window.addEventListener('offline', connectivity); connectivity();
window.addEventListener('beforeunload', event => { if (draft.dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installEvent = event; $('install').hidden = false; });
$('install').addEventListener('click', async () => { await installEvent?.prompt(); installEvent = null; $('install').hidden = true; });
// Re-read after back/forward restoration; never silently discard an unsaved draft.
window.addEventListener('pageshow', event => { if (event.persisted) { if (draft.dirty) showMessage('This page was restored. Check the latest version before saving.'); if (authenticated) void refreshStatus(); } });
setInterval(() => { if (authenticated && !document.hidden) void refreshStatus(); }, 30000);
try { await connected(); } catch { loginNeeded('Sign in to connect to your headless client.'); }
