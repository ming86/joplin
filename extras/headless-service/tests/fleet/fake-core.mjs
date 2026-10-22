// Explicitly simulated Joplin CLI: plaintext public synthetic fixtures only.
// This tests process/routing/lifecycle, NOT SQLite, encryption or Joplin sync.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
const profile = process.env.JOPLIN_HEADLESS_PROFILE;
const config = JSON.parse(fs.readFileSync(path.join(profile, 'fixture.json')));
const key = fs.readFileSync(Number(process.env.JOPLIN_HEADLESS_KEY_FD), 'utf8').trim(); fs.closeSync(3);
if (process.env.JOPLIN_HEADLESS !== '1' || createHash('sha256').update(key).digest('hex') !== config.keyHash) process.exit(2);
if (config.failStartup) process.exit(3);
if (process.argv[2] !== 'serve') { fs.writeFileSync(path.join(profile, 'invocation.json'), JSON.stringify(process.argv.slice(2))); process.exit(0); }
const dataFile = path.join(profile, 'synthetic-notes.json');
const shared = 'a'.repeat(32), folder = 'b'.repeat(32);
const baseNote = { id: shared, parent_id: folder, title: config.id, body: config.id + ' private synthetic body', updated_time: 1, markup_language: 1, encryption_applied: 0, deleted_time: 0, is_locked: 0, source: '' };
const notes = new Map((fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile)) : [baseNote, { ...baseNote, id: config.uniqueId, title: 'unique-' + config.id }]).map(n => [n.id, n]));
const revisions = new Map([...notes.keys()].map(id => [id, '0'.repeat(31) + '1']));
let revisionSequence = 2;
const persist = () => fs.writeFileSync(dataFile, JSON.stringify([...notes.values()])); persist();
const server = http.createServer(async (req, res) => {
 try {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.searchParams.get('token') !== config.token) { res.writeHead(403); return res.end('{}'); }
  const selected = n => { const f = u.searchParams.get('fields'); return f ? Object.fromEntries(f.split(',').filter(k => Object.hasOwn(n,k)).map(k => [k,n[k]])) : n; };
  const page = list => ({ items: list.map(selected), has_more: false });
  let body;
  if (req.method !== 'GET') { const parts=[]; for await (const b of req) parts.push(b); body=JSON.parse(Buffer.concat(parts)); }
  let result;
  if (u.pathname === '/services/headless' && req.method === 'POST') {
   if (body.action === 'readNote') {
    const n = notes.get(body.id);
    if (!n) { res.writeHead(404); return res.end('{}'); }
    result = { ...n, revision_id: revisions.get(body.id) };
   } else if (body.action === 'updateNote') {
    const n = notes.get(body.id);
    if (!n) { res.writeHead(404); return res.end('{}'); }
    const currentRevisionId = revisions.get(body.id);
    if (body.base_revision_id !== currentRevisionId) {
     result = { error: { code: 'note_conflict', applied: false } };
    } else {
     const changes = body.changes;
     const previous_revision_id = currentRevisionId;
     if (Object.hasOwn(changes, 'title')) n.title = changes.title;
     if (Object.hasOwn(changes, 'notebook_id')) n.parent_id = changes.notebook_id;
     if (Object.hasOwn(changes, 'todo_completed')) n.todo_completed = changes.todo_completed ? 1 : 0;
     if (Object.hasOwn(changes, 'body')) n.body = changes.body;
     else {
      if (Object.hasOwn(changes, 'prepend')) n.body = changes.prepend + n.body;
      if (Object.hasOwn(changes, 'append')) n.body += changes.append;
      if (Object.hasOwn(changes, 'replace_text')) {
       const { find, replace } = changes.replace_text;
       const index = n.body.indexOf(find);
       if (index >= 0 && n.body.indexOf(find, index + find.length) < 0) n.body = n.body.slice(0, index) + replace + n.body.slice(index + find.length);
      }
     }
     n.updated_time++;
     const revision_id = (revisionSequence++).toString(16).padStart(32, '0');
     revisions.set(body.id, revision_id);
     persist();
     result = { ...n, revision_id, previous_revision_id, changed: true };
    }
   } else if (body.action === 'status') {
    result = {
     accountEmail: 'alice@example.test',
     observedAt: 1000,
     serviceStartedAt: 900,
     sync: { running: false, pending: false, report: null },
     decryption: { state: 'idle', batch: null, missingMasterKey: false, disabledItemCount: 0 },
    };
   } else { res.writeHead(400); return res.end('{}'); }
  }
  else if (u.pathname === '/folders') result = { items: [{ id: folder, title: config.id, parent_id: '', encryption_applied: 0, deleted_time: 0 }], has_more: false };
  else if (u.pathname === `/folders/${folder}`) result = { id: folder, title: config.id, parent_id: '', encryption_applied: 0, deleted_time: 0 };
  else if (u.pathname === '/notes' && req.method === 'POST') {
   const id = body.id ?? randomBytes(16).toString('hex');
   if (notes.has(id)) { res.writeHead(409); return res.end('{}'); }
   result = { ...baseNote, ...body, id }; notes.set(id, result); revisions.set(id, '0'.repeat(31) + '1'); persist();
  } else if (u.pathname === '/notes' || u.pathname === `/folders/${folder}/notes`) result = page([...notes.values()]);
  else if (/^\/notes\/[a-f0-9]{32}\/tags$/.test(u.pathname)) result = { items: [], has_more: false };
  else if (u.pathname === '/search') result = page([...notes.values()].filter(n => (n.title + n.body).includes(u.searchParams.get('query'))));
  else if (u.pathname === '/events') result = { items: [], cursor: '0', has_more: false };
  else if (/^\/notes\/[a-f0-9]{32}$/.test(u.pathname)) {
   const n = notes.get(u.pathname.split('/').pop()); if (!n) { res.writeHead(404); return res.end('{}'); }
   if (req.method === 'PUT') { Object.assign(n,body); n.updated_time++; persist(); }
   result = selected(n);
  } else { res.writeHead(404); return res.end('{}'); }
  res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(result));
 } catch { res.writeHead(500); res.end('{}'); }
});
server.listen(config.port, '127.0.0.1', () => setTimeout(() => console.log('headless: private API ready; synchronization and decryption may still be pending'), config.delayReadyMs ?? 0).unref());
process.once('SIGTERM', () => { server.closeAllConnections(); server.close(); });
process.once('SIGINT', () => { server.closeAllConnections(); server.close(); });
