import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createEmbeddingTransport } from '../src/semantic/http.mjs';
import { bindEmbeddingProvider, noteFingerprint, createAccountRegistry } from '../index.mjs';
import { chunkNote, chunkSettings, fuseRanks } from '../src/semantic/chunks.mjs';
import { openSemanticStore } from '../src/semantic/store.mjs';
import { createSemanticEngine } from '../src/semantic/engine.mjs';
import { openMcpRuntime } from '../src/semantic/runtime.mjs';
import { server, readJson, note, noteId, folderId, space, account } from './fixtures.mjs';
import { ServiceError } from '../src/errors.mjs';

const sqliteModule = process.env.JOPLIN_TEST_SQLITE_MODULE;
const native = { skip: !sqliteModule ? 'Set JOPLIN_TEST_SQLITE_MODULE for real SQLCipher store/index tests.' : false };
const vectorResponse = texts => ({ data: texts.map((text, index) => ({ index, embedding: /cat|feline/.test(text) ? [1, 0] : [0, 1] })), usage: { prompt_tokens: texts.length * 3 } });
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joplin-semantic-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
async function fixture(t, options = {}) {
	const dir = temporary(t); const args = { filename: path.join(dir, 'index.db'), accountId: 'alice', key: randomBytes(32).toString('hex'), sqliteModule, space, model: 'fake', ...options };
	const store = await openSemanticStore(args); t.after(() => store.close());
	let cursor = 0; const events = []; const notes = new Map([[noteId, { ...note, title: 'cats', body: 'feline searchable protected canary', parent_id: folderId }]]);
	const change = (id = noteId) => { cursor++; events.push({ id: cursor, itemId: id, itemType: 1, type: 2 }); };
	const backend = {
		async getNote(id) { if (!notes.has(id)) throw new ServiceError('not_found'); return { ...notes.get(id) }; },
		async listNotes({ page, limit }) { const values = [...notes.values()].sort((a,b) => a.id.localeCompare(b.id)); return { items: structuredClone(values.slice((page-1)*limit, page*limit)), hasMore: values.length > page*limit }; },
		async search() { return { items: structuredClone([...notes.values()]), hasMore: false }; },
		async changes(after) { return { cursor: String(cursor), items: after === undefined ? [] : events.filter(e => e.id > Number(after)), hasMore: false }; },
	};
	let calls = 0; let transport = async texts => { calls++; return vectorResponse(texts); };
	const provider = bindEmbeddingProvider(space, (...a) => transport(...a));
	let clock = Date.now();
	const engine = createSemanticEngine({ accountId: 'alice', store, backend, provider, now: () => clock });
	t.after(() => engine.close());
	return { args, store, engine, backend, notes, change, calls: () => calls, setTransport: fn => { transport = fn; }, advance: ms => { clock += ms; } };
}

