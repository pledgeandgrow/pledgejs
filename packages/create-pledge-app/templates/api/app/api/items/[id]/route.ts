const items: Map<string, { id: string; name: string }> = new Map();

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
  const body = await request.json();
  const updated = { ...item, ...body };
  items.set(id, updated);
  return Response.json(updated);
}

export async function DELETE(request: Request) {
  const id = getIdFromUrl(request.url);
  if (!items.has(id)) return Response.json({ error: 'Not found' }, { status: 404 });
  items.delete(id);
  return new Response(null, { status: 204 });
}
