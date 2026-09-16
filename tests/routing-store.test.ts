import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRoutingStore, writeRoutingStore, withRoutingStoreLock } from "../routing-store";

const directories: string[] = [];
async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), "discordian-routing-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
const legacy = { version: 3, custom: { preserved: true }, routes: [
  { accountId: "a", chatId: "thread", threadId: "thread", conversationId: "conv-established", agentId: "agent", unknown: [1, 2] },
  { accountId: "b", chatId: "dm", chatType: "direct", threadId: null, conversationId: "conv-dm", enabled: false },
] };

test("JSON is canonical; stale YAML is never merged", async () => {
  const dir = await fixture();
  await fs.writeFile(join(dir, "routing.yaml"), JSON.stringify(legacy));
  await fs.writeFile(join(dir, "routing.json"), JSON.stringify({ routes: [] }));
  expect((await readRoutingStore(dir)).document).toEqual({ routes: [] });
});
test("legacy-only read preserves IDs, metadata, thread/DM fields and writes JSON", async () => {
  const dir = await fixture();
  const bytes = JSON.stringify(legacy);
  await fs.writeFile(join(dir, "routing.yaml"), bytes);
  const store = await readRoutingStore(dir);
  expect(store.document).toEqual(legacy);
  await writeRoutingStore(store);
  expect(JSON.parse(await fs.readFile(join(dir, "routing.json"), "utf8"))).toEqual(legacy);
  expect(await fs.readFile(join(dir, "routing.yaml"), "utf8")).toBe(bytes);
  expect((await fs.stat(join(dir, "routing.json"))).mode & 0o777).toBe(0o600);
  expect((await fs.readdir(dir)).sort()).toEqual(["routing.json", "routing.yaml"]);
});
test("fresh absent store starts empty without writing", async () => {
  const dir = await fixture();
  expect((await readRoutingStore(dir)).document).toEqual({ routes: [] });
  expect(await fs.readdir(dir)).toEqual([]);
});
test("corrupt JSON fails closed without falling back or changing files", async () => {
  for (const bytes of ["{", "null", "{}", '{"routes":{}}', '{"routes":[null]}', '{"routes":[{"conversationId":42}]}']) {
    const dir = await fixture();
    await fs.writeFile(join(dir, "routing.json"), bytes);
    await fs.writeFile(join(dir, "routing.yaml"), JSON.stringify(legacy));
    await expect(readRoutingStore(dir)).rejects.toThrow();
    expect(await fs.readFile(join(dir, "routing.json"), "utf8")).toBe(bytes);
  }
});
test("non-missing read failures and corrupt legacy are not empty stores", async () => {
  const dir = await fixture();
  await fs.mkdir(join(dir, "routing.json"));
  await expect(readRoutingStore(dir)).rejects.toThrow();
  await fs.rm(join(dir, "routing.json"), { recursive: true });
  await fs.writeFile(join(dir, "routing.yaml"), "invalid");
  await expect(readRoutingStore(dir)).rejects.toThrow();
});
test.skipIf(process.getuid?.() === 0)("permission errors do not fall back to legacy", async () => {
  const dir = await fixture();
  const path = join(dir, "routing.json");
  await fs.writeFile(path, JSON.stringify({ routes: [] }));
  await fs.writeFile(join(dir, "routing.yaml"), JSON.stringify(legacy));
  await fs.chmod(path, 0o000);
  try {
    await expect(readRoutingStore(dir)).rejects.toThrow();
  } finally {
    await fs.chmod(path, 0o600);
  }
  expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ routes: [] });
});
test("canonical mutation preserves existing mappings and unknown fields", async () => {
  const dir = await fixture();
  await fs.writeFile(join(dir, "routing.json"), JSON.stringify(legacy));
  const store = await readRoutingStore(dir);
  store.document.routes.push({ accountId: "new", conversationId: "conv-new" });
  await writeRoutingStore(store);
  const document = (await readRoutingStore(dir)).document;
  expect(document.custom).toEqual(legacy.custom);
  expect(document.routes.slice(0, 2)).toEqual(legacy.routes);
});
test("failed atomic replacement cleans temporary file", async () => {
  const dir = await fixture();
  const store = await readRoutingStore(dir);
  await fs.mkdir(join(dir, "routing.json"));
  await expect(writeRoutingStore(store)).rejects.toThrow();
  expect(await fs.readdir(dir)).toEqual(["routing.json"]);
});
test("whole-store lock serializes accounts and releases after errors", async () => {
  const dir = await fixture();
  await expect(withRoutingStoreLock(dir, async () => { throw new Error("test"); })).rejects.toThrow("test");
  await Promise.all(["a", "b"].map(accountId => withRoutingStoreLock(dir, async () => {
    const store = await readRoutingStore(dir);
    await new Promise(resolve => setTimeout(resolve, 5));
    store.document.routes.push({ accountId });
    await writeRoutingStore(store);
  })));
  expect((await readRoutingStore(dir)).document.routes.map(route => route.accountId)).toEqual(["a", "b"]);
});
test("adapter uses shared store and preserves document on every write", async () => {
  const source = await fs.readFile(new URL("../adapter.ts", import.meta.url), "utf8");
  expect(source).toContain('from "./routing-store"');
  expect(source).not.toContain('"routing.yaml"');
  expect(source.match(/await writeRoutingStore\(store\)/g)?.length).toBe(4);
  expect(source.match(/withRoutingStoreLock\(routingDirectory\(\), async/g)?.length).toBe(3);
});
