import { createAccountRegistry, bindEmbeddingProvider, type AccountConfiguration } from '../index.mjs';
const configs: AccountConfiguration[] = [];
const registry = createAccountRegistry(configs);
const service = registry.forPrincipal('verified-subject', 'account');
void service.search({ query: 'test', mode: 'hybrid', limit: 10 });
// @ts-expect-error Unknown modes are not silently keyword search.
void service.search({ query: 'test', mode: 'vector-ish' });
// @ts-expect-error Backends cannot be selected through search input.
void service.search({ query: 'test', baseUrl: 'https://other.invalid' });
// @ts-expect-error Upload/import fields are deliberately not exposed.
void service.createNote({ title: 'test', body: 'content', parentId: 'notebook', image_data_url: 'x' });
const provider = bindEmbeddingProvider({ id: 'space', revision: 'rev', dimensions: 2, preprocessingVersion: 'v1' }, async () => ({ data: [{ index: 0, embedding: [1, 0] }] }));
void provider.embed(['example'], 'document');
// @ts-expect-error Model purposes are explicit.
void provider.embed(['example'], 'unknown');
void service.listNoteSummaries({ notebookId: 'notebook', page: 1, limit: 30 });
void service.listConflicts({ page: 1, limit: 20 });
void service.readConflict({ id: 'b'.repeat(32) });
// @ts-expect-error Conflict inspection accepts only page options.
void service.listConflicts({ page: 1, scope: 'all' });
// @ts-expect-error Conflict reads require a conflict note id.
void service.readConflict({});
void service.createWebPlaceholder({ id: 'note', parentId: 'notebook', receipt: 'receipt' });
// @ts-expect-error Web placeholder creation must never carry user Markdown to POST.
void service.createWebPlaceholder({ id: 'note', parentId: 'notebook', receipt: 'receipt', body: 'Markdown' });
// @ts-expect-error A caller cannot select an arbitrary Data API URL through web listing.
void service.listNoteSummaries({ baseUrl: 'https://other.invalid' });
