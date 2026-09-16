#!/usr/bin/env node
// Offline repair only: stop the channel listener before using --apply.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

function routeKey(route) {
  return JSON.stringify([route.accountId ?? "default", route.chatId, route.threadId?.trim() || null]);
}

function validate(document, label) {
  if (!document || !Array.isArray(document.routes)) throw new Error(`Invalid routing document: ${label}`);
  const seen = new Set();
  for (const route of document.routes) {
    if (!route || [route.chatId, route.agentId, route.conversationId].some(value => typeof value !== "string" || !value.trim()) ||
        (route.accountId != null && typeof route.accountId !== "string") ||
        (route.threadId != null && typeof route.threadId !== "string")) {
      throw new Error(`Invalid route in ${label}`);
    }
    const key = routeKey(route);
    if (seen.has(key)) throw new Error(`Duplicate route in ${label}: ${key}`);
    seen.add(key);
  }
}

export function mergeRoutes(canonical, legacy) {
  validate(canonical, "routing.json");
  validate(legacy, "routing.yaml");
  const merged = new Map(canonical.routes.map(route => [routeKey(route), route]));
  for (const route of legacy.routes) {
    const key = routeKey(route);
    const current = merged.get(key);
    if (current && (current.agentId !== route.agentId || current.conversationId !== route.conversationId)) {
      throw new Error(`Conflicting binding for ${key}; resolve manually before applying`);
    }
    // Canonical policy/metadata wins for an already established binding.
    if (!current) merged.set(key, route);
  }
  return { ...canonical, routes: [...merged.values()] };
}

async function readOptional(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function reconcileRouting(directory, apply = false) {
  const canonicalPath = join(directory, "routing.json");
  const legacyPath = join(directory, "routing.yaml");
  const canonicalText = await readOptional(canonicalPath);
  const legacyText = await readOptional(legacyPath);
  const legacy = legacyText === null ? { routes: [] } : JSON.parse(legacyText);
  const canonical = canonicalText === null ? { ...legacy, routes: [] } : JSON.parse(canonicalText);
  const merged = mergeRoutes(canonical, legacy);
  const result = {
    canonical: canonical.routes.length, legacy: legacy.routes.length,
    added: merged.routes.length - canonical.routes.length,
    total: merged.routes.length, applied: false,
  };
  if (!apply || legacyText === null) return result;

  const backupDirectory = join(directory, "routing-backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  if (canonicalText !== null) await writeFile(join(backupDirectory, "routing.json"), canonicalText, { mode: 0o600, flag: "wx" });
  await writeFile(join(backupDirectory, "routing.yaml"), legacyText, { mode: 0o600, flag: "wx" });

  // Catch accidental live writers before the replace. This is not a substitute
  // for stopping the listener: the CLI and other writers must also be idle.
  if (await readOptional(canonicalPath) !== canonicalText || await readOptional(legacyPath) !== legacyText) {
    throw new Error("Routing changed during recovery; stop all writers and retry");
  }
  const temporaryPath = `${canonicalPath}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(merged, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(temporaryPath, canonicalPath);
    await unlink(legacyPath);
  } finally {
    await unlink(temporaryPath).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  return { ...result, applied: true, backupDirectory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || args[0].startsWith("--") || (args[1] && args[1] !== "--apply")) {
    console.error("Usage: node scripts/reconcile-routing.mjs <channel-directory> [--apply]\nStop the listener and other route writers before --apply. Default: read-only preview.");
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await reconcileRouting(resolve(args[0]), args[1] === "--apply"), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
