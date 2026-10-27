# uazapi-mcp

Servidor MCP remoto para operar **uma instância** [Uazapi](https://docs.uazapi.com/) (WhatsApp) a partir de agentes: Claude, Cursor, Composio, Executor e qualquer cliente MCP. É uma instância por conexão, e cada conexão leva o token da instância no header.

- 10 tools diretas para o dia a dia (status, reconectar por QR code, enviar texto e mídia, ler conversas e mensagens, baixar ou transcrever mídia) e acesso às outras 126 ações da API (grupos, canais, enquetes, botões, reações, etiquetas, CRM, envio em massa) por busca progressiva.
- Spec MCP **2026-07-28** (stateless, sem sessão, `tools/list` cacheável) com fallback automático para clientes 2025.
- Roda em Cloudflare Workers e também em Bun ou Deno. Não guarda nada: o token chega em cada requisição e é repassado só para `*.uazapi.com`.

## Instalar com um agente

Cole este prompt no Claude Code, Codex, Cursor ou outro agente com terminal:

```text
Instale o servidor MCP do Uazapi do repositório https://github.com/ogallotti/uazapi-mcp na minha conta Cloudflare e me deixe pronto para conectar.

1. Clone o repositório e rode `npm install`.
2. Confira o acesso à Cloudflare com `npx wrangler whoami`. Se não houver login, rode `npx wrangler login` e espere eu autorizar no navegador.
3. Publique com `npm run deploy` e anote a URL `https://uazapi-mcp.<conta>.workers.dev` que o wrangler mostrar.
   Se eu quiser um domínio próprio, pergunte qual e publique com `npx wrangler deploy --domain <dominio>` (o domínio precisa estar na mesma conta Cloudflare).
4. Rode `MCP_URL=<url>/teste/mcp npm run smoke` e confirme "all checks passed".
5. Pergunte a Server URL da minha instância Uazapi (ex.: https://minhaempresa.uazapi.com). O <subdominio> é a parte antes de .uazapi.com.
   Se eu quiser testar com a instância real, nunca peça o token no chat: me peça para rodar no terminal
   `read -rs SMOKE_UAZAPI_TOKEN && export SMOKE_UAZAPI_TOKEN && MCP_URL=<url>/<subdominio>/mcp npm run smoke` (só faz leituras).
6. Me entregue a configuração final: URL `<url>/<subdominio>/mcp` e header `Authorization: Bearer <token da instância>`, com o passo a passo para o meu cliente MCP (seção "Conectar" do README).

Se eu não usar Cloudflare, siga a seção "Outros runtimes" do README.
```

## Instalar à mão

Requisitos: Node 20+ e uma conta Cloudflare. O plano grátis serve para começar; se aparecer erro de limite de CPU, o Workers Paid (US$ 5/mês) resolve.

```bash
git clone https://github.com/ogallotti/uazapi-mcp && cd uazapi-mcp
npm install
npx wrangler login          # se ainda não estiver logado
npm run deploy              # publica em https://uazapi-mcp.<conta>.workers.dev
# domínio próprio (opcional):
npx wrangler deploy --domain mcp.seudominio.com
```

Confira com `MCP_URL=https://uazapi-mcp.<conta>.workers.dev/teste/mcp npm run smoke`.

### Outros runtimes

O servidor é um handler `fetch` padrão, testado também em Bun e Deno. Coloque HTTPS na frente (proxy reverso, Caddy, túnel) antes de expor.

```bash
PORT=8787 bun src/index.ts
deno serve --allow-net --allow-env --allow-read --port 8787 src/index.ts
```

## Conectar

Endpoint: `https://<seu-servidor>/<subdominio>/mcp`, onde `<subdominio>` é a parte antes de `.uazapi.com` na Server URL da instância.

Use o **token da instância** (não o admintoken) em um destes headers:

| Header | Valor |
|---|---|
| `Authorization` | `Bearer <token>` |
| `token` | `<token>` (o mesmo header da API Uazapi) |
| `x-uazapi-token` | `<token>` |

Também dá para usar `POST /mcp` com o header `x-uazapi-server: <subdominio>`. Só hosts `*.uazapi.com` são aceitos; outros entram pela variável `EXTRA_ALLOWED_HOSTS` (lista de sufixos separados por vírgula).

### Claude Code

```bash
read -rs UAZAPI_TOKEN   # cole o token; ele não aparece na tela nem fica no histórico
claude mcp add --transport http uazapi https://<seu-servidor>/<subdominio>/mcp --header "Authorization: Bearer $UAZAPI_TOKEN"
unset UAZAPI_TOKEN
```

### Cursor, Claude Desktop e clientes com JSON

```json
{
  "mcpServers": {
    "uazapi": {
      "url": "https://<seu-servidor>/<subdominio>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### Composio (Custom MCP)

No painel, em Add Custom MCP:

- **MCP server URL:** `https://<seu-servidor>/<subdominio>/mcp`. Acrescente `?tools=all` para expor as 136 tools granulares, porque o Composio já faz busca de tools.
- **Authentication:** API key. Em Advanced settings, **Header name** `Authorization` e **Header prefix** `Bearer`.
- Na tela de conexão da conta, cole **só o token da instância**, sem `Bearer`.

Pela API, o header é um modelo com `{{generic_api_key}}`:

```bash
curl -X POST https://backend.composio.dev/api/v3.1/custom/toolkits/upsert \
  -H "x-api-key: $COMPOSIO_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "slug": "UAZAPI",
    "toolkit_config": {
      "name": "Uazapi WhatsApp",
      "app_url": "https://<seu-servidor>/<subdominio>/mcp?tools=all",
      "auth_schemes": [{ "mode": "API_KEY", "headers": { "Authorization": "Bearer {{generic_api_key}}" } }]
    }
  }'
```

Cada instância vira uma conta conectada do toolkit, com o próprio token.

### Executor

Custom app → MCP → URL `https://<seu-servidor>/<subdominio>/mcp` e header `Authorization: Bearer <token>`. O Executor também faz busca e code mode, e tanto o perfil padrão quanto `?tools=all` funcionam.

### Conferir se funcionou

Peça ao agente o status do WhatsApp (tool `whatsapp_status`). Se ele responder `connected` com o nome do perfil, está tudo certo.

| Resposta | Causa |
|---|---|
| `401 Invalid token` | O token não é da instância daquele subdomínio, ou é o admintoken. |
| `400 Servidor Uazapi inválido no caminho` | O subdomínio da URL está errado. |
| `Conexão sem credenciais Uazapi` | O cliente não enviou o header. |

## Tools

Perfil padrão (progressive disclosure, 13 tools):

| Tool | O que faz |
|---|---|
| `whatsapp_status` | Conexão, perfil e motivo da última queda; QR code se estiver conectando |
| `whatsapp_connect` | Reconecta: QR code (imagem) ou código de pareamento |
| `send_text`, `send_media` | Envio de texto e de mídia por URL |
| `find_chats`, `get_messages`, `get_chat_details` | Leitura compacta de conversas e mensagens |
| `check_whatsapp_numbers` | Confere se números têm WhatsApp |
| `download_media` | Link da mídia e transcrição de áudio |
| `mark_chat_read` | Marca conversa como lida |
| `search_operations` → `describe_operation` → `call_operation` | As outras 126 ações: grupos, canais, enquetes, botões, reações, editar ou apagar, etiquetas, CRM, respostas rápidas, catálogo, envio em massa |

`?tools=all` expõe as 10 tools curadas e mais uma tool por operação do catálogo (136 no total), com as anotações `readOnlyHint` e `destructiveHint`.

Ficam fora do escopo, por desenho: rotas de `admintoken`, proxy, webhooks e SSE, Chatwoot, apagar, desconectar ou renomear a instância, privacidade e delay de fila.

## Segurança

- O servidor não tem banco nem segredo próprio. Quem tem a URL e um token válido opera aquela instância, exatamente como na API do Uazapi.
- Só chama hosts `*.uazapi.com` (ou os de `EXTRA_ALLOWED_HOSTS`), recusa redirects e mascara `token`, `admintoken` e `openai_apikey` nas respostas.
- Envios nunca são repetidos automaticamente. Leituras são repetidas até 3 vezes em 429 ou 5xx, respeitando `Retry-After`.

## Desenvolvimento

```bash
npm install
npm run catalog      # regenera src/catalog.json a partir do OpenAPI publicado
npm run typecheck
npm run dev          # wrangler dev em http://localhost:8787
read -rs SMOKE_UAZAPI_TOKEN && export SMOKE_UAZAPI_TOKEN   # opcional: testa leituras na instância real
MCP_URL=http://localhost:8787/<subdominio>/mcp npm run smoke
```

O smoke test usa um cliente da spec 2026-07-28 e outro de 2025. Sem `SMOKE_UAZAPI_TOKEN`, não chama o Uazapi; com ele, faz só leituras.

O catálogo é gerado do OpenAPI oficial (`docs.uazapi.com/openapi-bundled.json`) e fica travado pelo `contractSha256` do `release.json`.

## Known gaps

- Não há confirmação (elicitation/MRTR) antes de ações destrutivas, porque Composio e Executor não suportam elicitation. A proteção vem das anotações `destructiveHint` e das aprovações do cliente.
- Não há eventos em tempo real (`/sse` do Uazapi → `subscriptions/listen`). Ficam para quando um cliente-alvo suportar assinaturas.
- `call_operation` não valida argumentos localmente. A validação é a da API Uazapi, e um erro 400 volta para o agente.
- Respostas acima de 60 mil caracteres são cortadas com aviso para paginar.
- Chamadas ao Uazapi expiram em 30 s. Um envio que expira pode ter sido entregue, e o agente é avisado para conferir antes de repetir.

## Licença

MIT
