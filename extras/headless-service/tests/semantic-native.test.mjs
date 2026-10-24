import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { StdioTestClient } from '../scripts/lib/stdio-client.mjs';
import { server, readJson } from './fixtures.mjs';
import { openMcpRuntime } from '../src/semantic/runtime.mjs';
import { prepareSemanticCheck } from '../scripts/lib/prepare-semantic-check.mjs';
const cli = process.env.JOPLIN_MCP_TEST_CLI;
const sqliteModule = process.env.JOPLIN_HEADLESS_SQLITE_MODULE;

test('actual SQLCipher Joplin core -> HTTP fixture embeddings -> encrypted semantic DB -> separate MCP client', {
	skip: !cli || !sqliteModule ? 'Set JOPLIN_MCP_TEST_CLI and JOPLIN_HEADLESS_SQLITE_MODULE.' : false, timeout: 120000,
}, async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joplin-semantic-native-'));
	const children = new Set();
	async function stop(child) {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const done = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
		await done; clearTimeout(timer);
	}
	t.after(async () => { for (const child of children) await stop(child); fs.rmSync(dir, { recursive: true, force: true }); });
	const key = randomBytes(32).toString('hex'), token = randomBytes(32).toString('hex');
	const home = path.join(dir, 'home'); fs.mkdirSync(home);
	function start(args, input = '') {
		const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, HOME: home, JOPLIN_HEADLESS: '1', JOPLIN_HEADLESS_PROFILE: path.join(dir, 'profile'), JOPLIN_HEADLESS_KEY_FD: '3' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
		children.add(child); child.out = ''; child.err = '';
		child.stdout.on('data', b => { child.out += b; }); child.stderr.on('data', b => { child.err += b; });
		child.stdio[3].end(key+'\n'); child.stdin.end(input); return child;
	}
	async function until(check, message, ms = 45000) { const end = Date.now()+ms; while (Date.now()<end) { if(await check())return; await new Promise(r=>setTimeout(r,100)); } assert.fail(message); }
	const listener = net.createServer(); listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
	const setup=start(['config','--import'],JSON.stringify({'api.port':port,'api.token':token,'sync.target':0})); assert.equal((await once(setup,'exit'))[0],0);
	const daemon=start(['serve']);await until(()=>daemon.out.includes('headless: private API ready'),'core unready');
	const baseUrl=`http://127.0.0.1:${port}`;
	async function raw(route, method='GET', body) { const url=new URL(route,baseUrl);url.searchParams.set('token',token);const res=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});assert.ok(res.ok,`Setup API ${res.status}`);const text=await res.text();return text?JSON.parse(text):null; }
	const folder=await raw('/folders','POST',{title:'Synthetic semantic test'});
	const note=await raw('/notes','POST',{parent_id:folder.id,title:'Cats',body:'Protected feline topic fixture',markup_language:1});
	await raw('/notes','POST',{parent_id:folder.id,title:'Garden',body:'Plants and flowers',markup_language:1});
	let fail=false, documentRequests=0;
	const embeddingUrl=await server(t,async(req,res)=> {
		assert.equal(req.url,'/v1/embeddings');const input=await readJson(req);assert.equal(input.model,'test-only-topic-router');
		if(fail) {res.writeHead(429,{'retry-after':'1'});res.end('Synthetic quota error');return;}
		if(input.input.some(s=>s.includes('\n\n')))documentRequests++;
		const data=input.input.map((text,index)=>({index,embedding:/cat|feline/i.test(text)?[1,0,0]:/dog|canine/i.test(text)?[0,1,0]:[0,0,1]}));
		res.end(JSON.stringify({data:data.reverse(),usage:{prompt_tokens:input.input.length*4}}));
	});
	const tokenFile=path.join(dir,'token'),keyFile=path.join(dir,'index-key'),databasePath=path.join(dir,'semantic.db');
	fs.writeFileSync(tokenFile,token,{mode:0o600});fs.writeFileSync(keyFile,randomBytes(32).toString('hex'),{mode:0o600});
	const configFile=path.join(dir,'mcp.json');
	fs.writeFileSync(configFile,JSON.stringify({accountId:'acceptance',baseUrl,apiTokenFile:tokenFile,allowWrites:false,semanticDatabasePath:databasePath,semantic:{enabled:true,keyFile,sqliteModule,pollMs:100,rescanMs:10000,chunks:{maxBytes:512,overlapBytes:0},embedding:{protocol:'openai-embeddings',baseUrl:embeddingUrl+'/v1',model:'test-only-topic-router',remoteProcessing:false,space:{id:'synthetic-v1',revision:'fixture-not-a-model',dimensions:3,preprocessingVersion:'title-body-v1'}}}}));
	let client=new StdioTestClient(configFile);t.after(()=>client.close());await client.initialize();
	await until(async()=> (await client.call('get_status')).structuredContent.semantic.state==='ready','semantic not ready');
	assert.ok(documentRequests>0);
	let result=await client.call('search_notes',{query:'feline',mode:'semantic'});
	assert.equal(result.isError,false);assert.equal(result.structuredContent.executedMode,'semantic');assert.equal(result.structuredContent.results[0].id,note.id);
	assert.equal(result.structuredContent.results[0].provenance,'semantic');assert.equal(typeof result.structuredContent.results[0].score,'number');assert.ok(result.structuredContent.results[0].semanticExcerpt);assert.equal(result.structuredContent.results[0].chunk.offsetUnit,'utf8-byte');
	await until(async()=>{const keyword=await client.call('search_notes',{query:'feline',mode:'keyword'});return keyword.structuredContent.results.some(item=>item.id===note.id);},'native keyword search did not index the synthetic feline note');
	result=await client.call('search_notes',{query:'feline',mode:'hybrid',notebookId:folder.id});assert.equal(result.structuredContent.executedMode,'hybrid');assert.equal(result.structuredContent.results[0].id,note.id);
	assert.equal(result.structuredContent.results[0].provenance,'hybrid');assert.equal(typeof result.structuredContent.results[0].score,'number');
	const longNote=await raw('/notes','POST',{parent_id:folder.id,title:'Long feline topic',body:'Feline full chunk fixture. '.repeat(120),markup_language:1});
	await until(async()=>{const semantic=(await client.call('get_status')).structuredContent.semantic;return semantic.state==='ready'&&semantic.indexedNotes>=3;},'long note was not indexed');
	result=await client.call('semantic_search_notes',{query:'feline'});
	assert.equal(result.isError,false);assert.ok(result.structuredContent.total>1);
	const matchingChunks=result.structuredContent.results.filter(item=>item.note_id===longNote.id);
	assert.ok(new Set(matchingChunks.map(item=>item.chunk_index)).size>1,'a long note returns multiple matching chunks');
	assert.ok(matchingChunks.some(item=>item.chunk_text.length>320),'chunk_text contains the complete chunk rather than the stored 320-character excerpt');

	const decoyFolder=await raw('/folders','POST',{title:'Synthetic semantic decoys'});
	const scopedNoteId='f'.repeat(32);
	const scopedNote=await raw('/notes','POST',{id:scopedNoteId,parent_id:folder.id,title:'Canine scope target',body:'Canine scope target body',markup_language:1});
	const decoyId='0'.repeat(31)+'1';
	await raw('/notes','POST',{id:decoyId,parent_id:decoyFolder.id,title:'Canine routing decoy',body:'canine decoy. '.repeat(3700),markup_language:1});
	const scopeTag=await raw('/tags','POST',{title:'Semantic scope target'});
	await raw(`/tags/${scopeTag.id}/notes`,'POST',{id:scopedNote.id});
	await until(async()=>{const semantic=(await client.call('get_status')).structuredContent.semantic;return semantic.state==='ready'&&semantic.indexedNotes>=5;},'scope fixtures were not indexed');
	result=await client.call('semantic_search_notes',{query:'canine',notebook_id:folder.id,relevance:'strict'});
	assert.equal(result.isError,false);assert.ok(result.structuredContent.results.some(item=>item.note_id===scopedNote.id));
	assert.ok(!result.structuredContent.results.some(item=>item.note_id===decoyId),'the out-of-notebook decoy does not consume the ranking window');
	result=await client.call('semantic_search_notes',{query:'canine',tag_id:scopeTag.id,relevance:'strict'});
	assert.equal(result.isError,false);assert.deepEqual(result.structuredContent.results.map(item=>item.note_id),[scopedNote.id]);
	await raw(`/notes/${scopedNote.id}`,'DELETE');await raw(`/notes/${decoyId}`,'DELETE');await raw(`/notes/${longNote.id}`,'DELETE');
	await until(async()=>{const semantic=(await client.call('get_status')).structuredContent.semantic;return semantic.state==='ready'&&semantic.indexedNotes<=2;},'scope fixtures were not removed from the index');
	assert.equal((await client.request('tools/list')).tools.length,18);
	t.diagnostic('PASS native core, common HTTP batch response reordering, encrypted semantic DB, full chunk text and notebook/tag-scoped MCP chunk search');
	fail=true;await raw(`/notes/${note.id}`,'PUT',{title:'Dogs',body:'Canine replacement fixture'});
	await until(async()=> (await client.call('get_status')).structuredContent.semantic.state==='degraded','provider failure not reported');
	result=await client.call('semantic_search_notes',{query:'canine'});
	assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,'embedding_rate_limited');
	result=await client.call('search_notes',{query:'Dogs',mode:'hybrid'});assert.equal(result.structuredContent.executedMode,'keyword');
	assert.ok((await client.call('get_note',{id:note.id})).structuredContent.body.includes('Canine'));
	await until(async()=>{const keyword=await client.call('search_notes',{query:'Dogs',mode:'keyword'});return keyword.structuredContent.results.some(item=>item.id===note.id);},'keyword search did not return the updated note while embeddings were unavailable');
	result=await client.call('search_notes',{query:'Dogs',mode:'keyword'});assert.equal(result.structuredContent.executedMode,'keyword');assert.equal(result.structuredContent.results[0].id,note.id);
	fail=false;await until(async()=> (await client.call('get_status')).structuredContent.semantic.state==='ready','provider recovery failed');
	assert.equal((await client.call('search_notes',{query:'canine',mode:'semantic'})).structuredContent.results[0].id,note.id);
	await client.close();assert.equal(client.child.exitCode,0);
	assert.ok(!fs.readFileSync(databasePath).includes(Buffer.from('Canine replacement fixture')));
	async function script(name, args) {
		const child = spawn(process.execPath, [fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), ...args], { stdio: ['ignore','pipe','pipe'] });
		children.add(child); let text='',errorText=''; child.stdout.on('data', b=>{text+=b;}); child.stderr.on('data', b=>{errorText+=b;});
		assert.equal((await once(child,'exit'))[0],0,`Acceptance script ${name} failed: ${errorText}`); return text;
	}
	assert.ok((await script('check-embedding.mjs',[configFile])).includes('PASS embedding-http-shape'));
	const relevanceFile=path.join(dir,'relevance.json');fs.writeFileSync(relevanceFile,JSON.stringify({cases:[{query:'canine',expectedNoteIds:[note.id]}]}));
	assert.ok((await script('check-semantic.mjs',[configFile,relevanceFile])).includes('PASS semantic-retrieval-check'));
	t.diagnostic('PASS acceptance scripts exercised with real core/storage and fixture HTTP provider (not a live-model pass)');
	const appended = await raw('/notes','POST',{parent_id:folder.id,title:'New Japanese note',body:'新しい植物の記録',markup_language:1});
	const prep = await openMcpRuntime(configFile,{background:false});
	try {
		// This demonstrates why simply accepting persisted ready is insufficient.
		assert.equal((await prep.service.status()).semantic.state,'ready');
		const before = (await prep.service.status()).semantic.indexedNotes;
		const after = await prepareSemanticCheck(prep,10000);
		assert.equal(after.indexedNotes,before+1);
	} finally {await prep.close();}
	fs.writeFileSync(relevanceFile,JSON.stringify({cases:[{query:'plants',expectedNoteIds:[appended.id],notebookId:folder.id}]}));
	assert.ok((await script('check-semantic.mjs',[configFile,relevanceFile])).includes('PASS semantic-retrieval-check'));
	t.diagnostic('PASS persisted-ready index reconciled newly appended note before relevance evaluation');

	client=new StdioTestClient(configFile);await client.initialize();
	await until(async()=> (await client.call('get_status')).structuredContent.semantic.state==='ready','restart failed');
	assert.equal((await client.call('search_notes',{query:'canine',mode:'semantic'})).structuredContent.results[0].id,note.id);
	await raw(`/notes/${note.id}`,'DELETE');
	result=await client.call('search_notes',{query:'canine',mode:'semantic'});assert.ok(!result.structuredContent.results.some(n=>n.id===note.id));
	await client.close();assert.equal(client.child.exitCode,0);await stop(daemon);assert.equal(daemon.exitCode,0);
	t.diagnostic('PASS changed-note indexing, quota fallback/recovery, semantic owner restart/key reopen and immediate deleted-result suppression');
	t.diagnostic('Embedding endpoint was a deterministic HTTP fixture, NOT BGE-M3 or a measured language model. No live provider/relevance claim.');
});
