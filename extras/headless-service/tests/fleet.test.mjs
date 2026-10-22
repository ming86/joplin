import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fixture, running, until, login, web, clip, write, sharedId, folderId } from './fleet/fixtures.mjs';
import { loadFleetConfig, checkSecrets } from '../src/fleet/config.mjs';
import { connectPrivateSocket, firstLine } from '../src/fleet/socket.mjs';
import { StdioTestClient } from '../scripts/lib/stdio-client.mjs';
const connectEntry=fileURLToPath(new URL('../mcp-connect.mjs',import.meta.url));
async function mcp(t,a,connection=a.connection){const c=new StdioTestClient(connection,connectEntry,{timeoutMs:5000});t.after(()=>c.close());await c.initialize();return c;}

test('fleet: two real worker processes route web/clipper/MCP to separate synthetic cores, even for identical note IDs',async t=>{
 const f=await fixture(t),fleet=await f.start();const[a,b]=f.accounts;
 const [as,bs]=await Promise.all([running(fleet,'alice'),running(fleet,'bob')]);assert.notEqual(as.corePid,bs.corePid);assert.notEqual(as.workerPid,bs.workerPid);
 const [al,bl]=await Promise.all([login(a),login(b)]);assert.equal(al.status,200);assert.equal(bl.status,200);assert.notEqual(al.cookie.split('=')[0],bl.cookie.split('=')[0]);
 const jar=al.cookie+'; '+bl.cookie;
 for(const c of[a,b]){const r=await web(c,'/api/note/'+sharedId,{cookie:jar});assert.equal(r.status,200);assert.equal(r.body.note.accountId,c.id);assert.equal(r.body.note.body,c.id+' private synthetic body');}
 assert.equal((await login(b,a.tokens.web)).status,401);assert.equal((await web(b,'/api/notes',{cookie:al.cookie})).status,401);
 assert.equal((await web(a,'/api/note/'+b.uniqueId,{cookie:jar})).status,404);
 assert.equal((await web(a,'/api/notes?accountId=bob',{cookie:jar})).status,400);
 assert.equal((await web(a,'/api/search',{cookie:jar,body:{query:'bob',mode:'keyword'}})).body.items.length,0);
 assert.equal((await clip(b,a.tokens.clip)).status,401);assert.equal((await clip(a)).body.items[0].title,'alice');
 const input={operationId:'c'.repeat(32),notebookId:folderId,title:'Clip',text:'Literal 中文',sourceUrl:'https://example.test/'};
 const ac=await clip(a,a.tokens.clip,input),bc=await clip(b,b.tokens.clip,input);assert.equal(ac.status,201);assert.equal(bc.status,201);assert.notEqual(ac.body.noteId,bc.body.noteId);
 assert.equal((await web(a,'/api/note/'+bc.body.noteId,{cookie:jar})).status,404);
 assert.equal((await clip(a,a.tokens.clip,{...input,accountId:'bob'})).status,400);
 const [am,bm]=await Promise.all([mcp(t,a),mcp(t,b)]);
 assert.equal((await am.call('get_note',{id:sharedId})).structuredContent.body,'alice private synthetic body');assert.equal((await bm.call('get_note',{id:sharedId})).structuredContent.body,'bob private synthetic body');
 assert.equal((await am.call('get_note',{id:b.uniqueId})).isError,true);assert.equal((await am.call('get_note',{id:sharedId,accountId:'bob'})).isError,true);
 const second=await mcp(t,a);await am.close();assert.equal((await second.call('get_note',{id:sharedId})).isError,false);
 const bad=path.join(a.base,'bad-connect.json');write(bad,{socketPath:b.config.mcp.socketPath,tokenFile:a.config.mcp.tokenFile});
 const rejected=new StdioTestClient(bad,connectEntry,{timeoutMs:3000});t.after(()=>rejected.close());await assert.rejects(rejected.initialize());assert.match(rejected.stderr,/mcp_authentication_failed/);
	const bobNote=await bm.call('read_note',{id:sharedId});
	const bw=await bm.call('update_note',{id:sharedId,base_revision_id:bobNote.structuredContent.revision_id,body:'bob changed'});assert.equal(bw.isError,false);assert.equal((await web(b,'/api/note/'+sharedId,{cookie:jar})).body.note.body,'bob changed');
 assert.equal((await web(a,'/api/note/'+sharedId,{cookie:jar})).body.note.body,'alice private synthetic body');
 await am.close();await bm.close();await second.close();
});

