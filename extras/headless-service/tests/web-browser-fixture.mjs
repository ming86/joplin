// Synthetic browser harness only. No private profiles or live Joplin server.
import http from 'node:http';
import { once } from 'node:events';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { createAccountRegistry } from '../index.mjs';
import { createWebService } from '../src/web/service.mjs';
import { createMarkdownRenderer } from '../src/web/render.mjs';
import { startWebServer } from '../src/web/http.mjs';
import { note, folderId } from './fixtures.mjs';
const apiToken = randomBytes(32).toString('hex'), token = randomBytes(32).toString('hex');
const records = new Map([
	[note.id, { ...note, title: 'Welcome to your web notebook', body: '# A note, without a full download\n\nChinese: 中文笔记. Malay: catatan peribadi.\n\n**Bold text**, `code`, and a [reference](https://example.test).\n\n|Feature|Status|\n|-|-|\n|Keyword search|Available|\n|Markdown editing|Available|\n\n![external](https://outside.example.test/tracking.png)\n\n<script>window.__noteScriptRan=true</script>' }],
	['c'.repeat(32), { ...note, id: 'c'.repeat(32), title: 'HTML source example', markup_language: 2, body: '<h1>HTML note</h1><img src="https://outside.example.test/html.png" onerror="alert(1)">' }],
	['d'.repeat(32), { ...note, id: 'd'.repeat(32), title: 'CRLF round trip', body: '# Original\r\n\r\nUnchanged CRLF body.\r\n' }],
]);
for (let i=0;i<35;i++) { const id='e'.repeat(28)+i.toString(16).padStart(4,'0');records.set(id,{...note,id,title:`Notebook item ${i+1}`,body:'Synthetic pagination fixture.'}); }
const calls=[];
const backend=http.createServer(async(req,res)=>{
	try {
		const u=new URL(req.url,'http://localhost'); if(u.searchParams.get('token')!==apiToken){res.writeHead(403);res.end('{}');return;}
		let body;
		if(req.method!=='GET'){const parts=[];for await(const b of req)parts.push(b);body=JSON.parse(Buffer.concat(parts));}
		calls.push({route:u.pathname,method:req.method,fields:u.searchParams.get('fields'),body});
		function selected(n){const fields=u.searchParams.get('fields');return fields?Object.fromEntries(fields.split(',').filter(k=>Object.hasOwn(n,k)).map(k=>[k,n[k]])):n;}
		function page(items){const limit=Number(u.searchParams.get('limit')??30),p=Number(u.searchParams.get('page')??1);return {items:items.slice((p-1)*limit,p*limit).map(selected),has_more:p*limit<items.length};}
		let result;
		if(u.pathname==='/folders')result={items:[{id:folderId,title:'Personal notebook',parent_id:''}],has_more:false};
		else if(u.pathname===`/folders/${folderId}`)result={id:folderId,title:'Personal notebook',deleted_time:0};
		else if(req.method==='GET'&&(u.pathname==='/notes'||u.pathname===`/folders/${folderId}/notes`))result=page([...records.values()].sort((a,b)=>a.id.localeCompare(b.id)));
		else if(u.pathname==='/services/headless'&&body.action==='searchNotes'){
			const matches=[...records.values()].filter(n=>(n.title+' '+n.body).toLowerCase().includes(body.query.toLowerCase()));
			const limit=body.limit??20,p=body.page??1;result={items:matches.slice((p-1)*limit,p*limit),total:matches.length,hasMore:p*limit<matches.length};
		}
		else if(u.pathname==='/notes'&&req.method==='POST'){
			if(body.body!=='')throw new Error('User content must not be POSTed to the native creation route');
			if(records.has(body.id)){res.writeHead(409);res.end('{}');return;}
			result={...note,...body,updated_time:Date.now()};records.set(result.id,result);
		}else if(/^\/notes\/[a-f0-9]{32}$/.test(u.pathname)){
			const n=records.get(u.pathname.split('/').pop());if(!n){res.writeHead(404);res.end('{}');return;}
			if(req.method==='PUT'){Object.assign(n,body);n.updated_time++;}result=selected(n);
		}else{res.writeHead(404);res.end('{}');return;}
		res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
	}catch{res.writeHead(500);res.end('{}');}
});
backend.listen(0,'127.0.0.1');await once(backend,'listening');
const accountId='browser-fixture';
const registry=createAccountRegistry([{id:accountId,subjects:['test'],permissions:['read','write'],joplin:{baseUrl:`http://127.0.0.1:${backend.address().port}`,token:apiToken},semantic:{databasePath:'/tmp/web-browser-fixture/unused.db',keyRef:'unused'}}]);
const service=createWebService({account:registry.forPrincipal('test',accountId),allowWrites:true,namespace:'f'.repeat(32),render:createMarkdownRenderer(process.env.JOPLIN_WEB_MARKDOWN_MODULE)});
const web=await startWebServer({service,token});
console.log(JSON.stringify({ready:true,url:web.baseUrl,token}));
const rl=readline.createInterface({input:process.stdin});
async function close(){rl.close();await web.close();backend.closeAllConnections();await new Promise(r=>backend.close(r));}
rl.on('line',async line=>{
	try {
		const command=JSON.parse(line);
		if(command.type==='edit'){const n=records.get(command.id);Object.assign(n,command.changes);n.updated_time++;console.log(JSON.stringify({ok:true}));}
		else if(command.type==='record')console.log(JSON.stringify(records.get(command.id)??null));
		else if(command.type==='stats')console.log(JSON.stringify({notes:records.size,calls}));
		else if(command.type==='stop'){await close();process.exitCode=0;}
	}catch{console.log(JSON.stringify({error:'fixture_command_failed'}));}
});
process.once('SIGTERM',()=>void close());
