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
import { createRequire } from 'node:module';
import { literalMarkdown } from '../src/clipper/service.mjs';
import { server, readJson } from './fixtures.mjs';
import { StdioTestClient } from '../scripts/lib/stdio-client.mjs';
const cli = process.env.JOPLIN_MCP_TEST_CLI, sqliteModule = process.env.JOPLIN_HEADLESS_SQLITE_MODULE;

test('actual clipping HTTP process: lost reply/restart reconciliation, literal text, FTS, semantic fixtures and E2EE sync', {
	skip: !cli || !sqliteModule ? 'Set JOPLIN_MCP_TEST_CLI and JOPLIN_HEADLESS_SQLITE_MODULE.' : false, timeout: 180000,
}, async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joplin-clip-native-')); const children = new Set(); let mcp;
	const key = randomBytes(32).toString('hex'), token = randomBytes(32).toString('hex'), clipToken = randomBytes(32).toString('hex'), password = randomBytes(24).toString('hex');
	const profile = path.join(dir, 'encrypted'), normal = path.join(dir, 'normal'), syncPath = path.join(dir, 'sync'), home = path.join(dir, 'home'); fs.mkdirSync(syncPath); fs.mkdirSync(home);
	async function stop(c) { if (c.exitCode !== null || c.signalCode !== null) return; const done = once(c,'exit'); c.kill('SIGTERM'); const timer = setTimeout(()=>c.kill('SIGKILL'),10000); await done; clearTimeout(timer); }
	t.after(async()=> { await mcp?.close(); for(const c of children) await stop(c); fs.rmSync(dir,{recursive:true,force:true}); });
	function track(c) { children.add(c); c.output=''; c.stderr.resume(); c.stdout.on('data',b=>{c.output+=b;}); return c; }
	function core(args, input='', encrypted=true) {
		const env={...process.env,HOME:home}; if(encrypted) Object.assign(env,{JOPLIN_HEADLESS:'1',JOPLIN_HEADLESS_PROFILE:profile,JOPLIN_HEADLESS_KEY_FD:'3'});
		else {delete env.JOPLIN_HEADLESS;delete env.JOPLIN_HEADLESS_PROFILE;delete env.JOPLIN_HEADLESS_KEY_FD;}
		const c=track(spawn(process.execPath,[cli,...(encrypted?[]:['--profile',normal]),...args],{env,stdio:['pipe','pipe','pipe','pipe']})); c.stdio[3].end(encrypted?key+'\n':'');c.stdin.end(input);return c;
	}
	async function command(args,input='',encrypted=true) {const c=core(args,input,encrypted); const timeout=setTimeout(()=>c.kill('SIGKILL'),40000); const [code]=await once(c,'exit');clearTimeout(timeout);assert.equal(code,0,`CLI ${args[0]} failed; no secret diagnostics printed`);return c.output;}
	async function port() {const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(r=>s.close(r));return n;}
	async function until(fn,msg,ms=45000) {const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}assert.fail(msg);}
	const apiPort=await port(), clipPort=await port(), api=`http://127.0.0.1:${apiPort}`, clipBase=`http://127.0.0.1:${clipPort}`;
	await command(['config','--import'],JSON.stringify({'sync.target':2,'sync.2.path':syncPath,'api.port':apiPort,'api.token':token}));
	// Fresh disposable identity only. Never reset/reprovision an existing profile.
	await command(['e2ee','enable','--password',password]);await command(['sync']);
	const daemon=core(['serve']);await until(()=>daemon.output.includes('headless: private API ready'),'core did not start');
	async function raw(route,method='GET',body) {const url=new URL(route,api);url.searchParams.set('token',token);const res=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});assert.ok(res.ok,`API ${res.status}`);const text=await res.text();return text?JSON.parse(text):null;}
	const folder=await raw('/folders','POST',{title:'Disposable clipping acceptance'});
	const apiFile=path.join(dir,'api-token'),clipFile=path.join(dir,'clip-token'),config=path.join(dir,'clip.json');
	fs.writeFileSync(apiFile,token,{mode:0o600});fs.writeFileSync(clipFile,clipToken,{mode:0o600});
	fs.writeFileSync(config,JSON.stringify({accountId:'acceptance',namespace:randomBytes(16).toString('hex'),baseUrl:api,apiTokenFile:apiFile,clipTokenFile:clipFile,notebookIds:[folder.id],port:clipPort}));
	function clipper() {return track(spawn(process.execPath,[fileURLToPath(new URL('../clipper.mjs',import.meta.url)),config],{stdio:['ignore','pipe','pipe']}));}
	let service=clipper();await until(()=>service.output.includes('clipper: ready'),'clipper did not start');
	const headers={Authorization:`Bearer ${clipToken}`,'Content-Type':'application/json'};
	assert.equal((await fetch(clipBase+'/v1/notebooks')).status,401);
	const notebooks=await (await fetch(clipBase+'/v1/notebooks',{headers})).json();assert.deepEqual(notebooks.items,[{id:folder.id,title:'Disposable clipping acceptance'}]);
	let drop=true;
	const proxy=await server(t,async(req,res)=> {const body=req.method==='POST'?await readJson(req):undefined;const upstream=await fetch(clipBase+req.url,{method:req.method,headers:{Authorization:req.headers.authorization,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const text=await upstream.text();if(drop&&req.method==='POST'&&upstream.ok){drop=false;res.destroy();return;}res.writeHead(upstream.status,{'Content-Type':'application/json'});res.end(text);});
	const marker='clipcanary'+randomBytes(6).toString('hex');
	const input={operationId:randomBytes(16).toString('hex'),notebookId:folder.id,title:'Selected safe text',text:`${marker} 日本語 笔记\n![x](file:///etc/hostname)\n<img src="http://127.0.0.1:1/x.png">\n[embedded_pdf](http://127.0.0.1:1/a.pdf)`,sourceUrl:'https://example.test/article#section'};
	const require=createRequire(cli);const {extractMediaUrls}=require('@joplin/lib/services/rest/routes/notes');
	assert.deepEqual(extractMediaUrls(1,literalMarkdown(input.text)),[]);
	await assert.rejects(fetch(proxy+'/v1/clips',{method:'POST',headers,body:JSON.stringify(input)}));
	await stop(service);assert.equal(service.exitCode,0);service=clipper();await until(()=>service.output.includes('clipper: ready'),'restart failed');
	const retried=await fetch(proxy+'/v1/clips',{method:'POST',headers,body:JSON.stringify(input)});assert.equal(retried.status,200);const result=await retried.json();assert.equal(result.replayed,true);assert.equal(result.saved,'local');assert.equal(result.synchronization,'not_confirmed');
	const saved=await raw(`/notes/${result.noteId}?fields=id,title,body,source,source_url`);
	assert.ok(saved.body.includes(marker));assert.ok(saved.body.includes('日本語'));assert.ok(saved.source.startsWith('joplin-headless-clip/v1:'));assert.equal(saved.source_url,'https://example.test/article');
	assert.deepEqual((await raw(`/notes/${result.noteId}/resources`)).items,[]);
	assert.equal((await raw(`/folders/${folder.id}/notes`)).items.length,1);
	const conflict=await fetch(proxy+'/v1/clips',{method:'POST',headers,body:JSON.stringify({...input,text:'changed retry'})});assert.equal(conflict.status,409);await conflict.text();
	await until(async()=> (await raw(`/search?query=${marker}`)).items.some(n=>n.id===result.noteId),'clip not indexed by FTS');
	await until(()=>fs.existsSync(path.join(syncPath,result.noteId+'.md')),'clip not synchronized automatically');
	const synced=fs.readFileSync(path.join(syncPath,result.noteId+'.md'),'utf8');assert.ok(synced.includes('encryption_applied: 1'));assert.ok(!synced.includes(marker));
	await command(['config','--import'],JSON.stringify({'sync.target':2,'sync.2.path':syncPath,'encryption.masterPassword':password}),'',false);await command(['sync'],'',false);await command(['e2ee','decrypt','--force'],'',false);assert.ok((await command(['cat',result.noteId],'',false)).includes(marker));
	t.diagnostic('PASS HTTP lost reply, new service process replay, one note/no resources, FTS and automatic E2EE transfer to normal-mode client of same binary');
	const embedding=await server(t,async(req,res)=> {const data=await readJson(req);res.end(JSON.stringify({data:data.input.map((text,index)=>({index,embedding:text.includes(marker)?[1,0]:[0,1]}))}));});
	const keyFile=path.join(dir,'semantic-key'),mcpConfig=path.join(dir,'mcp.json');fs.writeFileSync(keyFile,randomBytes(32).toString('hex'),{mode:0o600});
	fs.writeFileSync(mcpConfig,JSON.stringify({accountId:'acceptance',baseUrl:api,apiTokenFile:apiFile,allowWrites:false,semanticDatabasePath:path.join(dir,'semantic.db'),semantic:{enabled:true,keyFile,sqliteModule,pollMs:100,embedding:{protocol:'openai-embeddings',baseUrl:embedding+'/v1',model:'fixture-not-a-model',remoteProcessing:false,space:{id:'clip-test',revision:'fixture-v1',dimensions:2,preprocessingVersion:'title-body-v1'}}}}));
	mcp=new StdioTestClient(mcpConfig);await mcp.initialize();await until(async()=> (await mcp.call('get_status')).structuredContent.semantic.state==='ready','semantic indexing failed');
	const search=await mcp.call('search_notes',{query:marker,mode:'hybrid',notebookId:folder.id});assert.equal(search.isError,false);assert.equal(search.structuredContent.executedMode,'hybrid');assert.equal(search.structuredContent.items[0].id,result.noteId);
	await mcp.close();assert.equal(mcp.child.exitCode,0);
	await raw(`/notes/${result.noteId}`,'DELETE');const deletedReplay=await fetch(clipBase+'/v1/clips',{method:'POST',headers,body:JSON.stringify(input)});assert.equal(deletedReplay.status,409);await deletedReplay.text();
	await stop(service);await stop(daemon);assert.equal(service.exitCode,0);assert.equal(daemon.exitCode,0);
	assert.ok(!fs.readFileSync(path.join(profile,'database.sqlite')).includes(Buffer.from(marker)));
	t.diagnostic('PASS clipped note in encrypted semantic index/MCP using deterministic HTTP fixture, trashed replay rejected, graceful shutdown. No live-model/browser claim.');
});
