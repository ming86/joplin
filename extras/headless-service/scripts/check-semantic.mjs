#!/usr/bin/env node
// Starts an MCP semantic owner: eligible notes WILL be indexed using the
// configured endpoint. Use a disposable account or explicitly approved corpus.
// No note mutations. The chosen model and corpus are operational inputs.
import { readFile } from '../src/mcp/config.mjs';
import { ServiceError, requireValue, identifier } from '../src/errors.mjs';
import { StdioTestClient } from './lib/stdio-client.mjs';
import { openMcpRuntime } from '../src/semantic/runtime.mjs';
import { prepareSemanticCheck } from './lib/prepare-semantic-check.mjs';
let client; let preparation;
try {
	if (process.argv.length!==4) throw new ServiceError('usage_node_check_semantic_mjs_mcp_config_relevance_cases');
	const cases = JSON.parse(readFile(process.argv[3],65536,false));
	requireValue(Array.isArray(cases.cases) && cases.cases.length>0 && cases.cases.length<=100, 'invalid_relevance_cases');
	for (const c of cases.cases) {
		requireValue(typeof c.query==='string' && c.query.length>0 && c.query.length<=10000 && Array.isArray(c.expectedNoteIds) && c.expectedNoteIds.length>0, 'invalid_relevance_cases');
		c.expectedNoteIds.forEach(identifier);if(c.notebookId)identifier(c.notebookId);
	}
	const waitMs=cases.waitMs??120000;requireValue(Number.isSafeInteger(waitMs)&&waitMs>0&&waitMs<=3600000,'invalid_wait_limit');
	preparation = await openMcpRuntime(process.argv[2], { background: false });
	const state = await prepareSemanticCheck(preparation, waitMs);
	await preparation.close(); preparation = undefined;
	client=new StdioTestClient(process.argv[2],undefined,{timeoutMs:120000});await client.initialize();
	const results=[];
	for(const [i,c] of cases.cases.entries()) {
		const start=Date.now();const r=await client.call('search_notes',{query:c.query,mode:'semantic',limit:10,...(c.notebookId?{notebookId:c.notebookId}:{})});
		requireValue(!r.isError && r.structuredContent.executedMode==='semantic','semantic_search_failed');
		const rank=r.structuredContent.items.findIndex(n=>c.expectedNoteIds.includes(n.id))+1;
		results.push({case:i+1,rank:rank||null,latencyMs:Date.now()-start});
	}
	console.log(JSON.stringify({embeddingSpaceId:state.embeddingSpaceId,indexedNotes:state.indexedNotes,usage:state.usage,results,top10Hits:results.filter(r=>r.rank).length,total:results.length}));
	requireValue(results.every(r=>r.rank),'relevance_case_missing_from_top10');
	await client.close();requireValue(client.child.exitCode===0,'mcp_shutdown_failed');
	console.log('PASS semantic-retrieval-check');
} catch(error) { console.error(error instanceof ServiceError?error.code:'semantic_check_failed');process.exitCode=1; }
finally {await client?.close(); await preparation?.close();}