test('UTF-8 chunks cover long multilingual notes, preserve codepoints, bound input and hash content', () => {
	const text = 'English 中文 😀 newline\n'.repeat(200);
	const chunks = chunkNote({ title: 'title 中文', body: text }, { maxBytes: 256, overlapBytes: 20 });
	const source = Buffer.from(text); const covered = new Uint8Array(source.length);
	for (const c of chunks) { assert.ok(Buffer.byteLength(c.text) <= 256); assert.ok(!c.text.includes('\uFFFD')); covered.fill(1,c.start,c.end); }
	assert.ok(covered.every(Boolean)); assert.equal(chunks[0].start,0); assert.equal(chunks.at(-1).end,source.length);
	assert.deepEqual(chunkNote({ title:'',body:'' }), []);
	assert.equal(chunkNote({ title:'title-only',body:'' }).length,1);
	assert.throws(() => chunkNote({ title:'x',body:text }, { maxBytes:256,maxChunks:1 }), /chunk_limit/);
	assert.throws(() => chunkSettings({ maxBytes:100 }), /invalid_configuration/);
});
test('rank fusion combines ranks rather than incompatible raw scores and deduplicates note IDs', () => {
	const a={id:'a',score:100000}, b={id:'b',score:0.99};
	const result=fuseRanks([a,b,a],[b],10); assert.equal(result[0].id,'b'); assert.equal(result[0].provenance,'hybrid'); assert.equal(result.length,2);
});
test('real HTTP common embedding route applies preparation exactly once and reorders batch responses', async t => {
	let got;
	const url=await server(t, async(req,res)=> { got=await readJson(req); assert.equal(req.url,'/v1/embeddings'); assert.equal(req.headers.authorization,'Bearer synthetic'); res.end(JSON.stringify({data:[{index:1,embedding:[0,3]},{index:0,embedding:[2,0]}],usage:{prompt_tokens:7}})); });
	const p=bindEmbeddingProvider({...space,documentPrefix:'doc: '},createEmbeddingTransport({baseUrl:url+'/v1',model:'fake',remoteProcessing:false,apiKey:'synthetic'}));
	const result=await p.embed(['first','second'],'document'); assert.deepEqual(got.input,['doc: first','doc: second']); assert.equal(got.encoding_format,'float'); assert.deepEqual(result.vectors,[[1,0],[0,1]]); assert.equal(result.inputTokens,7);
});
test('HTTP transport refuses remote disclosure by default, invalid batches and oversized input', async () => {
	assert.throws(()=>createEmbeddingTransport({baseUrl:'https://example.com/v1',model:'m',remoteProcessing:false}),/remote_processing/);
	let calls=0; const transport=createEmbeddingTransport({baseUrl:'http://localhost/v1',model:'m',remoteProcessing:false,maxInputBytes:8,maxBatch:1},()=>{calls++;});
	await assert.rejects(transport(['123456789'],'query'),/input_too_large/); await assert.rejects(transport(['a','b'],'document'),/batch/); assert.equal(calls,0);
});
test('HTTP failures preserve bounded retry metadata without leaking provider payload or credential', async t => {
	const url=await server(t, async (_req,res)=>{ res.writeHead(429,{'retry-after':'30'}); res.end('private diagnostic'); });
	const p=bindEmbeddingProvider(space,createEmbeddingTransport({baseUrl:url,model:'fake',remoteProcessing:false}));
	await assert.rejects(p.embed(['x'],'query'), e=>e.code==='embedding_rate_limited' && e.retryAfterMs===30000 && !JSON.stringify(e).includes('private'));
});
test('redirect, malformed body, oversized reply, timeout and cancellation fail boundedly', async t => {
	let kind='redirect'; let redirected=0;
	const target=await server(t, (_req,res)=>{redirected++;res.end('{}');});
	const url=await server(t, (_req,res)=> {
		if(kind==='redirect') {res.writeHead(302,{location:target});res.end();}
		if(kind==='malformed') res.end('{bad');
		if(kind==='large') res.end('x'.repeat(100));
		if(kind==='timeout') { /* deliberately pending */ }
	});
	const f=createEmbeddingTransport({baseUrl:url,model:'m',remoteProcessing:false,maxResponseBytes:32,timeoutMs:50});
	await assert.rejects(f(['x'],'query'),/provider_unavailable/);assert.equal(redirected,0);
	kind='malformed'; await assert.rejects(f(['x'],'query'),/provider_unavailable/);
	kind='large'; await assert.rejects(f(['x'],'query'),/response_too_large/);
	kind='timeout';await assert.rejects(f(['x'],'query'),/provider_unavailable/);
	await assert.rejects(f(['x'],'query',AbortSignal.abort()),/request_cancelled/);
});

