// Shared in-memory item store.
//
// Both `route.ts` (collection) and `[id]/route.ts` (single item) import this
// SAME module, so a POST is visible to later GET/PATCH/DELETE. Declaring a
// separate `new Map()` in each route file would give each its own store, so
// CRUD on an item would always 404 after it was created.
//
// (In a real app, replace this with a database.)
export interface Item {
  id: string;
  name: string;
  [key: string]: unknown;
}

export const items = new Map<string, Item>();