test('fleet: independent restart, durable disable, old sessions revoked and same profile retained on re-enable',async t=>{
 const f=await fixture(t),fleet=await f.start();const[a,b]=f.accounts;await running(fleet,'alice');const before=await running(fleet,'bob');
 const al=await login(a),bl=await login(b);const client=await mcp(t,a);
 const saved=await web(a,'/api/write',{cookie:al.cookie,body:{kind:'create',operationId:'d'.repeat(32),notebookId:folderId,title:'Persist me',body:'retained'}});assert.equal(saved.status,200);
 const restarted=await fleet.command({action:'restart',accountId:'alice'});assert.equal(restarted.state,'running');assert.equal((await fleet.command({action:'status',accountId:'bob'})).corePid,before.corePid);
 assert.equal((await web(a,'/api/notes',{cookie:al.cookie})).status,401);assert.equal((await web(b,'/api/notes',{cookie:bl.cookie})).status,200);
 await until(async()=>client.child.exitCode,v=>v!==null);await client.close();
 const al2=await login(a);assert.equal((await web(a,'/api/note/'+saved.body.note.id,{cookie:al2.cookie})).body.note.body,'retained');
 assert.equal((await fleet.command({action:'disable',accountId:'alice'})).state,'disabled');
 await assert.rejects(web(a,'/api/status',{cookie:al2.cookie}));await assert.rejects(clip(a));await assert.rejects(connectPrivateSocket(a.config.mcp.socketPath));
 assert.equal((await web(b,'/api/notes',{cookie:bl.cookie})).status,200);assert.ok(fs.existsSync(path.join(a.profile,'synthetic-notes.json')));
 await fleet.close();const again=await f.start();await running(again,'bob');assert.equal((await again.command({action:'status',accountId:'alice'})).state,'disabled');
 await assert.rejects(again.command({action:'start',accountId:'alice'}),/account_disabled/);
 assert.equal((await again.command({action:'enable',accountId:'alice'})).state,'running');const al3=await login(a);assert.equal((await web(a,'/api/note/'+saved.body.note.id,{cookie:al3.cookie})).body.note.body,'retained');
 assert.equal((await web(a,'/api/notes',{cookie:al2.cookie})).status,401);
});

test('fleet: absent account key does not prevent the other account; restoring the same key permits explicit restart',async t=>{
 const f=await fixture(t,{missingKeyBob:true}),fleet=await f.start();const[a,b]=f.accounts;await running(fleet,'alice');
 const state=await until(()=>fleet.command({action:'status',accountId:'bob'}),s=>s.state==='failed');assert.equal(state.state,'failed');
 assert.equal((await login(a)).status,200);await assert.rejects(login(b));
 write(b.config.core.databaseKeyFile,b.tokens.db);assert.equal((await fleet.command({action:'restart',accountId:'bob'})).state,'running');
});

test('fleet: read-only account has no clipping route or write tools; unavailable semantic store stays account-bound',async t=>{
 const f=await fixture(t,{readOnlyBob:true,semantic:true}),fleet=await f.start();const[a,b]=f.accounts;await Promise.all([running(fleet,'alice'),running(fleet,'bob')]);
	const bl=await login(b);const c=await mcp(t,b);assert.equal((await c.request('tools/list')).tools.length,15);
 const r=await web(b,'/api/write',{cookie:bl.cookie,body:{kind:'create',operationId:'e'.repeat(32),notebookId:folderId,title:'no',body:'no'}});assert.equal(r.status,403);
 const al=await login(a);const search=await web(a,'/api/search',{cookie:al.cookie,body:{query:'alice',mode:'hybrid'}});assert.equal(search.body.executedMode,'keyword');assert.equal(search.body.semantic.state,'unavailable');assert.ok(search.body.items.every(n=>n.accountId==='alice'));
 const unavailable=await web(b,'/api/search',{cookie:bl.cookie,body:{query:'alice',mode:'semantic'}});assert.equal(unavailable.body.executedMode,null);assert.equal(unavailable.body.accountId,'bob');
 await c.close();
});

