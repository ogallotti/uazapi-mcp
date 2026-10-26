import { fromJsonSchema, type McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { buildRequest, catalog, categories, getOperation, searchOperations, type Operation } from './catalog.js';
import { callUazapi, pick, prune, UazapiError, type UazapiCredentials } from './uazapi.js';

export type ToolProfile = 'core' | 'all';

const MAX_TEXT = 60_000;

const chatId = z
  .string()
  .describe(
    'Destino: número em formato internacional só com dígitos (5511999999999), ID de grupo (...@g.us), usuário (...@s.whatsapp.net ou ...@lid) ou canal (...@newsletter).',
  );

const MESSAGE_FIELDS = [
  'id',
  'messageid',
  'chatid',
  'fromMe',
  'sender',
  'senderName',
  'isGroup',
  'messageType',
  'status',
  'text',
  'quoted',
  'reaction',
  'edited',
  'fileURL',
  'wasSentByApi',
] as const;

const CHAT_FIELDS = [
  'wa_chatid',
  'phone',
  'wa_isGroup',
  'wa_unreadCount',
  'wa_lastMessageType',
  'wa_lastMessageSender',
  'lead_awaitingReply',
  'wa_isPinned',
  'wa_archived',
  'wa_label',
  'lead_status',
  'lead_tags',
] as const;

const messageOut = z.looseObject({
  id: z.string().optional(),
  messageid: z.string().optional(),
  chatid: z.string().optional(),
  fromMe: z.boolean().optional(),
  senderName: z.string().optional(),
  messageType: z.string().optional(),
  text: z.string().optional(),
  time: z.string().optional(),
  fileURL: z.string().optional(),
});

const chatOut = z.looseObject({
  wa_chatid: z.string().optional(),
  name: z.string().optional(),
  wa_isGroup: z.boolean().optional(),
  wa_unreadCount: z.number().optional(),
  lastMessageAt: z.string().optional(),
});

const pagination = z.looseObject({ hasMore: z.boolean().optional(), nextOffset: z.number().optional() }).optional();

type Obj = Record<string, unknown>;

function toIso(ts: unknown): string | undefined {
  if (typeof ts !== 'number' || ts <= 0) return undefined;
  return new Date(ts > 1e12 ? ts : ts * 1000).toISOString();
}

function compactMessage(m: Obj) {
  return { ...pick(m, MESSAGE_FIELDS), time: toIso(m.messageTimestamp) };
}

function compactChat(c: Obj) {
  return {
    name: (c.wa_contactName || c.wa_name || c.name || c.lead_name) as string | undefined,
    ...pick(c, CHAT_FIELDS),
    lastMessageAt: toIso(c.wa_lastMsgTimestamp),
  };
}

function textResult(value: unknown, structured?: Obj): CallToolResult {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length > MAX_TEXT) {
    text = `${text.slice(0, MAX_TEXT)}\n…[resposta truncada em ${MAX_TEXT} caracteres; use limit/offset para paginar]`;
  }
  return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) };
}

function errorResult(err: unknown): CallToolResult {
  let text = err instanceof Error ? err.message : String(err);
  if (err instanceof UazapiError && err.status === 401) {
    text += '\nToken ou servidor inválido: confira o token da instância e a Server URL configurados na conexão MCP.';
  }
  if (err instanceof UazapiError && err.status === 429) {
    text += '\nLimite de 10 chamadas/s da instância atingido. Aguarde alguns segundos antes de repetir.';
  }
  return { content: [{ type: 'text', text }], isError: true };
}

function qrImage(qrcode: unknown) {
  if (typeof qrcode !== 'string') return [];
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(qrcode);
  return match ? [{ type: 'image' as const, data: match[2], mimeType: match[1] }] : [];
}