test('native encrypted index reopens, owner/key/model checks fail closed and stopped copy restores',native,async t=>{
	const f=await fixture(t); await f.engine.runOnce(); assert.equal(f.engine.status().state,'ready');
	assert.equal((await f.engine.search({query:'feline'})).items[0].id,noteId);
	assert.ok(!fs.readFileSync(f.args.filename).includes(Buffer.from('protected canary')));
	if(fs.existsSync(f.args.filename+'-wal')) assert.ok(!fs.readFileSync(f.args.filename+'-wal').includes(Buffer.from('protected canary')));
	await assert.rejects(openSemanticStore(f.args),/in_use/);
	await f.engine.close();
	await assert.rejects(openSemanticStore({...f.args,key:'0'.repeat(64)}),/store_unavailable/);
	await assert.rejects(openSemanticStore({...f.args,key:''}),/invalid_semantic_key/);
	await assert.rejects(openSemanticStore({...f.args,accountId:'bob'}),/account_mismatch/);
	await assert.rejects(openSemanticStore({...f.args,space:{...space,revision:'new'}}),/rebuild_required/);
	const copy=f.args.filename+'.restored';fs.copyFileSync(f.args.filename,copy);
	const restored=await openSemanticStore({...f.args,filename:copy}); t.after(()=>restored.close());
	assert.equal((await restored.rank([1,0]))[0].id,noteId);
	const reset=await openSemanticStore({...f.args,model:'new-model',rebuild:true});t.after(()=>reset.close());assert.equal(reset.generation,2);assert.equal((await reset.rank([1,0])).length,0);
});
test('native note chunk replacement rolls back on invalid vector and stale revision cannot publish',native,async t=>{
	const f=await fixture(t); await f.engine.runOnce(); const prior=await f.store.rank([1,0]);
	const n=f.notes.get(noteId); const row=await f.store.state(noteId);
	await assert.rejects(f.store.publish(n,row.revision,'new-hash',[{ordinal:0,start:0,end:1,text:'x',hash:'h',vector:[1]}]),/invalid_embedding/);
	assert.deepEqual(await f.store.rank([1,0]),prior);
	await f.store.enqueue([noteId]);assert.equal(await f.store.publish(n,row.revision,'new',[]),false);
	assert.equal((await f.store.rank([1,0])).length,0); // pending notes not served
});
test('native index updates/deletes/excludes locked notes and avoids re-embedding unchanged content',native,async t=>{
	const f=await fixture(t);await f.engine.runOnce();const count=f.calls();
	await f.engine.runOnce({rescan:true});assert.equal(f.calls(),count);
	f.notes.get(noteId).body='dogs';f.notes.get(noteId).title='canine';f.change();await f.engine.runOnce();assert.equal(f.calls(),count+1);
	assert.equal((await f.store.rank([0,1]))[0].score,1);
	f.notes.get(noteId).is_locked=1;f.change();await f.engine.runOnce();assert.equal((await f.store.rank([0,1])).length,0);
	f.notes.get(noteId).is_locked=0;f.change();await f.engine.runOnce();assert.equal((await f.store.rank([0,1])).length,1);
	f.notes.delete(noteId);await f.engine.runOnce({rescan:true});assert.equal((await f.store.rank([0,1])).length,0);
});
test('native stale in-flight response is discarded and newer content is indexed on next cycle',native,async t=>{
	const f=await fixture(t);let changed=false;
	f.setTransport(async texts=>{ if(!changed) {changed=true; f.notes.get(noteId).body='dogs';f.notes.get(noteId).title='canine';}return vectorResponse(texts); });
	await f.engine.runOnce();assert.equal((await f.store.rank([1,0])).length,0);assert.equal((await f.store.state(noteId)).state,'pending');
	await f.engine.runOnce();assert.equal((await f.store.rank([0,1]))[0].score,1);
});
test('native cursor queue is durable across interruption; quota pause persists and keyword fallback remains',native,async t=>{
	const f=await fixture(t);f.setTransport(async()=>{const e=new ServiceError('embedding_rate_limited');e.retryAfterMs=60000;throw e;});
	await f.engine.runOnce();const info=await f.store.info();assert.ok(info.runtime.retry_after>Date.now());assert.equal((await f.store.state(noteId)).state,'error');
	const result=await f.engine.search({query:'cat',mode:'hybrid'});assert.equal(result.executedMode,'keyword');assert.equal(result.semantic.state,'degraded');assert.equal(result.items.length,1);
	await f.engine.close();const reopened=await openSemanticStore(f.args);t.after(()=>reopened.close());assert.equal((await reopened.info()).runtime.retry_after,info.runtime.retry_after);
	await reopened.enqueue(['c'.repeat(32)],'100');assert.equal((await reopened.info()).event_cursor,'100');assert.equal((await reopened.state('c'.repeat(32))).state,'pending');
});
test('native source validation suppresses stale excerpts even before the next event poll',native,async t=>{
	const f=await fixture(t);await f.engine.runOnce();f.notes.get(noteId).body='changed immediately';
	assert.equal((await f.engine.search({query:'feline'})).items.length,0);assert.equal((await f.store.state(noteId)).state,'pending');
	await f.engine.runOnce();f.notes.delete(noteId);assert.equal((await f.engine.search({query:'feline'})).items.length,0);
});
test('native notebook scope applies before semantic ranking and unsafe query filters are never ignored',native,async t=>{
	const f=await fixture(t); const second='c'.repeat(32),other='d'.repeat(32);f.notes.set(second,{...note,id:second,parent_id:other,title:'cats two',body:'cats'});await f.engine.runOnce();
	const result=await f.engine.search({query:'cat',notebookId:other});assert.deepEqual(result.items.map(n=>n.id),[second]);
	await assert.rejects(f.engine.search({query:'cat tag:private'}),/query_syntax/);await assert.rejects(f.engine.search({query:'cat -dog'}),/query_syntax/);await assert.rejects(f.engine.search({query:'cat',page:2}),/pagination/);
	const registry=createAccountRegistry([account()],{makeBackend:()=>f.backend,makeSemanticBackend:()=>f.engine});
	assert.equal((await registry.forPrincipal('alice','alice').search({query:'cat',mode:'semantic'})).executedMode,'semantic');
	assert.throws(()=>registry.forPrincipal('bob','alice'),/account_not_available/);
});
test('native provider outage recovers from persisted pending work without blocking the core',native,async t=>{
	const f=await fixture(t);f.setTransport(async()=>{throw new ServiceError('embedding_provider_unavailable');});await f.engine.runOnce();assert.equal(f.engine.status().state,'degraded');
	f.advance(60000); f.setTransport(async texts=>vectorResponse(texts));await f.engine.runOnce();assert.equal(f.engine.status().state,'ready');
	assert.equal((await f.engine.search({query:'feline'})).items.length,1);
});
test('native API outage does not advance cursor; reconciliation failure is not an empty successful scan',native,async t=>{
	const f=await fixture(t);await f.engine.runOnce();const before=await f.store.info();
	const saved=f.backend.listNotes; f.backend.listNotes=async()=>{throw new ServiceError('backend_unavailable');};
	await assert.rejects(f.engine.runOnce({rescan:true}),/backend_unavailable/);assert.equal((await f.store.info()).event_cursor,before.event_cursor);assert.equal(f.engine.status().state,'degraded');
	f.backend.listNotes=saved;await f.engine.runOnce({rescan:true});assert.equal(f.engine.status().state,'ready');
});
test('configured bad semantic key degrades optional search without breaking keyword API access',native,async t=>{
	const dir=temporary(t); const url=await server(t,(_req,res)=>res.end(JSON.stringify({items:[note],has_more:false})));
	const tokenFile=path.join(dir,'token');fs.writeFileSync(tokenFile,'synthetic',{mode:0o600}); const keyFile=path.join(dir,'key');fs.writeFileSync(keyFile,'bad-key',{mode:0o600});
	const cfg=path.join(dir,'config.json');const a=account();
	fs.writeFileSync(cfg,JSON.stringify({accountId:'alice',baseUrl:url,apiTokenFile:tokenFile,semantic:{enabled:true,keyFile,sqliteModule,embedding:a.embedding}}));
	const runtime=await openMcpRuntime(cfg);t.after(()=>runtime.close());assert.equal(runtime.service.status().semantic.state,'unavailable');
	assert.equal((await runtime.service.search({query:'x',mode:'hybrid'})).executedMode,'keyword');
});
test('native serialized transactions roll back invalid event batch and cursor together',native,async t=>{
	const f=await fixture(t);await f.engine.runOnce();const cursor=(await f.store.info()).event_cursor;
	await assert.rejects(f.store.enqueue(['e'.repeat(32),'bad-id'],'999'),/invalid_note/);
	assert.equal(await f.store.state('e'.repeat(32)),undefined);assert.equal((await f.store.info()).event_cursor,cursor);
});
test('native cancellation leaves pending work resumable and a source cursor reset triggers reconciliation',native,async t=>{
	const f=await fixture(t);await f.engine.runOnce();f.notes.get(noteId).body='canine';f.change();
	const ac=new AbortController();f.setTransport(async()=>{ac.abort();throw new ServiceError('request_cancelled');});
	await f.engine.runOnce({signal:ac.signal});assert.equal((await f.store.state(noteId)).state,'pending');
	await f.store.enqueue([],'999');f.setTransport(async texts=>vectorResponse(texts));await f.engine.runOnce();
	assert.equal(f.engine.status().state,'ready');assert.equal((await f.store.info()).event_cursor,'1');
});
test('semantic backends cannot cross account binding even when a trusted factory returns the wrong instance',()=>{
	const r=createAccountRegistry([account()],{makeSemanticBackend:()=>({accountId:'bob',status:()=>({state:'ready'})})});
	assert.throws(()=>r.forPrincipal('alice','alice').status(),/semantic_account_mismatch/);
});
test('real ordinary SQLite and a plaintext database are rejected without plaintext adoption',{
	skip: !sqliteModule || !process.env.JOPLIN_PLAIN_SQLITE_MODULE ? 'Set SQLCipher and ordinary sqlite3 module paths.' : false,
},async t=>{
	const f=await fixture(t);await f.engine.close();
	const filename=f.args.filename+'.plain';const plain=createRequire(import.meta.url)(process.env.JOPLIN_PLAIN_SQLITE_MODULE);
	const db=await new Promise((resolve,reject)=>{const d=new plain.Database(filename,e=>e?reject(e):resolve(d));});
	await new Promise((resolve,reject)=>db.exec("CREATE TABLE valuable(body TEXT); INSERT INTO valuable VALUES('plaintext canary');",e=>e?reject(e):resolve()));
	await new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));const before=fs.readFileSync(filename);
	await assert.rejects(openSemanticStore({...f.args,filename,sqliteModule:process.env.JOPLIN_PLAIN_SQLITE_MODULE}),/sqlcipher_4_required/);
	await assert.rejects(openSemanticStore({...f.args,filename}),/semantic_store_unavailable/);
	assert.deepEqual(fs.readFileSync(filename),before);
});
