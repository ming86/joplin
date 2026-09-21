import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { loadFleetConfig } from '../../src/fleet/config.mjs';
import { startFleet } from '../../src/fleet/supervisor.mjs';
import { setTimeout as delay } from 'node:timers/promises';
export const fakeCore = fileURLToPath(new URL('./fake-core.mjs', import.meta.url));
export const folderId = 'b'.repeat(32), sharedId = 'a'.repeat(32);
export const write = (p, v) => fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v), { mode: 0o600 });
async function port() { const s=net.createServer(); s.listen(0,'127.0.0.1'); await once(s,'listening'); const p=s.address().port; await new Promise(r=>s.close(r)); return p; }
export async function fixture(t, { readOnlyBob = false, missingKeyBob = false, semantic = false } = {}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jf-')); const fleets=[]; t.after(async()=>{for(const f of fleets)await f.close();fs.rmSync(dir,{recursive:true,force:true});});
 const accounts=[];
 for (const [i,id] of ['alice','bob'].entries()) {
  const base=path.join(dir,id); fs.mkdirSync(base,{mode:0o700}); const profile=path.join(base,'profile');fs.mkdirSync(profile,{mode:0o700});
  const tokens=Object.fromEntries(['db','api','web','clip','mcp','semantic'].map(k=>[k,randomBytes(32).toString('hex')]));
  for (const [name,token] of Object.entries(tokens)) write(path.join(base,name+'.key'),token);
  const corePort=await port(), webPort=await port(), clipPort=await port();
  const uniqueId=String(i+1).repeat(32);
  write(path.join(profile,'fixture.json'),{id,port:corePort,token:tokens.api,keyHash:createHash('sha256').update(tokens.db).digest('hex'),uniqueId});
  const accountConfigFile=path.join(base,'backend.json');
  write(accountConfigFile,{accountId:id,baseUrl:`http://127.0.0.1:${corePort}/`,apiTokenFile:path.join(base,'api.key'),allowWrites:!(readOnlyBob&&id==='bob'),semanticDatabasePath:path.join(base,'semantic.db'),semanticKeyRef:id+'/semantic',...(semantic?{semantic:{enabled:true,keyFile:path.join(base,'semantic.key'),sqliteModule:'/no-such-module',embedding:{protocol:'openai-embeddings',baseUrl:'http://127.0.0.1:1/v1/',model:'test',remoteProcessing:false,space:{id:'test-v1',revision:'test',dimensions:2,preprocessingVersion:'test'}}}}:{})});
  const config={id,accountConfigFile,core:{cliPath:fakeCore,profilePath:profile,databaseKeyFile:path.join(base,'db.key'),sqliteModule:fakeCore},web:{webTokenFile:path.join(base,'web.key'),namespace:randomBytes(16).toString('hex'),port:webPort,publicOrigin:`http://127.0.0.1:${webPort}`,markdownModule:process.env.JOPLIN_WEB_MARKDOWN_MODULE},mcp:{socketPath:path.join(base,'ipc','mcp.sock'),tokenFile:path.join(base,'mcp.key')},startupTimeoutMs:3000};
  if (!(readOnlyBob&&id==='bob'))config.clipper={clipTokenFile:path.join(base,'clip.key'),namespace:randomBytes(16).toString('hex'),notebookIds:[folderId],port:clipPort};
  const file=path.join(base,'account.json');write(file,config);
  if(missingKeyBob&&id==='bob')fs.unlinkSync(config.core.databaseKeyFile);
  const connection=path.join(base,'connect.json');write(connection,{...config.mcp});
  accounts.push({id,config,file,tokens,base,profile,uniqueId,connection});
 }
 const fleetFile=path.join(dir,'fleet.json');write(fleetFile,{runtimeDir:path.join(dir,'runtime'),stateDir:path.join(dir,'state'),accounts:accounts.map(a=>a.file),restartLimit:0});
 return {dir,accounts,fleetFile,async start(){const f=await startFleet(loadFleetConfig(fleetFile));fleets.push(f);return f;}};
}
export async function until(get, predicate, timeout=12000) {const end=Date.now()+timeout;let value;while(Date.now()<end){value=await get();if(predicate(value))return value;await delay(50);}throw Error('Timeout: '+JSON.stringify(value));}
export async function running(fleet,id){return until(()=>fleet.command({action:'status',accountId:id}),v=>v.state==='running');}
export async function web(a,route,{cookie,token,body,method}={}) {
 const r=await fetch(a.config.web.publicOrigin+route,{method:method??(body===undefined?'GET':'POST'),headers:{Origin:a.config.web.publicOrigin,'X-Joplin-Web':'1','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
export const login=(a,token=a.tokens.web)=>web(a,'/api/login',{body:{token}});
export async function clip(a,token=a.tokens.clip,body){const r=await fetch(`http://127.0.0.1:${a.config.clipper.port}`+(body?'/v1/clips':'/v1/notebooks'),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json()};}