test('fleet: lost worker is isolated; residual core is killed and explicit restart recovers',async t=>{
 const f=await fixture(t),fleet=await f.start();const[a,b]=f.accounts;const as=await running(fleet,'alice'),bs=await running(fleet,'bob');const bl=await login(b);
 process.kill(as.workerPid,'SIGKILL');await until(()=>fleet.command({action:'status',accountId:'alice'}),s=>s.state==='failed');
 await until(async()=>{try{process.kill(as.corePid,0);return true;}catch{return false;}},v=>!v);
 assert.equal((await web(b,'/api/status',{cookie:bl.cookie})).status,200);assert.equal((await fleet.command({action:'status',accountId:'bob'})).corePid,bs.corePid);
 // SIGKILL leaves the Unix socket on disk. Explicit stopped-state operator cleanup is required.
 if(fs.existsSync(a.config.mcp.socketPath))fs.unlinkSync(a.config.mcp.socketPath);
 assert.equal((await fleet.command({action:'restart',accountId:'alice'})).state,'running');
});

test('fleet: configuration collisions, aliases and reused credentials fail closed',async t=>{
 const f=await fixture(t);const[a,b]=f.accounts;const original=structuredClone(b.config);
 for(const mutate of[c=>c.core.profilePath=a.config.core.profilePath,c=>c.core.profilePath=path.join(a.profile,'nested'),c=>c.web.port=a.config.web.port,c=>c.web.publicOrigin=a.config.web.publicOrigin,c=>c.web.namespace=a.config.web.namespace,c=>c.core.databaseKeyFile=a.config.core.databaseKeyFile,c=>c.id='alice']){
  const c=structuredClone(original);mutate(c);write(b.file,c);assert.throws(()=>loadFleetConfig(f.fleetFile));
 }
 write(b.file,original);const link=path.join(b.base,'alias');fs.symlinkSync(a.profile,link);write(b.file,{...original,core:{...original.core,profilePath:link}});assert.throws(()=>loadFleetConfig(f.fleetFile),/overlapping_account_storage/);
 write(b.file,original);let conf=loadFleetConfig(f.fleetFile);write(b.config.web.webTokenFile,a.tokens.web);assert.throws(()=>checkSecrets(conf.accounts[0],conf.accounts),/reused_account_secret/);
 write(b.config.web.webTokenFile,b.tokens.web);write(b.config.core.databaseKeyFile,a.tokens.db);assert.throws(()=>checkSecrets(conf.accounts[1],conf.accounts),/reused_account_secret/);
});

test('fleet: private config and secret permissions are enforced, including symlinked secrets',async t=>{
 const f=await fixture(t);const[a]=f.accounts;fs.chmodSync(a.file,0o644);assert.throws(()=>loadFleetConfig(f.fleetFile),/private_file_required/);fs.chmodSync(a.file,0o600);
 const c=loadFleetConfig(f.fleetFile);fs.chmodSync(a.config.web.webTokenFile,0o644);assert.throws(()=>checkSecrets(c.accounts[0],c.accounts),/private_file_required/);fs.chmodSync(a.config.web.webTokenFile,0o600);
 const file=a.config.web.webTokenFile;fs.renameSync(file,file+'.original');fs.symlinkSync(file+'.original',file);assert.throws(()=>checkSecrets(c.accounts[0],c.accounts));
});

test('fleet: duplicate owner is rejected; operator socket is private and rejects unknown actions/accounts',async t=>{
 const f=await fixture(t),fleet=await f.start();await running(fleet,'alice');
 await assert.rejects(f.start());const socketFile=path.join(f.dir,'runtime','control.sock');assert.equal(fs.statSync(socketFile).mode&0o777,0o600);
 const s=await connectPrivateSocket(socketFile);const response=firstLine(s);s.write('{"action":"delete","accountId":"alice"}\n');assert.equal((await response).ok,false);s.destroy();
 await assert.rejects(fleet.command({action:'disable',accountId:'nobody'}),/account_not_available/);assert.equal((await fleet.command({action:'status',accountId:'alice'})).state,'running');
});

test('fleet: core setup wrapper refuses enable/default profile and forwards only explicit setup commands',async t=>{
 const f=await fixture(t),[a]=f.accounts;const entry=fileURLToPath(new URL('../account-core.mjs',import.meta.url));
 for(const [args,code] of[[[a.file,'enable'],1],[[a.file],1],[[a.file,'status'],0]]){
  const c=spawn(process.execPath,[entry,...args],{stdio:['ignore','pipe','pipe']});let out='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>out+=d);const [actual]=await once(c,'exit');assert.equal(actual,code);assert.ok(!out.includes(a.tokens.db));
 }
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.profile,'invocation.json'))),['e2ee','status']);
});

