// Generates src/catalog.json from the official Uazapi OpenAPI contract.
// Usage: node scripts/build-catalog.mjs [path-to-openapi.json]
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const SPEC_URL = 'https://docs.uazapi.com/openapi-bundled.json';
const RELEASE_URL = 'https://docs.uazapi.com/release.json';

// Instance-scoped MCP: server administration and instance plumbing stay out.
const EXCLUDED_TAGS = new Set(['Administração', 'Proxy', 'Webhooks e SSE', 'Integração Chatwoot']);
const EXCLUDED_OPS = new Set([
  'deleteInstance',
  'disconnectInstance',
  'updateInstanceName',
  'updateDelaySettings',
  'getInstancePrivacy',
  'setPrivacySetting',
]);

const READ_PREFIXES = ['get', 'list', 'find', 'check', 'count', 'search'];
const DESTRUCTIVE_WORDS = ['delete', 'clear', 'leave', 'remove', 'revoke', 'transfer', 'unfollow', 'block', 'reject'];

async function loadSpec() {
  const local = process.argv[2];
  if (local) return { raw: await readFile(local, 'utf8'), release: null };
  const [raw, release] = await Promise.all([
    fetch(SPEC_URL).then((r) => r.text()),
    fetch(RELEASE_URL).then((r) => r.json()),
  ]);
  return { raw, release };
}

function deref(node, schemas, seen = new Set()) {
  if (Array.isArray(node)) return node.map((n) => deref(n, schemas, seen));
  if (!node || typeof node !== 'object') return node;
  if (node.$ref) {
    const name = node.$ref.split('/').pop();
    if (seen.has(name)) return { type: 'object', description: `${name} (recursivo)` };
    const next = new Set(seen).add(name);
    const { $ref, ...rest } = node;
    return { ...deref(schemas[name], schemas, next), ...deref(rest, schemas, next) };
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'example' || k === 'examples' || k === 'xml') continue;
    out[k] = deref(v, schemas, seen);
  }
  return out;
}

function classify(id, method) {
  const lower = id.toLowerCase();
  const readOnly = method === 'GET' || READ_PREFIXES.some((p) => id.startsWith(p)) || id === 'downloadMessage';
  const destructive = !readOnly && DESTRUCTIVE_WORDS.some((w) => lower.includes(w));
  return { readOnly, destructive };
}

const { raw, release } = await loadSpec();
const spec = JSON.parse(raw);
const sha = release?.contractSha256 ?? createHash('sha256').update(raw).digest('hex');
const schemas = spec.components.schemas;

const operations = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [m, op] of Object.entries(item)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) continue;
    const tag = op.tags?.[0] ?? 'Outros';
    const security = op.security ?? spec.security ?? [];
    const usesAdmin = security.some((s) => 'admintoken' in s);
    if (EXCLUDED_TAGS.has(tag) || EXCLUDED_OPS.has(op.operationId) || usesAdmin) continue;

    const method = m.toUpperCase();
    const properties = {};
    const required = [];
    const pathParams = [];
    const queryParams = [];
    for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => deref(p, schemas))) {
      if (p.in === 'header') continue;
      (p.in === 'path' ? pathParams : queryParams).push(p.name);
      properties[p.name] = { ...p.schema, description: p.description ?? p.schema?.description };
      if (p.required) required.push(p.name);
    }

    let bodyIsArray = false;
    const body = op.requestBody?.content?.['application/json']?.schema;
    if (body) {
      const b = deref(body, schemas);
      if (b.type === 'array') {
        bodyIsArray = true;
        properties.body = b;
        if (op.requestBody.required) required.push('body');
      } else {
        Object.assign(properties, b.properties ?? {});
        required.push(...(b.required ?? []));
      }
    }

    operations.push({
      id: op.operationId,
      tag,
      method,
      path,
      summary: op.summary ?? op.operationId,
      description: op.description ?? '',
      pathParams,
      queryParams,
      bodyIsArray,
      inputSchema: { type: 'object', properties, ...(required.length ? { required: [...new Set(required)] } : {}) },
      ...classify(op.operationId, method),
    });
  }
}

operations.sort((a, b) => a.id.localeCompare(b.id));
const catalog = { apiVersion: spec.info.version, contractSha256: sha, operations };
await writeFile(new URL('../src/catalog.json', import.meta.url), JSON.stringify(catalog));
console.log(`catalog: ${operations.length} operations, api ${spec.info.version}, sha ${sha.slice(0, 12)}`);
