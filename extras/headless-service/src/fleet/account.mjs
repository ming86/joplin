import { loadMcpConfig } from '../mcp/config.mjs';
import { openMcpRuntime } from '../semantic/runtime.mjs';
import { createJoplinClient } from '../joplin.mjs';
import { createWebService } from '../web/service.mjs';
import { createMarkdownRenderer } from '../web/render.mjs';
import { startWebServer } from '../web/http.mjs';
import { createClipService } from '../clipper/service.mjs';
import { startClipServer } from '../clipper/http.mjs';
import { startMcpSocket } from './socket.mjs';
import { privateText } from './files.mjs';
import { launchCore, requireUnusedPort, waitForCore } from './process.mjs';
import { ServiceError } from '../errors.mjs';

export async function startAccount(definition, { signal, onCoreExit = () => {} } = {}) {
	const d = definition, components = []; let core, runtime, closing = false, closePromise;
	const startup = new AbortController();
	const cancelled = signal ? AbortSignal.any([signal, startup.signal]) : startup.signal;
	function close() {
		if (closePromise) return closePromise; closing = true; startup.abort();
		closePromise = (async () => {
			const results = await Promise.allSettled(components.map(c => c.close()));
			try { await runtime?.close(); } finally { await core?.close(); }
			if (results.some(r => r.status === 'rejected')) throw new ServiceError('account_shutdown_failed');
		})(); return closePromise;
	}
	try {
		for (const p of d.ports) await requireUnusedPort(p);
		const loaded = loadMcpConfig(d.accountConfigFile);
		core = launchCore(d.core);
		core.done.then(() => { if (!closing) onCoreExit(); });
		await waitForCore(core, loaded.service, d.startupTimeoutMs ?? 120000, cancelled);
		if (cancelled.aborted) throw new ServiceError('account_start_cancelled');
		runtime = await openMcpRuntime(d.accountConfigFile);
		if (cancelled.aborted || core.exited) throw new ServiceError('account_start_cancelled');
		const { service, allowWrites, allowAttachmentWrites } = runtime;
		if (d.web) components.push(await startWebServer({ ...d.web, cookieScope: d.id,
			token: privateText(d.web.webTokenFile, 4096).trim(),
			service: createWebService({ account: service, namespace: d.web.namespace, allowWrites, render: createMarkdownRenderer(d.web.markdownModule) }),
		}));
		if (d.clipper) components.push(await startClipServer({ ...d.clipper,
			token: privateText(d.clipper.clipTokenFile, 4096).trim(),
			service: createClipService({ accountId: d.id, namespace: d.clipper.namespace, notebookIds: d.clipper.notebookIds, backend: createJoplinClient(loaded.accountConfig.joplin) }),
		}));
		if (d.mcp) components.push(await startMcpSocket({ ...d.mcp, token: privateText(d.mcp.tokenFile, 4096).trim(), service, allowWrites, allowAttachmentWrites }));
		if (cancelled.aborted || core.exited) throw new ServiceError('account_start_cancelled');
		return { corePid: core.child.pid, close };
	} catch (error) { await close(); throw error; }
}