test('fleet: disable cancels a pending startup promptly and persists before any interface becomes ready',async t=>{
 const f=await fixture(t),[a,b]=f.accounts;const p=path.join(a.profile,'fixture.json');const fc=JSON.parse(fs.readFileSync(p));fc.delayReadyMs=10000;write(p,fc);
 const fleet=await f.start();await until(()=>fleet.command({action:'status',accountId:'alice'}),s=>s.workerPid&&s.state==='starting');
 const begin=Date.now();const disabled=await fleet.command({action:'disable',accountId:'alice'});assert.equal(disabled.state,'disabled');assert.ok(Date.now()-begin<2000);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'state','access.json'))).disabled.alice,true);
 await running(fleet,'bob');assert.equal((await login(b)).status,200);await assert.rejects(login(a));
});

test('fleet: a core crash restarts only that account within the configured bounded retry policy',async t=>{
 const f=await fixture(t);const cf=JSON.parse(fs.readFileSync(f.fleetFile));cf.restartLimit=1;write(f.fleetFile,cf);
 const fleet=await f.start();const a=await running(fleet,'alice'),b=await running(fleet,'bob');
 process.kill(a.corePid,'SIGKILL');const next=await until(()=>fleet.command({action:'status',accountId:'alice'}),s=>s.state==='running'&&s.corePid!==a.corePid);
 assert.equal(next.restarts,1);assert.equal((await fleet.command({action:'status',accountId:'bob'})).corePid,b.corePid);
});

test('fleet: per-account credential rotation invalidates old login and sessions without touching the other account',async t=>{
 const f=await fixture(t),fleet=await f.start();const[a,b]=f.accounts;await running(fleet,'alice');const before=await running(fleet,'bob');
 const al=await login(a),bl=await login(b),newToken='Z'.repeat(64);write(a.config.web.webTokenFile,newToken);
 assert.equal((await fleet.command({action:'restart',accountId:'alice'})).state,'running');assert.equal((await login(a)).status,401);assert.equal((await login(a,newToken)).status,200);
 assert.equal((await web(a,'/api/notes',{cookie:al.cookie})).status,401);assert.equal((await web(b,'/api/notes',{cookie:bl.cookie})).status,200);assert.equal((await fleet.command({action:'status',accountId:'bob'})).corePid,before.corePid);
});

test('fleet: changed account mapping is not silently loaded on an individual restart',async t=>{
 const f=await fixture(t),fleet=await f.start();const[a]=f.accounts;await running(fleet,'alice');await running(fleet,'bob');
 const modified=structuredClone(a.config);modified.web.namespace='f'.repeat(32);write(a.file,modified);
 const result=await fleet.command({action:'restart',accountId:'alice'});assert.equal(result.state,'failed');assert.equal(result.reason,'fleet_configuration_changed_restart_required');await assert.rejects(login(a));
 write(a.file,a.config);assert.equal((await fleet.command({action:'restart',accountId:'alice'})).state,'running');
});

test('fleet: separate executable supervisor and operator client shut down workers on parent disconnect',async t=>{
 const f=await fixture(t);const entry=fileURLToPath(new URL('../fleet.mjs',import.meta.url));const ctl=fileURLToPath(new URL('../fleetctl.mjs',import.meta.url));
 const child=spawn(process.execPath,[entry,f.fleetFile],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}});
 const sock=path.join(f.dir,'runtime','control.sock');
 const status=async()=>{try{const s=await connectPrivateSocket(sock);const promise=firstLine(s);s.write('{"action":"status"}\n');const r=await promise;s.destroy();return r;}catch{return {};}};
 const ready=await until(status,r=>r.accounts?.every(a=>a.state==='running'));
 const check=spawn(process.execPath,[ctl,sock,'status','alice'],{stdio:['ignore','pipe','pipe']});let text='';check.stdout.on('data',d=>text+=d);check.stderr.resume();assert.equal((await once(check,'exit'))[0],0);assert.equal(JSON.parse(text).accountId,'alice');
 const done=once(child,'exit');child.kill('SIGKILL');await done;
 for(const a of ready.accounts){await until(async()=>{try{process.kill(a.corePid,0);return true;}catch{return false;}},v=>!v);}
 for(const a of f.accounts)for(const secret of Object.values(a.tokens))assert.ok(!output.includes(secret));
 // SIGKILL of the supervisor intentionally leaves its lock/control socket for operator recovery.
});
