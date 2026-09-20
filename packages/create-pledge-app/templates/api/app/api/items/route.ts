import { items } from './store';

export async function GET() {
  return Response.json(Array.from(items.values()));
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return Response.json({ error: 'Body must be a JSON object' }, { status: 400 });
  }
  const id = crypto.randomUUID();
  // `id` goes last so a client-supplied "id" can't override the server's.
  const item = { name: '', ...(body as Record<string, unknown>), id };
  items.set(id, item);
  return Response.json(item, { status: 201 });
}