function snake(id: string) {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function annotationsFor(op: Operation) {
  return {
    title: op.summary,
    readOnlyHint: op.readOnly,
    destructiveHint: op.destructive,
    idempotentHint: op.readOnly,
    openWorldHint: true,
  };
}

function summarize(op: Operation) {
  return { operation: op.id, category: op.tag, summary: op.summary, readOnly: op.readOnly, destructive: op.destructive };
}

async function runOperation(creds: UazapiCredentials | undefined, op: Operation, args: Obj): Promise<CallToolResult> {
  if (!creds) return errorResult(new Error(MISSING_CREDS));
  try {
    const result = await callUazapi(creds, buildRequest(op, args));
    return textResult(prune(result));
  } catch (err) {
    return errorResult(err);
  }
}

export const MISSING_CREDS =
  'Conexão sem credenciais Uazapi. Configure o header `token` (ou `Authorization: Bearer <token>`) e a Server URL (caminho /<subdominio>/mcp ou header `x-uazapi-server`).';

export const CORE_OPERATIONS = new Set([
  'getInstanceStatus',
  'connectInstance',
  'sendText',
  'sendMedia',
  'findChats',
  'findMessages',
  'getChatDetails',
  'checkChat',
  'downloadMessage',
  'markChatRead',
]);

export function registerTools(server: McpServer, creds: UazapiCredentials | undefined, profile: ToolProfile) {
  const call = async (operationId: string, args: Obj) => {
    if (!creds) throw new Error(MISSING_CREDS);
    return (await callUazapi(creds, buildRequest(getOperation(operationId)!, args))) as Obj;
  };
  const guard =
    <A,>(fn: (args: A) => Promise<CallToolResult>) =>
    async (args: A) => {
      try {
        return await fn(args);
      } catch (err) {
        return errorResult(err);
      }
    };

  server.registerTool(
    'whatsapp_status',
    {
      title: 'Status da conexão do WhatsApp',
      description:
        'Mostra se o número desta instância está conectado ao WhatsApp, o nome do perfil e o motivo da última desconexão. Se a conexão estiver em andamento, devolve o QR code atual. Use antes de diagnosticar falhas de envio.',
      inputSchema: z.object({}),
      outputSchema: z.looseObject({ connected: z.boolean(), loggedIn: z.boolean(), status: z.string().optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async () => {
      const r = await call('getInstanceStatus', {});
      const inst = (r.instance ?? {}) as Obj;
      const st = (r.status ?? {}) as Obj;
      const out = {
        connected: Boolean(st.connected),
        loggedIn: Boolean(st.loggedIn),
        phone: (st.jid as Obj | null)?.user as string | undefined,
        ...pick(inst, ['status', 'name', 'profileName', 'isBusiness', 'paircode', 'lastDisconnect', 'lastDisconnectReason']),
      };
      const hint = out.connected ? '' : '\nInstância desconectada: use whatsapp_connect para gerar um QR code ou código de pareamento.';
      return {
        content: [{ type: 'text', text: JSON.stringify(out) + hint }, ...qrImage(inst.qrcode)],
        structuredContent: out,
      };
    }),
  );

  server.registerTool(
    'whatsapp_connect',
    {
      title: 'Reconectar o WhatsApp (QR code)',
      description:
        'Inicia a conexão da instância ao WhatsApp. Sem `phone`, devolve um QR code (imagem) para escanear em WhatsApp > Aparelhos conectados. Com `phone`, devolve um código de pareamento de 8 caracteres. O QR expira em cerca de 1 minuto: depois de escanear, confira com whatsapp_status.',
      inputSchema: z.object({
        phone: z
          .string()
          .regex(/^\d{10,15}$/)
          .optional()
          .describe('Número da conta em formato internacional, só dígitos, para gerar código de pareamento em vez de QR code.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async ({ phone }) => {
      const r = await call('connectInstance', phone ? { phone } : {});
      const inst = (r.instance ?? {}) as Obj;
      const paircode = typeof inst.paircode === 'string' && inst.paircode ? inst.paircode : undefined;
      const out = { connected: Boolean(r.connected), loggedIn: Boolean(r.loggedIn), status: inst.status, paircode };
      const image = qrImage(inst.qrcode);
      const hint = out.loggedIn
        ? 'A instância já está conectada.'
        : image.length
          ? 'Escaneie o QR code em WhatsApp > Aparelhos conectados > Conectar um aparelho.'
          : paircode
            ? `Digite o código ${paircode} em WhatsApp > Aparelhos conectados > Conectar com número de telefone.`
            : 'Conexão iniciada; chame whatsapp_status em alguns segundos para obter o QR code.';
      return { content: [{ type: 'text', text: `${JSON.stringify(out)}\n${hint}` }, ...image] };
    }),
  );

  server.registerTool(
    'send_text',
    {
      title: 'Enviar mensagem de texto',
      description:
        'Envia uma mensagem de texto para um contato, grupo ou canal. Aceita formatação do WhatsApp (*negrito*, _itálico_, ~riscado~). Para responder a uma mensagem específica, passe `replyid`.',
      inputSchema: z.object({
        number: chatId,
        text: z.string().min(1).describe('Texto da mensagem.'),
        replyid: z.string().optional().describe('ID da mensagem a responder (campo messageid de get_messages).'),
        mentions: z
          .string()
          .optional()
          .describe('Em grupos: números a mencionar separados por vírgula, ou "all" para mencionar todos.'),
        linkPreview: z.boolean().optional().describe('Gera preview do primeiro link do texto.'),
        delay: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Atraso em ms antes do envio; o contato vê "digitando…" durante esse tempo.'),
        readchat: z.boolean().optional().describe('Marca o chat como lido ao enviar.'),
      }),
      outputSchema: messageOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      const out = compactMessage(await call('sendText', args));
      return textResult(out, out);
    }),
  );

  server.registerTool(
    'send_media',
    {
      title: 'Enviar mídia',
      description:
        'Envia imagem, vídeo, áudio, mensagem de voz, documento ou figurinha a partir de uma URL pública (ou base64). Para áudio gravado na hora use `ptt`; para PDF e planilhas use `document` com `docName`.',
      inputSchema: z.object({
        number: chatId,
        type: z
          .enum(['image', 'video', 'videoplay', 'document', 'audio', 'myaudio', 'ptt', 'ptv', 'sticker'])
          .describe('Tipo da mídia. ptt = mensagem de voz; ptv = vídeo circular; videoplay = vídeo em loop.'),
        file: z.string().min(1).describe('URL pública do arquivo (preferível) ou conteúdo em base64.'),
        text: z.string().optional().describe('Legenda.'),
        docName: z.string().optional().describe('Nome do arquivo exibido, para documentos.'),
        replyid: z.string().optional().describe('ID da mensagem a responder.'),
        mentions: z.string().optional(),
        delay: z.number().int().min(0).optional(),
      }),
      outputSchema: messageOut,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async (args) => {
      const out = compactMessage(await call('sendMedia', args));
      return textResult(out, out);
    }),
  );

  server.registerTool(
    'find_chats',
    {
      title: 'Buscar conversas',
      description:
        'Lista conversas da instância, das mais recentes para as mais antigas, com filtros por nome, não lidas, aguardando resposta, grupos e etiqueta. Use para descobrir o chatid antes de ler mensagens.',
      inputSchema: z.object({
        name: z.string().optional().describe('Trecho do nome do contato ou grupo.'),
        chatid: z.string().optional().describe('Trecho do número ou chatid.'),
        unread_only: z.boolean().optional().describe('Só conversas com mensagens não lidas.'),
        awaiting_reply: z.boolean().optional().describe('Só conversas em que o contato espera resposta.'),
        groups: z.boolean().optional().describe('true: só grupos; false: só contatos individuais.'),
        label: z.string().optional().describe('ID da etiqueta (veja list_labels no catálogo).'),
        limit: z.number().int().min(1).max(200).default(20),
        offset: z.number().int().min(0).default(0),
      }),
      outputSchema: z.object({ chats: z.array(chatOut), pagination }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async (a) => {
      const body: Obj = { compact: true, sort: '-wa_lastMsgTimestamp', limit: a.limit, offset: a.offset };
      if (a.name) body.wa_contactName = `~${a.name}`;
      if (a.chatid) body.wa_chatid = `~${a.chatid}`;
      if (a.unread_only) body.wa_unreadCount = '>0';
      if (a.awaiting_reply !== undefined) body.lead_awaitingReply = a.awaiting_reply;
      if (a.groups !== undefined) body.wa_isGroup = a.groups;
      if (a.label) body.wa_label = a.label;
      const r = await call('findChats', body);
      const out = {
        chats: ((r.chats ?? []) as Obj[]).map(compactChat),
        pagination: pick((r.pagination ?? {}) as Obj, ['totalRecords', 'hasMore', 'nextOffset']),
      };
      return textResult(out, out);
    }),
  );

  server.registerTool(
    'get_messages',
    {
      title: 'Ler mensagens de uma conversa',
      description:
        'Lê as mensagens de um chat, da mais recente para a mais antiga. Mídias vêm com messageType e, quando disponível, fileURL; use download_media para obter o arquivo ou transcrever áudio.',
      inputSchema: z.object({
        chatid: z.string().describe('chatid completo, como 5511999999999@s.whatsapp.net ou ...@g.us (veja find_chats).'),
        limit: z.number().int().min(1).max(200).default(20),
        offset: z.number().int().min(0).default(0).describe('0 = mais recentes. Use pagination.nextOffset para continuar.'),
      }),
      outputSchema: z.object({ messages: z.array(messageOut), pagination }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async (a) => {
      const r = await call('findMessages', a);
      const out = {
        messages: ((r.messages ?? []) as Obj[]).map(compactMessage),
        pagination: pick((r.pagination ?? {}) as Obj, ['hasMore', 'nextOffset']),
      };
      return textResult(out, out);
    }),
  );

  server.registerTool(
    'get_chat_details',
    {
      title: 'Detalhes de um contato ou grupo',
      description:
        'Mostra nome, foto, dados comerciais, etiquetas, campos de lead e grupos em comum de um contato ou grupo.',
      inputSchema: z.object({ number: chatId }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ number }) => {
      const r = await call('getChatDetails', { number, preview: true });
      const out = Object.fromEntries(Object.entries(prune(r) as Obj).filter(([k]) => !k.startsWith('chatbot_')));
      return textResult(out);
    }),
  );

  server.registerTool(
    'check_whatsapp_numbers',
    {
      title: 'Verificar números no WhatsApp',
      description: 'Confere se números de telefone têm WhatsApp e devolve o JID correto de cada um. Use antes do primeiro envio a um número novo.',
      inputSchema: z.object({
        numbers: z.array(z.string()).min(1).max(50).describe('Números em formato internacional, só dígitos.'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ numbers }) => {
      const r = await call('checkChat', { numbers });
      return textResult(prune(r));
    }),
  );

  server.registerTool(
    'download_media',
    {
      title: 'Baixar ou transcrever mídia',
      description:
        'Gera um link público (válido por 2 dias) para a mídia de uma mensagem. Com `transcribe: true`, devolve também a transcrição de áudios.',
      inputSchema: z.object({
        id: z.string().describe('ID da mensagem com mídia (campo id ou messageid de get_messages).'),
        transcribe: z.boolean().optional().describe('Transcreve áudio para texto.'),
      }),
      outputSchema: z.looseObject({ fileURL: z.string().optional(), mimetype: z.string(), transcription: z.string().optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ id, transcribe }) => {
      const r = await call('downloadMessage', { id, transcribe, return_link: true, return_base64: false });
      const out = { mimetype: String(r.mimetype ?? ''), ...pick(r, ['fileURL', 'transcription']) };
      return textResult(out, out);
    }),
  );

  server.registerTool(
    'mark_chat_read',
    {
      title: 'Marcar conversa como lida',
      description: 'Marca uma conversa como lida (ou não lida, com read=false).',
      inputSchema: z.object({ number: chatId, read: z.boolean().default(true) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async (args) => textResult(prune(await call('markChatRead', args)))),
  );

  if (profile === 'all') {
    for (const op of catalog.operations) {
      if (CORE_OPERATIONS.has(op.id)) continue;
      server.registerTool(
        snake(op.id),
        {
          title: op.summary,
          description: `${op.summary}. Categoria: ${op.tag}.\n\n${op.description}`.slice(0, 2000),
          inputSchema: fromJsonSchema<Obj>(op.inputSchema as Parameters<typeof fromJsonSchema>[0]),
          annotations: annotationsFor(op),
        },
        (args: Obj) => runOperation(creds, op, args ?? {}),
      );
    }
    return;
  }

  server.registerTool(
    'search_operations',
    {
      title: 'Buscar outras ações do WhatsApp',
      description: `Procura, entre ${catalog.operations.length} ações da API Uazapi, as que não estão nas tools diretas: grupos e comunidades, canais, enquetes, botões e listas, carrosséis, PIX e cobranças, reações, editar ou apagar mensagens, etiquetas, CRM e leads, respostas rápidas, catálogo comercial, envio em massa, contatos, bloqueios, chamadas e perfil. Sem argumentos, lista as categorias. Depois use describe_operation e call_operation.`,
      inputSchema: z.object({
        query: z.string().optional().describe('Palavras-chave em português ou inglês, por exemplo "enquete", "adicionar participante grupo".'),
        category: z.string().optional().describe('Filtra por categoria.'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, category }) => {
      if (!query && !category) return textResult({ categories: categories() });
      const ops = searchOperations(query, category);
      return textResult(ops.length ? { operations: ops.map(summarize) } : 'Nenhuma ação encontrada; tente outras palavras ou liste as categorias.');
    },
  );

  server.registerTool(
    'describe_operation',
    {
      title: 'Ver parâmetros de uma ação',
      description: 'Mostra a documentação e o JSON Schema dos argumentos de uma ação encontrada em search_operations.',
      inputSchema: z.object({ operation: z.string().describe('ID da ação, por exemplo sendMenu.') }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ operation }) => {
      const op = getOperation(operation);
      if (!op) return errorResult(new Error(`Ação desconhecida: ${operation}. Use search_operations.`));
      return textResult({ ...summarize(op), description: op.description, arguments: op.inputSchema });
    },
  );

  server.registerTool(
    'call_operation',
    {
      title: 'Executar uma ação da API',
      description:
        'Executa uma ação do catálogo com os argumentos descritos por describe_operation. Ações marcadas como destructive (apagar, sair de grupo, bloquear, limpar fila) só devem ser executadas com pedido explícito do usuário.',
      inputSchema: z.object({
        operation: z.string().describe('ID da ação.'),
        arguments: z.record(z.string(), z.unknown()).default({}).describe('Argumentos conforme o schema de describe_operation.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ operation, arguments: args }) => {
      const op = getOperation(operation);
      if (!op) return errorResult(new Error(`Ação desconhecida: ${operation}. Use search_operations.`));
      return runOperation(creds, op, args);
    },
  );
}
