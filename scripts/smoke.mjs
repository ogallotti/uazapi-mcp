// Smoke test against a running server, with a 2026-07-28 client and a 2025-era client.
// Usage: MCP_URL=http://localhost:8787/<subdominio>/mcp [SMOKE_UAZAPI_TOKEN=...] node scripts/smoke.mjs
// With SMOKE_UAZAPI_TOKEN set it also runs read-only calls against that real instance.
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.env.MCP_URL ?? 'http://localhost:8787/free/mcp';
const token = process.env.SMOKE_UAZAPI_TOKEN;
let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const text = (r) => r.content?.find((c) => c.type === 'text')?.text ?? '';

async function run(name, Client, Transport, url, headers) {
  const options = Client === ModernClient ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {};
  const client = new Client({ name: `smoke-${name}`, version: '0' }, options);
  const transport = new Transport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  return { client, version: client.getNegotiatedProtocolVersion?.() ?? transport.protocolVersion ?? '?' };
}

for (const [era, Client, Transport] of [
  ['modern', ModernClient, ModernTransport],
  ['legacy', LegacyClient, LegacyTransport],
]) {
  const { client, version } = await run(era, Client, Transport, base, {});
  console.log(`\n[${era}] protocol ${version}`);
  if (era === 'modern') check('modern: negotiated 2026-07-28', version === '2026-07-28', version);
  const { tools } = await client.listTools();
  check(`${era}: core tools listed`, tools.length === 13, `${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

  const cats = await client.callTool({ name: 'search_operations', arguments: {} });
  check(`${era}: categories`, text(cats).includes('Grupos e Comunidades'));

  const poll = await client.callTool({ name: 'search_operations', arguments: { query: 'enquete' } });
  check(`${era}: search "enquete" finds sendMenu`, text(poll).includes('sendMenu'));

  const desc = await client.callTool({ name: 'describe_operation', arguments: { operation: 'updateGroupParticipants' } });
  check(`${era}: describe_operation`, text(desc).includes('"arguments"'));

  const noCreds = await client.callTool({ name: 'whatsapp_status', arguments: {} });
  check(`${era}: missing credentials is a tool error`, noCreds.isError === true && text(noCreds).includes('credenciais'));
  await client.close();
}

const raw = await fetch(base, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-method': 'tools/list', 'mcp-protocol-version': '2026-07-28' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'smoke-raw', version: '0' },
      },
    },
  }),
}).then((r) => r.json());
check('raw 2026-07-28 tools/list is cacheable', raw.result?.ttlMs === 3_600_000 && raw.result?.cacheScope === 'public', JSON.stringify({ ttlMs: raw.result?.ttlMs, cacheScope: raw.result?.cacheScope, resultType: raw.result?.resultType, error: raw.error }));

const fake = await run('fake-token', ModernClient, ModernTransport, base, { authorization: 'Bearer fake' });
const dots = await fake.client.callTool({ name: 'call_operation', arguments: { operation: 'deleteQuickReply', arguments: { id: '..' } } });
check('path traversal in path params is rejected', dots.isError === true && text(dots).includes('Valor inválido'), text(dots));
await fake.client.close();

const all = await run('all', ModernClient, ModernTransport, `${base}?tools=all`, {});
const allTools = (await all.client.listTools()).tools;
check('tools=all lists every operation', allTools.length > 130, `${allTools.length} tools`);
await all.client.close();

if (token) {
  for (const [era, Client, Transport, headers] of [
    ['modern', ModernClient, ModernTransport, { token }],
    ['legacy', LegacyClient, LegacyTransport, { authorization: `Bearer ${token}` }],
  ]) {
    const { client } = await run(era, Client, Transport, base, headers);
    const status = await client.callTool({ name: 'whatsapp_status', arguments: {} });
    check(`${era}: whatsapp_status (real)`, !status.isError, text(status).slice(0, 200));
    const chats = await client.callTool({ name: 'find_chats', arguments: { limit: 3 } });
    check(`${era}: find_chats (real)`, !chats.isError, `${chats.structuredContent?.chats?.length ?? 0} chats`);
    const labels = await client.callTool({ name: 'call_operation', arguments: { operation: 'listLabels' } });
    check(`${era}: call_operation listLabels (real)`, !labels.isError, text(labels).slice(0, 120));
    await client.close();
  }
}

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
