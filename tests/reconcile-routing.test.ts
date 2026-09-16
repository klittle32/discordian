import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeRoutes, reconcileRouting } from "../scripts/reconcile-routing.mjs";

const route = (chatId: string, extra = {}) => ({
  accountId: "main", chatId, threadId: null, agentId: "agent-one",
  conversationId: `conv-${chatId}`, enabled: true, ...extra,
});

describe("offline routing recovery", () => {
  test("unions missing routes while preserving canonical metadata and route policy", () => {
    const canonical = route("old", { enabled: false, outboundEnabled: false, detached: true });
    const result = mergeRoutes({ version: 2, routes: [canonical] }, {
      routes: [route("old"), route("new", { threadId: "new", custom: "preserved" })],
    });
    expect(result).toEqual({ version: 2, routes: [canonical, route("new", { threadId: "new", custom: "preserved" })] });
  });

  test("keeps account and thread identities separate", () => {
    expect(mergeRoutes({ routes: [route("same")] }, { routes: [
      route("same", { accountId: "second" }), route("same", { threadId: "thread" }),
    ] }).routes).toHaveLength(3);
  });

  test("refuses conflicting conversation or agent bindings", () => {
    for (const extra of [{ conversationId: "conv-other" }, { agentId: "agent-other" }]) {
      expect(() => mergeRoutes({ routes: [route("same")] }, { routes: [route("same", extra)] })).toThrow("Conflicting binding");
    }
  });

  test("rejects duplicate identities and incomplete routes", () => {
    expect(() => mergeRoutes({ routes: [route("same"), route("same")] }, { routes: [] })).toThrow("Duplicate");
    expect(() => mergeRoutes({ routes: [] }, { routes: [{ chatId: "incomplete" }] })).toThrow("Invalid route");
  });

  test("dry-run does not change files; apply backs up and is repeatable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "discordian-recovery-test-"));
    try {
      const current = JSON.stringify({ metadata: "keep", routes: [route("old")] });
      const legacy = JSON.stringify({ routes: [route("new")] });
      await writeFile(join(dir, "routing.json"), current);
      await writeFile(join(dir, "routing.yaml"), legacy);
      const preview = await reconcileRouting(dir);
      expect(preview).toMatchObject({ canonical: 1, legacy: 1, added: 1, total: 2, applied: false });
      expect(await readdir(dir)).toHaveLength(2);
      expect(await readFile(join(dir, "routing.json"), "utf8")).toBe(current);
      const applied = await reconcileRouting(dir, true);
      expect(applied.applied).toBe(true);
      expect(await readFile(join(applied.backupDirectory!, "routing.json"), "utf8")).toBe(current);
      expect(await readFile(join(applied.backupDirectory!, "routing.yaml"), "utf8")).toBe(legacy);
      expect(JSON.parse(await readFile(join(dir, "routing.json"), "utf8"))).toEqual({ metadata: "keep", routes: [route("old"), route("new")] });
      expect(await readdir(dir)).not.toContain("routing.yaml");
      expect(await reconcileRouting(dir, true)).toMatchObject({ added: 0, total: 2, applied: false });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("malformed canonical file never falls back or changes either file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "discordian-recovery-test-"));
    try {
      await writeFile(join(dir, "routing.json"), "broken");
      await writeFile(join(dir, "routing.yaml"), JSON.stringify({ routes: [route("new")] }));
      await expect(reconcileRouting(dir, true)).rejects.toThrow();
      expect(await readFile(join(dir, "routing.json"), "utf8")).toBe("broken");
      expect(await readdir(dir)).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("legacy-only recovery preserves conversation IDs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "discordian-recovery-test-"));
    try {
      await writeFile(join(dir, "routing.yaml"), JSON.stringify({ routes: [route("old")] }));
      expect(await reconcileRouting(dir, true)).toMatchObject({ added: 1, total: 1, applied: true });
      expect(JSON.parse(await readFile(join(dir, "routing.json"), "utf8")).routes).toEqual([route("old")]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("backup failure leaves both original stores untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "discordian-recovery-test-"));
    try {
      const current = JSON.stringify({ routes: [route("old")] });
      const legacy = JSON.stringify({ routes: [route("new")] });
      await writeFile(join(dir, "routing.json"), current);
      await writeFile(join(dir, "routing.yaml"), legacy);
      await writeFile(join(dir, "routing-backups"), "not a directory");
      await expect(reconcileRouting(dir, true)).rejects.toThrow();
      expect(await readFile(join(dir, "routing.json"), "utf8")).toBe(current);
      expect(await readFile(join(dir, "routing.yaml"), "utf8")).toBe(legacy);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("conflicting or malformed legacy stores fail before backup and write", async () => {
    for (const legacy of ["broken", JSON.stringify({ routes: [route("same", { conversationId: "different" })] })]) {
      const dir = await mkdtemp(join(tmpdir(), "discordian-recovery-test-"));
      try {
        const current = JSON.stringify({ routes: [route("same")] });
        await writeFile(join(dir, "routing.json"), current);
        await writeFile(join(dir, "routing.yaml"), legacy);
        await expect(reconcileRouting(dir, true)).rejects.toThrow();
        expect(await readFile(join(dir, "routing.json"), "utf8")).toBe(current);
        expect(await readFile(join(dir, "routing.yaml"), "utf8")).toBe(legacy);
        expect(await readdir(dir)).toHaveLength(2);
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });
});
