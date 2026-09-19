import { createMcpSession } from '../mcp.mjs';
import type { AccountService } from '../index.mjs';
declare const service: AccountService;
const session = createMcpSession(service, { allowWrites: false, maxConcurrent: 4 });
void session.handle({ jsonrpc: '2.0', id: 1, method: 'ping' });
session.close();
// @ts-expect-error Explicit boolean only.
createMcpSession(service, { allowWrites: 'yes' });
