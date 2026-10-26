import data from './catalog.json';

export interface Operation {
  id: string;
  tag: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  pathParams: string[];
  queryParams: string[];
  bodyIsArray: boolean;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  readOnly: boolean;
  destructive: boolean;
}

export const catalog = data as { apiVersion: string; contractSha256: string; operations: Operation[] };

const byId = new Map(catalog.operations.map((op) => [op.id, op]));

export function getOperation(id: string): Operation | undefined {
  return byId.get(id);
}

export function categories(): { category: string; operations: number }[] {
  const counts = new Map<string, number>();
  for (const op of catalog.operations) counts.set(op.tag, (counts.get(op.tag) ?? 0) + 1);
  return [...counts].map(([category, operations]) => ({ category, operations }));
}

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

export function searchOperations(query?: string, category?: string, limit = 15): Operation[] {
  const terms = query ? normalize(query).split(/\s+/).filter(Boolean) : [];
  const cat = category ? normalize(category) : undefined;
  const scored: [Operation, number][] = [];
  for (const op of catalog.operations) {
    if (cat && !normalize(op.tag).includes(cat)) continue;
    const head = normalize(`${op.id} ${op.summary} ${op.tag} ${op.path}`);
    const body = normalize(op.description);
    let score = 0;
    for (const t of terms) {
      if (head.includes(t)) score += 3;
      else if (body.includes(t)) score += 1;
    }
    if (terms.length && score === 0) continue;
    scored.push([op, score]);
  }
  return scored
    .sort((a, b) => b[1] - a[1] || a[0].id.localeCompare(b[0].id))
    .slice(0, limit)
    .map(([op]) => op);
}

/** Splits flat tool arguments into the path, query and body parts of an operation. */
export function buildRequest(op: Operation, args: Record<string, unknown>) {
  let path = op.path;
  const query: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (op.pathParams.includes(k)) path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
    else if (op.queryParams.includes(k)) query[k] = v;
    else body[k] = v;
  }
  const missing = op.pathParams.filter((p) => path.includes(`{${p}}`));
  if (missing.length) throw new Error(`Parâmetros de caminho ausentes: ${missing.join(', ')}`);
  if (op.method === 'GET') return { method: op.method, path, query };
  return { method: op.method, path, query, body: op.bodyIsArray ? body.body : body };
}
