import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface DiscordianRoute {
  [key: string]: unknown;
  accountId?: string;
  chatId?: string;
  chatType?: string;
  threadId?: string | null;
  agentId?: string | null;
  conversationId?: string | null;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface RoutingDocument {
  [key: string]: unknown;
  routes: DiscordianRoute[];
}

export interface RoutingStore {
  routingPath: string;
  document: RoutingDocument;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateDocument(value: unknown, path: string): asserts value is RoutingDocument {
  if (!isObject(value) || !Array.isArray(value.routes)) {
    throw new Error(`Invalid routing store ${path}: expected an object with a routes array`);
  }
  for (const route of value.routes) {
    if (!isObject(route)) throw new Error(`Invalid route in ${path}: expected an object`);
    for (const key of ["accountId", "chatId", "chatType", "createdAt", "updatedAt"]) {
      if (key in route && typeof route[key] !== "string") {
        throw new Error(`Invalid route ${key} in ${path}: expected a string`);
      }
    }
    for (const key of ["threadId", "agentId", "conversationId"]) {
      if (key in route && route[key] !== null && typeof route[key] !== "string") {
        throw new Error(`Invalid route ${key} in ${path}: expected a string or null`);
      }
    }
    if ("enabled" in route && typeof route.enabled !== "boolean") {
      throw new Error(`Invalid route enabled in ${path}: expected a boolean`);
    }
  }
}

async function readDocument(path: string): Promise<RoutingDocument | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in routing store ${path}`, { cause: error });
  }
  validateDocument(document, path);
  return document;
}

// Letta Code >=0.32.11: JSON is authoritative. Legacy .yaml contains JSON,
// not YAML syntax; only a missing canonical file permits this fallback.
export async function readRoutingStore(directory: string): Promise<RoutingStore> {
  const routingPath = resolve(directory, "routing.json");
  const document = await readDocument(routingPath)
    ?? await readDocument(join(directory, "routing.yaml"))
    ?? { routes: [] };
  return { routingPath, document };
}

// Caller must hold the whole-store lock from before reading until after writing.
// No legacy deletion or merge: recovery is an explicit, offline operation.
export async function writeRoutingStore(store: RoutingStore): Promise<void> {
  validateDocument(store.document, store.routingPath);
  const text = JSON.stringify(store.document, null, 2) + "\n";
  await fs.mkdir(dirname(store.routingPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${store.routingPath}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, store.routingPath);
  } finally {
    if (created) await fs.rm(temporaryPath, { force: true });
  }
}

// Shared by every account/adapter using this module. External CLI processes
// still require operator coordination; this is not a cross-process file lock.
const storeLocks = new Map<string, Promise<unknown>>();
export async function withRoutingStoreLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(directory, "routing.json");
  const previous = storeLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  storeLocks.set(key, next);
  try {
    return await next;
  } finally {
    if (storeLocks.get(key) === next) storeLocks.delete(key);
  }
}
