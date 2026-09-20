import { createRequire } from 'node:module';
import path from 'node:path';
import { requireValue, ServiceError } from '../errors.mjs';
import { MAX_BODY_BYTES } from './service.mjs';
const rendererRequire = createRequire(new URL('../../../../packages/renderer/package.json', import.meta.url));
const localRequire = createRequire(import.meta.url);
export const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Reuse the renderer workspace's existing pinned markdown-it, without taking a
// dependency on Joplin desktop state or writing another Markdown parser.
export function createMarkdownRenderer(modulePath) {
	if (modulePath !== undefined) requireValue(path.isAbsolute(modulePath), 'absolute_markdown_module_required');
	let MarkdownIt;
	try { MarkdownIt = modulePath ? localRequire(modulePath) : rendererRequire('markdown-it'); }
	catch { throw new ServiceError('web_markdown_dependency_unavailable'); }
	const md = new MarkdownIt({ html: false, linkify: false, typographer: false, maxNesting: 32 });
	md.renderer.rules.image = (tokens, i) => `<span class="omitted">[Image: ${escapeHtml(tokens[i].content || 'attachment')} — not loaded]</span>`;
	// Preview is inert: URLs remain in the source, never trigger resource loads or navigation.
	md.renderer.rules.link_open = (tokens, i) => `<span class="link" title="${escapeHtml(tokens[i].attrGet('href') ?? '')}">`;
	md.renderer.rules.link_close = () => '</span>';
	return (body, language = 1) => {
		if (Buffer.byteLength(body) > MAX_BODY_BYTES) return '<p>Preview is disabled for this large note. The full source remains available read-only.</p>';
		return language === 1 ? md.render(body) : `<p>Unsupported format: source shown read-only.</p><pre>${escapeHtml(body)}</pre>`;
	};
}
