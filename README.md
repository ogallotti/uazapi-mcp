# uazapi-mcp

Servidor MCP remoto para operar **uma instância** Uazapi (WhatsApp) no dia a dia: uma instância, uma conexão MCP. A gestão do servidor Uazapi (criar instâncias, admintoken, webhooks globais) fica para outro servidor MCP.

- Spec MCP **2026-07-28** (stateless, sem sessão, `tools/list` cacheável) com fallback automático para clientes 2025 (Composio, Executor, Claude, Cursor).
- Roda em Cloudflare Workers, publicado em `https://uazapi.sling.digital` (custom domain; `workers.dev` desligado). Não guarda nada: o token chega a cada request e é repassado ao Uazapi.
- Catálogo gerado do OpenAPI oficial (`docs.uazapi.com/openapi-bundled.json`), travado pelo `contractSha256` do `release.json`.

## Conectar

Endpoint: `https://uazapi.sling.digital/<subdominio>/mcp`, onde `<subdominio>` é a parte antes de `.uazapi.com` na Server URL da instância.

Token da instância, em um destes headers:

| Header | Exemplo |
|---|---|
| `Authorization` | `Bearer <token>` |
| `token` | `<token>` (mesmo header da API Uazapi) |
| `x-uazapi-token` | `<token>` |

Alternativa ao caminho: `POST /mcp` com header `x-uazapi-server: <subdominio>` ou a URL completa. Só hosts `*.uazapi.com` são aceitos (outros via variável `EXTRA_ALLOWED_HOSTS`).

### Composio (Custom MCP)

```bash
curl -X POST https://backend.composio.dev/api/v3.1/custom/toolkits/upsert \
  -H "x-api-key: $COMPOSIO_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "slug": "UAZAPI",
    "toolkit_config": {
      "name": "Uazapi WhatsApp",
      "app_url": "https://uazapi.sling.digital/<subdominio>/mcp?tools=all",
      "auth_schemes": [{ "mode": "API_KEY", "headers": { "Authorization": "Bearer {{generic_api_key}}" } }]
    }
  }'
```

Cada instância vira uma conta conectada do toolkit, com o próprio token como `generic_api_key`. Use `?tools=all`: Composio já faz busca de tools, então ele aproveita melhor as 136 tools granulares.

### Executor

Custom app → MCP → URL `https://uazapi.sling.digital/<subdominio>/mcp` e header `Authorization: Bearer <token>`. O Executor também faz busca e code mode; tanto o perfil padrão quanto `?tools=all` funcionam.

### Claude Code / outros clientes

```bash
claude mcp add --transport http uazapi https://uazapi.sling.digital/<subdominio>/mcp --header "Authorization: Bearer <token>"
```

## Tools

Perfil padrão (progressive disclosure, 13 tools):

| Tool | O que faz |
|---|---|
| `whatsapp_status` | Conexão, perfil, motivo da última queda; QR code se estiver conectando |
| `whatsapp_connect` | Reconecta: QR code (imagem) ou código de pareamento |
| `send_text`, `send_media` | Envio de texto e mídia por URL |
| `find_chats`, `get_messages`, `get_chat_details` | Leitura compacta de conversas e mensagens |
| `check_whatsapp_numbers` | Confere se números têm WhatsApp |
| `download_media` | Link da mídia e transcrição de áudio |
| `mark_chat_read` | Marca conversa como lida |
| `search_operations` → `describe_operation` → `call_operation` | As outras 126 ações: grupos, canais, enquetes, botões, reações, editar/apagar, etiquetas, CRM, respostas rápidas, catálogo, envio em massa |

`?tools=all`: as 10 tools curadas + uma tool por operação do catálogo (136 no total), com anotações `readOnlyHint`/`destructiveHint`.

Fora do escopo por desenho: rotas de `admintoken`, proxy, webhooks/SSE, Chatwoot, apagar/desconectar/renomear instância, privacidade e delay de fila.

## Desenvolvimento

```bash
npm install
npm run catalog      # regenera src/catalog.json a partir do OpenAPI publicado
npm run typecheck
npm run dev          # wrangler dev
MCP_URL=http://localhost:8787/<subdominio>/mcp SMOKE_UAZAPI_TOKEN=<token> npm run smoke
npm run deploy
```

O smoke test usa um cliente 2026-07-28 e um cliente 2025. Sem `SMOKE_UAZAPI_TOKEN`, ele não chama o Uazapi; com ele, faz só leituras.

## Known gaps

- Sem confirmação (elicitation/MRTR) antes de ações destrutivas: Composio e Executor não suportam elicitation; dependemos das anotações `destructiveHint` e das aprovações do cliente.
- Sem eventos em tempo real (`/sse` do Uazapi → `subscriptions/listen`): fica para quando um cliente-alvo suportar assinaturas.
- `call_operation` não valida argumentos localmente; a validação é a da API Uazapi (erro 400 volta para o agente).
- Respostas acima de 60 mil caracteres são truncadas com aviso para paginar.
