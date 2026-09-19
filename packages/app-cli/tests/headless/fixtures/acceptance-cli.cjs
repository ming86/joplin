// SIMULATED CLI for exercising the acceptance runner itself. No Joplin or encryption.
// Never use this fixture as evidence of native storage, FTS or E2EE behavior.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const headless = process.env.JOPLIN_HEADLESS === '1';
const args = process.argv.slice(2);
let profile;
if (headless) {
	profile = process.env.JOPLIN_HEADLESS_PROFILE;
	if (fs.readFileSync(3, 'utf8').trim().length !== 64) process.exit(99);
} else {
	const index = args.indexOf('--profile'); profile = args[index + 1]; args.splice(index, 2);
	args.splice(args.indexOf('--no-welcome'), 1);
}
const filename = path.join(profile, 'database.sqlite');
const db = JSON.parse(fs.readFileSync(filename, 'utf8'));
const save = () => {
	fs.writeFileSync(filename, JSON.stringify(db));
	fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ 'api.port': db.settings['api.port'] }));
};
let syncing;
async function sync() {
	if (syncing) return syncing;
	syncing = (async () => {
		const response = await fetch(`${db.settings['sync.9.path']}/snapshot`, {
			method: 'POST', body: JSON.stringify({ notes: db.notes, folders: db.folders }),
			signal: AbortSignal.timeout(1000),
		});
		if (!response.ok) throw new Error('simulated-outage');
		const remote = await response.json();
		for (const [id, item] of Object.entries(remote.notes)) if (!db.notes[id] || db.notes[id].updated < item.updated) db.notes[id] = item;
		Object.assign(db.folders, remote.folders); save();
	})().finally(() => { syncing = null; });
	return syncing;
}
async function main() {
	if (headless && ['sync', 'e2ee'].includes(args[0])) process.exit(98);
	if (args[0] === 'config') {
		if (args.includes('--export')) console.log(JSON.stringify(db.settings));
		else { let text = ''; for await (const chunk of process.stdin) text += chunk; Object.assign(db.settings, JSON.parse(text)); save(); }
	} else if (args[0] === 'sync') await sync();
	else if (args[0] === 'e2ee') return;
	else if (args[0] === 'cat') { if (!db.notes[args[1]]) process.exit(1); console.log(db.notes[args[1]].body); }
	else if (args[0] === 'set') { db.notes[args[1]][args[2]] = args[3]; db.notes[args[1]].updated = Date.now(); save(); }
	else if (args[0] === 'use') return;
	else if (args[0] === 'ls') console.log(JSON.stringify(Object.values(db.notes)));
	else if (args[0] === 'serve') {
		const server = http.createServer(async (req, res) => {
			const url = new URL(req.url, 'http://localhost');
			if (url.searchParams.get('token') !== db.settings['api.token']) { res.writeHead(403); res.end(); return; }
			let body = ''; for await (const chunk of req) body += chunk;
			let result;
			if (req.method === 'POST') {
				const item = { ...JSON.parse(body), id: randomBytes(16).toString('hex'), updated: Date.now(), encryption_applied: 0 };
				(url.pathname === '/folders' ? db.folders : db.notes)[item.id] = item; save(); result = item;
			} else if (url.pathname === '/search') result = { items: Object.values(db.notes).filter(note => note.body.includes(url.searchParams.get('query'))) };
			else result = { items: Object.values(db.folders) };
			res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
		});
		await new Promise(resolve => server.listen(db.settings['api.port'], '127.0.0.1', resolve));
		const timer = setInterval(() => { void sync().catch(() => {}); }, 50);
		void sync().catch(() => {});
		console.log('headless: private API ready; SIMULATED TEST FIXTURE');
		process.on('SIGTERM', async () => {
			clearInterval(timer); await new Promise(resolve => server.close(resolve));
			try { await syncing; } catch (_error) {} save();
		});
	} else throw new Error('unsupported-fixture-command');
}
void main().catch(() => { process.exitCode = 1; });
