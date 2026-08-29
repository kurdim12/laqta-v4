// A very small IndexedDB wrapper.
//
// IndexedDB rather than localStorage for one reason that decides the whole law: localStorage
// stores strings, and a photo is a Blob. A queue that cannot hold the image itself is not a
// queue — it is a note saying a photo used to exist, which is precisely what v1 had.

const DB_NAME = "laqta";
const DB_VERSION = 1;
export const OUTBOX = "outbox";
export const CACHE = "cache";

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX)) {
        const store = db.createObjectStore(OUTBOX, { keyPath: "id" });
        store.createIndex("state", "state");
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(CACHE)) {
        db.createObjectStore(CACHE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.onabort = () => reject(t.error);
  });
}

export async function getAll<T>(store: string): Promise<T[]> {
  return (await tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>)) ?? [];
}

export async function put<T>(store: string, value: T): Promise<void> {
  await tx(store, "readwrite", (s) => s.put(value as unknown as never));
}

export async function del(store: string, key: IDBValidKey): Promise<void> {
  await tx(store, "readwrite", (s) => s.delete(key));
}

export async function get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return await tx<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
}
