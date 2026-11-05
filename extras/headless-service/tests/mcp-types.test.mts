import { createMcpSession } from '../mcp.mjs';
import type { AccountService } from '../index.mjs';
declare const service: AccountService;
const session = createMcpSession(service, { allowWrites: false, maxConcurrent: 4 });
void session.handle({ jsonrpc: '2.0', id: 1, method: 'ping' });
session.close();
createMcpSession(service, { allowWrites: true, allowAttachmentWrites: false });
// @ts-expect-error Explicit boolean only.
createMcpSession(service, { allowWrites: 'yes' });
// @ts-expect-error Explicit boolean only.
createMcpSession(service, { allowAttachmentWrites: 'no' });
