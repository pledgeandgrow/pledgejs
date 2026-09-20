import { items } from '../store';

function getIdFromUrl(url: string): string {
  const match = url.match(/\/api\/items\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export async function GET(request: Request) {
  const id = getIdFromUrl(request.url);
  const item = items.get(id);
  if (!item) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(item);
}

export async function PATCH(request: Request) {
  const id = getIdFromUrl(request.url);
  const item = items.get(id);
  if (!item) return Response.json({ error: 'Not found' }, { status: 404 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return Response.json({ error: 'Body must be a JSON object' }, { status: 400 });
  }
  // Keep the stored id immutable — a body "id" must not rewrite it.
  const updated = { ...item, ...(body as Record<string, unknown>), id: item.id };
  items.set(id, updated);
  return Response.json(updated);
}

export async function DELETE(request: Request) {
  const id = getIdFromUrl(request.url);
  if (!items.has(id)) return Response.json({ error: 'Not found' }, { status: 404 });
  items.delete(id);
  return new Response(null, { status: 204 });
}
