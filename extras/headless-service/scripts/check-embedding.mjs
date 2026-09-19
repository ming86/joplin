#!/usr/bin/env node
// Contacts ONLY the configured embedding endpoint with the fixed public text
// below. Does not read Joplin notes, open an index, or download model weights.
import { readFile } from '../src/mcp/config.mjs';
import { bindEmbeddingProvider } from '../index.mjs';
import { createEmbeddingTransport } from '../src/semantic/http.mjs';
import { ServiceError, requireValue } from '../src/errors.mjs';
try {
	if (process.argv.length !== 3) throw new ServiceError('usage_node_check_embedding_mjs_absolute_mcp_config');
	const input = JSON.parse(readFile(process.argv[2], 65536, false));
	const config = input.semantic?.embedding; requireValue(config?.protocol === 'openai-embeddings', 'embedding_configuration_required');
	const apiKey = config.apiKeyFile ? readFile(config.apiKeyFile, 8192, true).trim() : undefined;
	const provider = bindEmbeddingProvider(config.space, createEmbeddingTransport({ ...config, apiKey }));
	const documents = [
		'PostgreSQL streaming replication copies database changes to a standby server for failover.',
		'Drinking coffee late in the evening can make falling asleep difficult because of caffeine.',
		'Bicycle disc brakes may squeal when their pads or rotor are contaminated with oil.',
		'A sourdough starter is maintained by feeding flour and water to a culture of yeast and bacteria.',
	];
	const queries = ['database replica after primary failure', '咖啡为什么影响睡眠', 'brek basikal berbunyi', 'feeding a bread starter'];
	const start = Date.now();
	// Single-text requests also support endpoints configured with maxBatch=1.
	const docResults = []; for (const text of documents) docResults.push(await provider.embed([text], 'document'));
	const queryResults = []; for (const text of queries) queryResults.push(await provider.embed([text], 'query'));
	const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
	const ranks = queryResults.map((result, i) => docResults.map((doc, j) => ({ j, score: cosine(result.vectors[0], doc.vectors[0]) })).sort((a,b) => b.score-a.score).findIndex(item => item.j===i)+1);
	console.log(JSON.stringify({ model: config.model, embeddingSpaceId: provider.space.id, dimensions: provider.space.dimensions, elapsedMs: Date.now()-start,
		requests: documents.length+queries.length, reportedInputTokens: [...docResults,...queryResults].reduce((s,r)=>s+(r.inputTokens??0),0),
		syntheticExpectedRanks: ranks, syntheticTop1Hits: ranks.filter(n=>n===1).length,
		scope: 'HTTP shape and fixed synthetic ranking only; not corpus relevance or truncation certification' }));
	console.log('PASS embedding-http-shape');
} catch (error) { console.error(error instanceof ServiceError ? error.code : 'embedding_probe_failed'); process.exitCode=1; }
