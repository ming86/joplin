import { endpoint, permissionPattern, operation, request } from './client.mjs';
const $ = id => document.getElementById(id);
let pending = null; let busy = false;
function say(text) { $('status').textContent = text; }
/** Returns the currently editable popup values for session-only draft storage. */
function draft() {
	return { endpoint: $('endpoint').value, token: $('token').value, notebookId: $('notebook').value, title: $('title').value, sourceUrl: $('source').value, text: $('text').value };
}
/** Persists editable values, or only a pending retry's replacement credential. */
function saveDraft() {
	// Start the write immediately. In particular, connect must not await this before
	// requesting permission, because that would no longer be a user gesture.
	if (pending) return chrome.storage.session.set({ credential: { endpoint: pending.endpoint, token: $('token').value } });
	return chrome.storage.session.set({ draft: draft() });
}
function controls() {
	for (const id of ['endpoint','notebook','title','source','text','capture']) $(id).disabled = busy || !!pending;
	$('connect').disabled = busy; $('token').disabled = busy; $('send').disabled = busy; $('discard').disabled = busy;
	$('discard').hidden = !pending; $('send').textContent = pending ? 'Retry same clip' : 'Save clip';
}
function showPending() {
	if (!pending) return;
	$('endpoint').value = pending.endpoint; $('title').value = pending.input.title;
	$('source').value = pending.input.sourceUrl; $('text').value = pending.input.text;
	$('notebook').replaceChildren(new Option(pending.input.notebookId, pending.input.notebookId));
}
/** Restores a saved editable draft and reports whether one was present. */
function showDraft(saved) {
	if (!saved) return false;
	$('endpoint').value = saved.endpoint ?? '';
	$('token').value = saved.token ?? '';
	$('title').value = saved.title ?? '';
	$('source').value = saved.sourceUrl ?? '';
	$('text').value = saved.text ?? '';
	if (saved.notebookId) $('notebook').replaceChildren(new Option(saved.notebookId, saved.notebookId));
	return true;
}
async function capture() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id || !/^https?:/.test(tab.url ?? '')) throw new Error('Open an ordinary HTTP(S) page and select text. Restricted browser pages cannot be captured.');
	const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ title: document.title, text: window.getSelection()?.toString() ?? '', sourceUrl: location.href }) });
	$('title').value = result.title; $('text').value = result.text; $('source').value = result.sourceUrl.split('#')[0];
	void saveDraft().catch(e => say(e.message));
	say(result.text ? 'Review the selection before saving.' : 'No selection. Select text on the page or paste it here.');
}
$('connect').addEventListener('click', async () => {
	if (busy) return;
	try {
		const draftSave = saveDraft();
		void draftSave.catch(e => say(e.message));
		const selectedNotebook = $('notebook').value;
		const base = endpoint($('endpoint').value);
		// Call synchronously within this user gesture, before any storage awaits.
		const granted = await chrome.permissions.request({ origins: [permissionPattern(base)] });
		if (!granted) throw new Error('Endpoint permission was not granted.');
		await draftSave;
		busy = true; controls();
		const token = $('token').value.trim();
		const result = await request(base, token, 'v1/notebooks');
		if (!Array.isArray(result.items) || result.items.length > 50 || !result.items.every(n => /^[a-f0-9]{32}$/.test(n.id) && typeof n.title === 'string')) throw new Error('Invalid notebook response.');
		$('notebook').replaceChildren(...result.items.map(n => new Option(n.title, n.id)));
		if (pending) $('notebook').value = pending.input.notebookId;
		else if (result.items.some(n => n.id === selectedNotebook)) $('notebook').value = selectedNotebook;
		await chrome.storage.local.set({ endpoint: base });
		await chrome.storage.session.set({ credential: { endpoint: base, token } });
		await saveDraft();
		say('Connected. Only permitted notebooks are listed.');
	} catch (e) { say(e.message); } finally { busy = false; controls(); }
});
$('capture').addEventListener('click', () => { if (!busy && !pending) capture().catch(e => say(e.message)); });
['endpoint','token','notebook','title','source','text'].forEach(id => {
	$(id).addEventListener('input', () => { void saveDraft().catch(e => say(e.message)); });
	$(id).addEventListener('change', () => { void saveDraft().catch(e => say(e.message)); });
});
$('send').addEventListener('click', async () => {
	if (busy) return;
	busy = true; controls();
	try {
		await saveDraft();
		const base = endpoint($('endpoint').value); const token = $('token').value.trim();
		if (!await chrome.permissions.contains({ origins: [permissionPattern(base)] })) throw new Error('Use “Allow endpoint” before saving.');
		if (!pending) {
			pending = { endpoint: base, input: operation({ notebookId: $('notebook').value, title: $('title').value, text: $('text').value, sourceUrl: $('source').value }) };
			// Persist before sending; closing the popup cannot turn a retry into a new operation.
			try { await chrome.storage.session.set({ pending }); } catch (e) { pending = null; throw e; }
		}
		await chrome.storage.session.set({ credential: { endpoint: pending.endpoint, token } });
		controls(); const result = await request(pending.endpoint, token, 'v1/clips', pending.input);
		await chrome.storage.session.remove(['pending','draft']); pending = null;
		$('text').value = ''; say(`${result.replayed ? 'Existing clip confirmed' : 'Saved locally'}: ${result.noteId}. Synchronization is not yet confirmed.`);
	} catch (e) { say(`${e.message}\n${pending ? 'Pending clip retained for this browser session. Retry sends the same operation; do not create a duplicate.' : ''}`); }
	finally { busy = false; controls(); }
});
$('discard').addEventListener('click', async () => {
	if (busy || !pending || !confirm('This clip may already be saved. Discarding only removes the local retry record; it does not delete a Joplin note. Continue?')) return;
	await chrome.storage.session.remove('pending'); pending = null; controls(); say('Local pending clip discarded.');
});
async function init() {
	await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
	const prefs = await chrome.storage.local.get('endpoint'); const state = await chrome.storage.session.get(['credential','pending','draft']);
	pending = state.pending ?? null;
	const restored = pending ? false : showDraft(state.draft);
	if (pending) $('endpoint').value = pending.endpoint;
	else if (!restored) $('endpoint').value = prefs.endpoint ?? '';
	if (!restored && state.credential?.endpoint === $('endpoint').value) $('token').value = state.credential.token;
	$('identity').textContent = `Allow this origin in your service configuration: chrome-extension://${chrome.runtime.id}`;
	showPending(); controls();
	if (pending) say('A clip has an unconfirmed outcome. Retry the same operation.'); else if (!restored) await capture();
}
init().catch(e => say(e.message));
