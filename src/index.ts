import { createMcpHandler, McpServer, type McpRequestContext } from '@modelcontextprotocol/server';
import { catalog } from './catalog.js';
import { registerTools, type ToolProfile } from './tools.js';
import type { UazapiCredentials } from './uazapi.js';

interface Env {
  /** Comma-separated host suffixes the server may call, besides *.uazapi.com. */
  EXTRA_ALLOWED_HOSTS?: string;
}

const VERSION = '0.1.0';
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const INSTRUCTIONS = `Opera o WhatsApp de uma única instância Uazapi.
- Tools diretas: whatsapp_status, whatsapp_connect, send_text, send_media, find_chats, get_messages, get_chat_details, check_whatsapp_numbers, download_media, mark_chat_read.
- Para todo o resto (grupos, canais, enquetes, botões, reações, editar/apagar, etiquetas, CRM, respostas rápidas, catálogo, envio em massa), use search_operations → describe_operation → call_operation.
- Números vão em formato internacional só com dígitos (5511999999999). Grupos terminam em @g.us.
- Não repita um envio que falhou por timeout sem antes conferir com get_messages: ele pode ter sido entregue.`;

function allowedHost(host: string, env: Env) {
  const suffixes = ['.uazapi.com', ...(env.EXTRA_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
  return suffixes.some((s) => host === s.replace(/^\./, '') || host.endsWith(s.startsWith('.') ? s : `.${s}`));
}

function resolveBaseUrl(server: string | null, env: Env): string | undefined {
  if (!server) return undefined;
  const url = SUBDOMAIN.test(server) ? new URL(`https://${server}.uazapi.com`) : URL.canParse(server) ? new URL(server) : null;
  if (!url || url.protocol !== 'https:' || !allowedHost(url.hostname, env)) return undefined;
  return url.origin;
}

function resolveCredentials(request: Request, env: Env): UazapiCredentials | undefined {
  const h = request.headers;
  const bearer = h.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = (h.get('token') ?? h.get('x-uazapi-token') ?? bearer)?.trim();
  const pathServer = new URL(request.url).pathname.match(/^\/([^/]+)\/mcp\/?$/)?.[1] ?? null;
  const baseUrl = resolveBaseUrl(h.get('x-uazapi-server') ?? pathServer, env);
  return token && baseUrl ? { token, baseUrl } : undefined;
}

function buildServer(ctx: McpRequestContext, env: Env) {
  const request = ctx.requestInfo;
  const profile: ToolProfile = request && new URL(request.url).searchParams.get('tools') === 'all' ? 'all' : 'core';
  const server = new McpServer(
    { name: 'uazapi-mcp', title: 'Uazapi WhatsApp', version: VERSION },
    {
      instructions: INSTRUCTIONS,
      cacheHints: { 'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' } },
    },
  );
  registerTools(server, request ? resolveCredentials(request, env) : undefined, profile);
  return server;
}

let mcp: ReturnType<typeof createMcpHandler> | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/' || pathname === '/health') {
      return Response.json({
        name: 'uazapi-mcp',
        version: VERSION,
        uazapiApi: catalog.apiVersion,
        operations: catalog.operations.length,
        mcp: 'POST /<subdominio>/mcp ou /mcp com header x-uazapi-server',
      });
    }
    if (pathname === '/mcp' || /^\/[^/]+\/mcp\/?$/.test(pathname)) {
      const pathServer = pathname.match(/^\/([^/]+)\/mcp\/?$/)?.[1];
      if (pathServer && !resolveBaseUrl(pathServer, env)) {
        return Response.json({ error: 'Servidor Uazapi inválido no caminho' }, { status: 400 });
      }
      mcp ??= createMcpHandler((ctx) => buildServer(ctx, env), { responseMode: 'json' });
      return mcp.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
};
