import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  resolveDiscordianEffectiveChannelConfig,
} from "./channel-gating";
import { formatDiscordDeliveryError } from "./error-reply";
import {
  resolveDiscordInboundAttachments,
  resolveDiscordThreadHistory,
  resolveDiscordThreadStarter,
} from "./media";
import { CHANNEL_ID, DISPLAY_NAME, loadDiscordModule } from "./runtime.mjs";

type DiscordEventHandlerResult = void | Promise<void>;

interface DiscordUserLike {
  id: string;
  username?: string | null;
  globalName?: string | null;
  tag?: string | null;
  bot?: boolean;
}

interface DiscordGuildMemberLike {
  displayName?: string | null;
}

interface DiscordAttachmentLike {
  id: string;
  name?: string | null;
  contentType?: string | null;
  size?: number;
  url: string;
}

interface DiscordMentionsLike {
  has: (user: DiscordUserLike | null | undefined) => boolean;
}

interface DiscordReactionResolutionLike {
  me?: boolean;
  remove?: () => Promise<unknown>;
  users: {
    remove: (userId: string) => Promise<unknown>;
  };
}

interface DiscordReactionStoreLike {
  cache: Map<string, DiscordReactionResolutionLike>;
  resolve?: (emoji: string) => DiscordReactionResolutionLike | null;
}

interface DiscordFetchedMessageLike {
  id: string;
  content?: string | null;
  author?: DiscordUserLike;
  partial?: boolean;
  fetch?: () => Promise<DiscordFetchedMessageLike>;
  react: (emoji: string) => Promise<unknown>;
  reactions: DiscordReactionStoreLike;
}

interface DiscordThreadLike {
  id: string;
  name?: string | null;
}

interface DiscordChannelLike {
  name?: string | null;
  parentId?: string | null;
  isTextBased?: () => boolean;
  isThread?: () => boolean;
  send?: (options: string | Record<string, unknown>) => Promise<{ id: string }>;
  messages?: {
    fetch: (id: string) => Promise<DiscordFetchedMessageLike>;
  };
}

interface DiscordMessageLike extends DiscordFetchedMessageLike {
  channelId: string;
  guildId?: string | null;
  author: DiscordUserLike;
  member?: DiscordGuildMemberLike | null;
  channel: DiscordChannelLike;
  mentions: DiscordMentionsLike;
  attachments: Map<string, DiscordAttachmentLike>;
  createdTimestamp: number;
  startThread: (options: {
    name: string;
    reason?: string;
  }) => Promise<DiscordThreadLike>;
}

interface DiscordReactionLike {
  partial?: boolean;
  fetch: () => Promise<unknown>;
  message: DiscordMessageLike;
  emoji: {
    id?: string | null;
    name?: string | null;
    toString: () => string;
  };
}

interface DiscordEventHandlerMap {
  ready: () => DiscordEventHandlerResult;
  messageCreate: (message: DiscordMessageLike) => DiscordEventHandlerResult;
  messageReactionAdd: (
    reaction: DiscordReactionLike,
    user: DiscordUserLike,
  ) => DiscordEventHandlerResult;
  messageReactionRemove: (
    reaction: DiscordReactionLike,
    user: DiscordUserLike,
  ) => DiscordEventHandlerResult;
  error: (error: unknown) => DiscordEventHandlerResult;
}

interface DiscordClient {
  user?: DiscordUserLike | null;
  channels: {
    fetch: (id: string) => Promise<DiscordChannelLike | null>;
  };
  once<K extends keyof DiscordEventHandlerMap>(
    event: K,
    handler: DiscordEventHandlerMap[K],
  ): DiscordClient;
  on<K extends keyof DiscordEventHandlerMap>(
    event: K,
    handler: DiscordEventHandlerMap[K],
  ): DiscordClient;
  login: (token: string) => Promise<unknown>;
  destroy: () => void;
}

interface DiscordianRoute {
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

interface DiscordianRoutesFile {
  routes?: DiscordianRoute[];
}

type DiscordMessage = DiscordMessageLike;

const DISCORD_SPLIT_THRESHOLD = 1900;
const INGRESS_DEDUPE_TTL_MS = 60_000;
const INGRESS_DEDUPE_MAX = 2_000;
const LIFECYCLE_STATE_TTL_MS = 6 * 60 * 60 * 1000;
const LIFECYCLE_STATE_MAX = 2_000;
const DISCORD_LIFECYCLE_ERROR_TEXT_MAX = 1500;
const INITIAL_THREAD_HISTORY_LIMIT = 20;

function formatChannelLifecycleErrorMessage(errorText: string, options: { codeBlock?: boolean; maxLength?: number } = {}): string {
  const maxLength = options.maxLength ?? 1500;
  const normalized = String(errorText ?? "").trim() || "Unknown error";
  const truncated = normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized;
  if (!options.codeBlock) return truncated;
  return `Turn failed:\n\`\`\`\n${truncated.replace(/```/g, "``​`")}\n\`\`\``;
}

type LifecycleState = "queued" | "completed" | "error" | "cancelled";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDiscordTextChannel(
  channel: DiscordChannelLike | null,
): channel is DiscordChannelLike & {
  isTextBased: () => boolean;
} {
  return typeof channel?.isTextBased === "function" && channel.isTextBased();
}

function hasDiscordMessageFetcher(
  channel: DiscordChannelLike | null,
): channel is DiscordChannelLike & {
  isTextBased: () => boolean;
  messages: {
    fetch: (id: string) => Promise<DiscordFetchedMessageLike>;
  };
} {
  return (
    isDiscordTextChannel(channel) &&
    !!channel.messages &&
    typeof channel.messages.fetch === "function"
  );
}

function isDiscordSendableChannel(
  channel: DiscordChannelLike | null,
): channel is DiscordChannelLike & {
  isTextBased: () => boolean;
  send: (options: string | Record<string, unknown>) => Promise<{ id: string }>;
} {
  return isDiscordTextChannel(channel) && typeof channel.send === "function";
}

function splitMessageText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline boundary
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

function normalizeDiscordMentionText(
  text: string,
  botUserId: string | null,
): string {
  if (!botUserId) return text;
  return text.replace(new RegExp(`<@!?${botUserId}>\\s*`, "g"), "").trim();
}

function resolveDiscordChatType(
  guildId: string | null | undefined,
): "direct" | "channel" {
  return guildId ? "channel" : "direct";
}

/**
 * Resolve native emoji for Discord reactions.
 * Discord uses native Unicode emoji directly (not names like Slack).
 * Strip colons for common named patterns.
 */
function resolveDiscordReactionEmoji(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<:") || trimmed.startsWith("<a:")) {
    return trimmed;
  }
  const normalized = trimmed.replace(/^:+|:+$/g, "");
  // Common name-to-emoji mappings for parity with Slack lifecycle reactions
  const nameMap: Record<string, string> = {
    eyes: "👀",
    white_check_mark: "✅",
    x: "❌",
  };
  return nameMap[normalized] ?? normalized;
}

export function buildDiscordIngressMessageKey(
  accountId: string | undefined,
  messageId: string | undefined,
): string | null {
  if (!isNonEmptyString(accountId) || !isNonEmptyString(messageId)) {
    return null;
  }
  return `${accountId}:${messageId}`;
}

export function buildDiscordReplyOptions(
  replyToMessageId: string | undefined,
  channelId: string,
): { reply: { messageReference: string; failIfNotExists: false } } | undefined {
  const trimmed = replyToMessageId?.trim();
  if (!trimmed || trimmed === channelId) {
    return undefined;
  }
  return {
    reply: {
      messageReference: trimmed,
      failIfNotExists: false,
    },
  };
}

function formatDiscordLifecycleErrorMessage(errorText: string): string {
  return formatChannelLifecycleErrorMessage(errorText, {
    codeBlock: true,
    maxLength: DISCORD_LIFECYCLE_ERROR_TEXT_MAX,
  });
}

/**
 * Best-effort: post a user-facing error reply when forwarding a Discord
 * message to the agent runtime fails. Swallows any send failure so the
 * notification path can never crash the listener.
 */
async function notifyDiscordDeliveryError(
  message: DiscordMessageLike,
  error: unknown,
): Promise<void> {
  try {
    if (typeof message.channel.send !== "function") return;
    const reply = buildDiscordReplyOptions(message.id, message.channelId);
    await message.channel.send({
      allowedMentions: { parse: [] },
      content: formatDiscordDeliveryError(error),
      ...(reply ?? {}),
    });
  } catch (sendError) {
    console.error(
      "[Discord] Failed to forward delivery error to user:",
      sendError,
    );
  }
}

export async function resolveDiscordAccountDisplayName(
  token: string,
): Promise<string | undefined> {
  const discord = await loadDiscordModule();
  const client = new discord.Client({
    intents: [discord.GatewayIntentBits.Guilds],
  }) as DiscordClient;
  try {
    await client.login(token);
    const tag = client.user?.tag ?? client.user?.username;
    client.destroy();
    return tag ?? undefined;
  } catch {
    try {
      client.destroy();
    } catch {}
    return undefined;
  }
}

export function createDiscordAdapter(
  config,
) {
  let client: DiscordClient | null = null;
  let running = false;
  let botUserId: string | null = null;
  const seenIngressMessageKeys = new Map<string, number>();
  const lifecycleStateByMessageKey = new Map<
    string,
    { state: LifecycleState; updatedAt: number }
  >();
  const lifecycleOperationByMessageKey = new Map<string, Promise<void>>();
  const lifecycleErrorReplyKeys = new Map<string, number>();

  function pruneSeenIngressMessageKeys(now: number = Date.now()): void {
    for (const [key, expiresAt] of seenIngressMessageKeys) {
      if (expiresAt <= now) {
        seenIngressMessageKeys.delete(key);
      }
    }
    if (seenIngressMessageKeys.size <= INGRESS_DEDUPE_MAX) {
      return;
    }
    const oldestEntries = Array.from(seenIngressMessageKeys.entries()).sort(
      (a, b) => a[1] - b[1],
    );
    const overflowCount = seenIngressMessageKeys.size - INGRESS_DEDUPE_MAX;
    for (let index = 0; index < overflowCount; index += 1) {
      const entry = oldestEntries[index];
      if (entry) {
        seenIngressMessageKeys.delete(entry[0]);
      }
    }
  }

  function markIngressMessageSeen(messageId: string | undefined): boolean {
    const key = buildDiscordIngressMessageKey(config.accountId, messageId);
    if (!key) return false;
    const now = Date.now();
    pruneSeenIngressMessageKeys(now);
    if (seenIngressMessageKeys.has(key)) return true;
    seenIngressMessageKeys.set(key, now + INGRESS_DEDUPE_TTL_MS);
    return false;
  }

  function normalizedStringList(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter(
          (item: unknown): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
      : [];
  }

  function isSelfDiscordUser(user: DiscordUserLike): boolean {
    return !user.id || user.id === botUserId;
  }

  function isAllowedBotSender(
    user: DiscordUserLike,
    options: { respondToBots?: boolean; allowedBotIds?: unknown },
  ): boolean {
    if (!user.bot) return true;
    if (options.respondToBots !== true) return false;
    const allowedBotIds = normalizedStringList(options.allowedBotIds);
    if (allowedBotIds.length === 0) return true;
    return allowedBotIds.includes(user.id);
  }

  function shouldProcessDiscordDmSender(user: DiscordUserLike): boolean {
    if (isSelfDiscordUser(user)) return false;

    if (user.bot) {
      return isAllowedBotSender(user, {
        respondToBots: config.respondToBots,
        allowedBotIds: config.allowedBotIds,
      });
    }

    const discordianDmPolicy = config.discordianDmPolicy ?? config.dmPolicy;
    if (discordianDmPolicy === "allowlist") {
      return normalizedStringList(config.discordianAllowedUsers).includes(user.id);
    }

    return true;
  }

  function getLifecycleMessageKey(source): string | null {
    if (
      source.channel !== CHANNEL_ID ||
      !isNonEmptyString(source.chatId) ||
      !isNonEmptyString(source.messageId)
    ) {
      return null;
    }
    return `${source.chatId}:${source.messageId}`;
  }

  function getLifecycleReplyKey(source): string | null {
    if (source.channel !== CHANNEL_ID || !isNonEmptyString(source.chatId)) {
      return null;
    }
    return [
      source.chatId,
      source.threadId ?? source.messageId ?? "",
      source.conversationId,
    ].join(":");
  }

  function pruneLifecycleState(now: number = Date.now()): void {
    for (const [key, entry] of lifecycleStateByMessageKey) {
      if (entry.updatedAt + LIFECYCLE_STATE_TTL_MS <= now) {
        lifecycleStateByMessageKey.delete(key);
      }
    }
    for (const [key, updatedAt] of lifecycleErrorReplyKeys) {
      if (updatedAt + LIFECYCLE_STATE_TTL_MS <= now) {
        lifecycleErrorReplyKeys.delete(key);
      }
    }
    if (lifecycleStateByMessageKey.size <= LIFECYCLE_STATE_MAX) {
      return;
    }
    const oldestEntries = Array.from(lifecycleStateByMessageKey.entries()).sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt,
    );
    const overflowCount = lifecycleStateByMessageKey.size - LIFECYCLE_STATE_MAX;
    for (let index = 0; index < overflowCount; index += 1) {
      const entry = oldestEntries[index];
      if (entry) {
        lifecycleStateByMessageKey.delete(entry[0]);
      }
    }
  }

  function rememberLifecycleErrorReply(key: string): boolean {
    pruneLifecycleState();
    if (lifecycleErrorReplyKeys.has(key)) {
      return false;
    }
    if (lifecycleErrorReplyKeys.size >= LIFECYCLE_STATE_MAX) {
      const [oldestKey] = lifecycleErrorReplyKeys.keys();
      if (oldestKey) {
        lifecycleErrorReplyKeys.delete(oldestKey);
      }
    }
    lifecycleErrorReplyKeys.set(key, Date.now());
    return true;
  }

  function shouldSkipLifecycleReaction(source): boolean {
    // Adapter-private fields are not guaranteed to survive the generic
    // lifecycle path. Auto-threaded top-level guild messages can be recognized
    // after normalization because their starter message id is also the thread
    // id/chat id; reacting to that message from inside the thread yields
    // Discord's "Unknown Message". Thread replies still have distinct message
    // ids and continue to get lifecycle reactions.
    return (
      source.skipLifecycleReactions === true ||
      (isNonEmptyString(source.messageId) &&
        (source.threadId === source.messageId || source.chatId === source.messageId))
    );
  }

  async function sendLifecycleReaction(
    source,
    emoji: string,
    remove = false,
  ): Promise<void> {
    if (shouldSkipLifecycleReaction(source)) return;
    if (!client || !isNonEmptyString(source.messageId)) return;
    try {
      const reactionChannelId =
        source.lifecycleReactionChatId ?? source.chatId;
      const channel = await client.channels.fetch(reactionChannelId);
      if (!hasDiscordMessageFetcher(channel)) return;
      const message = await channel.messages.fetch(source.messageId);
      const resolvedEmoji = resolveDiscordReactionEmoji(emoji);
      if (remove) {
        const resolved =
          "resolve" in message.reactions &&
          typeof message.reactions.resolve === "function"
            ? message.reactions.resolve(resolvedEmoji)
            : null;
        if (resolved && botUserId) {
          await resolved.users.remove(botUserId);
        }
        return;
      }
      await message.react(resolvedEmoji);
    } catch (error) {
      console.warn(
        `[Discord] Failed to ${remove ? "remove" : "add"} lifecycle reaction:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  async function sendLifecycleErrorReply(
    source,
    errorText: string,
  ): Promise<void> {
    if (!client) return;
    const key = getLifecycleReplyKey(source);
    if (!key || !rememberLifecycleErrorReply(key)) {
      return;
    }

    const targetChannelId = source.threadId ?? source.chatId;
    const channel = await client.channels.fetch(targetChannelId);
    if (!isDiscordSendableChannel(channel)) {
      return;
    }
    const reply = buildDiscordReplyOptions(source.messageId, targetChannelId);
    await channel.send({
      allowedMentions: { parse: [] },
      content: formatDiscordLifecycleErrorMessage(errorText),
      ...(reply ?? {}),
    });
  }

  function scheduleLifecycleTransition(
    source,
    nextState: LifecycleState,
  ): Promise<void> | null {
    const key = getLifecycleMessageKey(source);
    if (!key) return null;
    const previous =
      lifecycleOperationByMessageKey.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        pruneLifecycleState();
        const currentState = lifecycleStateByMessageKey.get(key)?.state;
        if (currentState === nextState) {
          lifecycleStateByMessageKey.set(key, {
            state: nextState,
            updatedAt: Date.now(),
          });
          return;
        }
        if (nextState === "queued") {
          if (!currentState) {
            await sendLifecycleReaction(source, "eyes");
            lifecycleStateByMessageKey.set(key, {
              state: nextState,
              updatedAt: Date.now(),
            });
          }
          return;
        }
        if (currentState === "queued") {
          try {
            await sendLifecycleReaction(source, "eyes", true);
          } catch {}
        }
        await sendLifecycleReaction(
          source,
          nextState === "completed" ? "white_check_mark" : "x",
        );
        lifecycleStateByMessageKey.set(key, {
          state: nextState,
          updatedAt: Date.now(),
        });
      })
      .catch((error) => {
        console.warn(
          `[Discord] Failed to update lifecycle reaction for ${key}:`,
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        if (lifecycleOperationByMessageKey.get(key) === operation) {
          lifecycleOperationByMessageKey.delete(key);
        }
      });
    lifecycleOperationByMessageKey.set(key, operation);
    return operation;
  }

  function resolveDisplayName(message: DiscordMessage): string {
    return (
      (message.member?.displayName as string | undefined) ??
      message.author.globalName ??
      message.author.username ??
      message.author.id
    );
  }

  function hasBotMention(message: DiscordMessage): boolean {
    if (!client?.user) return false;
    return message.mentions.has(client.user);
  }

  function isThreadMessage(message: DiscordMessage): boolean {
    const ch = message.channel as { isThread?: () => boolean };
    return typeof ch.isThread === "function" && ch.isThread();
  }

  function isDiscordThreadAlreadyExistsError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes("thread has already been created");
  }

  async function createThreadForMessage(
    message: DiscordMessage,
    seedText: string,
  ): Promise<{ id: string; name?: string } | null> {
    const normalized = seedText.replace(/<@!?\d+>/g, "").trim();
    const firstLine = normalized.split("\n")[0]?.trim();
    const threadName = (
      firstLine || `${message.author.username} question`
    ).slice(0, 100);
    try {
      const thread = await message.startThread({
        name: threadName,
        reason: "letta-code discordian auto-thread",
      });
      return { id: thread.id, name: thread.name ?? undefined };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (isDiscordThreadAlreadyExistsError(error)) {
        const existingThread = await client?.channels
          .fetch(message.id)
          .catch(() => null);
        if (existingThread && "id" in existingThread) {
          return {
            id: existingThread.id,
            name:
              "name" in existingThread && typeof existingThread.name === "string"
                ? existingThread.name
                : undefined,
          };
        }
        return { id: message.id };
      }
      console.warn(
        "[Discord] Failed to create thread for message:",
        errorMessage,
      );
      return null;
    }
  }

  async function getDiscordianRoutes(): Promise<{
    routingPath: string;
    routes: DiscordianRoute[];
  }> {
    // Letta custom-channel routing files use JSON content in routing.yaml.
    const routingPath = join(
      process.env.HOME || ".",
      ".letta",
      "channels",
      CHANNEL_ID,
      "routing.yaml",
    );
    let routes: DiscordianRoute[] = [];
    try {
      const parsed = JSON.parse(
        await fs.readFile(routingPath, "utf8"),
      ) as DiscordianRoutesFile;
      routes = Array.isArray(parsed.routes) ? parsed.routes : [];
    } catch {}
    return { routingPath, routes };
  }

  async function saveDiscordianRoutes(
    routingPath: string,
    routes: DiscordianRoute[],
  ): Promise<void> {
    await fs.mkdir(dirname(routingPath), { recursive: true });
    await fs.writeFile(
      routingPath,
      JSON.stringify({ routes }, null, 2) + "\n",
      "utf8",
    );
  }

  async function ensureDiscordianChannelRoute(channelId: string): Promise<void> {
    if (!config.agentId) return;
    const { routingPath, routes } = await getDiscordianRoutes();
    const existingRoute = routes.find(
      (route) =>
        route.accountId === config.accountId &&
        route.chatId === channelId &&
        (route.threadId ?? null) === null &&
        route.enabled !== false,
    );
    if (existingRoute) return;

    const now = new Date().toISOString();
    const route = {
      accountId: config.accountId,
      chatId: channelId,
      chatType: "channel",
      threadId: null,
      agentId: config.agentId,
      conversationId:
        config.conversationId ?? process.env.LETTA_CONVERSATION_ID ?? "default",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    routes.push(route);
    await saveDiscordianRoutes(routingPath, routes);
    console.log(
      "[Discordian] Created channel route",
      JSON.stringify({
        accountId: config.accountId,
        channelId,
        agentId: route.agentId,
        conversationId: route.conversationId,
      }),
    );
  }

  async function ensureDiscordianThreadRoute(
    parentChannelId: string,
    threadId: string,
  ): Promise<void> {
    if (!config.agentId) return;
    const { routingPath, routes } = await getDiscordianRoutes();
    const existingExactRoute = routes.find(
      (route) =>
        route.accountId === config.accountId &&
        route.chatId === threadId &&
        route.threadId === threadId &&
        route.enabled !== false,
    );
    if (existingExactRoute) return;

    const incompleteThreadRoute = routes.find(
      (route) =>
        route.accountId === config.accountId &&
        route.chatId === threadId &&
        (route.threadId ?? null) === null &&
        route.enabled !== false,
    );
    if (incompleteThreadRoute) {
      incompleteThreadRoute.threadId = threadId;
      incompleteThreadRoute.chatType = incompleteThreadRoute.chatType ?? "channel";
      incompleteThreadRoute.updatedAt = new Date().toISOString();
      await saveDiscordianRoutes(routingPath, routes);
      console.log(
        "[Discordian] Migrated thread route",
        JSON.stringify({ accountId: config.accountId, parentChannelId, threadId }),
      );
      return;
    }
    const parentRoute = routes.find(
      (route) =>
        route.accountId === config.accountId &&
        route.chatId === parentChannelId &&
        (route.threadId ?? null) === null &&
        route.enabled !== false,
    );
    const now = new Date().toISOString();
    const route = {
      accountId: config.accountId,
      chatId: threadId,
      chatType: "channel",
      threadId,
      agentId: parentRoute?.agentId ?? config.agentId,
      conversationId:
        parentRoute?.conversationId ??
        config.conversationId ??
        process.env.LETTA_CONVERSATION_ID ??
        "default",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    routes.push(route);
    await saveDiscordianRoutes(routingPath, routes);
    console.log(
      "[Discordian] Created thread route",
      JSON.stringify({
        accountId: config.accountId,
        parentChannelId,
        threadId,
        agentId: route.agentId,
        conversationId: route.conversationId,
      }),
    );
  }

  async function collectAttachments(
    rawAttachments: Map<string, DiscordAttachmentLike>,
    chatId: string,
  ) {
    const list = Array.from(rawAttachments.values());
    if (list.length === 0) return [];
    return resolveDiscordInboundAttachments({
      accountId: config.accountId,
      rawAttachments: list.map((a) => ({
        id: a.id,
        name: a.name ?? null,
        contentType: a.contentType ?? null,
        size: a.size ?? 0,
        url: a.url,
      })),
      chatId,
    });
  }

  const adapter = {
    id: `${CHANNEL_ID}:${config.accountId}`,
    channelId: CHANNEL_ID,
    accountId: config.accountId,
    name: DISPLAY_NAME,

    async start(): Promise<void> {
      if (running) return;

      const discord: DiscordRuntimeModuleLike = await loadDiscordModule();
      const GatewayIntentBits = discord.GatewayIntentBits;
      const Partials = discord.Partials;

      client = new discord.Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildMessageReactions,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.DirectMessageReactions,
        ],
        partials: [
          Partials.Channel,
          Partials.Message,
          Partials.Reaction,
          Partials.User,
        ],
      }) as DiscordClient;

      client.once("ready", () => {
        botUserId = client?.user?.id ?? null;
        const tag = client?.user?.tag ?? "(unknown)";
        console.log(
          `[Discord] Bot logged in as ${tag} (dm_policy: ${config.dmPolicy})`,
        );
        running = true;
      });

      client.on("messageCreate", async (message: DiscordMessage) => {
        if (!adapter.onMessage) return;

        const content = (message.content ?? "").trim();
        const userId = message.author.id;
        if (!userId) return;

        const chatType = resolveDiscordChatType(message.guildId);
        const isThread = isThreadMessage(message);
        const wasMentioned = chatType === "channel" && hasBotMention(message);

        // ── DM handling ──────────────────────────────────────────
        if (chatType === "direct") {
          if (!shouldProcessDiscordDmSender(message.author)) {
            if (!message.author.bot) {
              await adapter.sendDirectReply(
                message.channelId,
                "You are not on the allowed users list for this Discordian bot.",
              );
            }
            return;
          }
          if (markIngressMessageSeen(message.id)) return;

          const attachments = await collectAttachments(
            message.attachments,
            message.channelId,
          );
          if (!content && (!attachments || attachments.length === 0)) return;

          const inbound = {
            channel: CHANNEL_ID,
            accountId: config.accountId,
            chatId: message.channelId,
            senderId: userId,
            senderName: resolveDisplayName(message),
            text: content,
            timestamp: message.createdTimestamp,
            messageId: message.id,
            threadId: null,
            chatType: "direct",
            isMention: false,
            attachments,
            raw: message,
          };

          try {
            await adapter.onMessage(inbound);
          } catch (error) {
            console.error("[Discord] Error handling DM:", error);
            await notifyDiscordDeliveryError(message, error);
          }
          return;
        }

        // ── Guild handling ────────────────────────────────────────
        // Per-channel policy separates trigger behavior from conversation
        // placement. Top-level messages must satisfy the trigger policy; thread
        // messages are surfaced when their parent channel is allowed and the
        // exact thread route exists or can be created.
        const parentChannelId =
          (message.channel as { parentId?: string | null }).parentId ?? null;
        const channelPolicy = resolveDiscordianEffectiveChannelConfig({
          channelId: message.channelId,
          parentChannelId,
          isThread,
          channels: config.channels,
          autoThreadOnMention: config.autoThreadOnMention,
          respondToBots: config.respondToBots,
          allowedBotIds: config.allowedBotIds,
          acknowledgeMessageReaction: config.acknowledgeMessageReaction,
        });
        if (!channelPolicy.allowed) return;
        if (isSelfDiscordUser(message.author)) return;
        if (
          message.author.bot &&
          !isAllowedBotSender(message.author, {
            respondToBots: channelPolicy.respondToBots,
            allowedBotIds: channelPolicy.allowedBotIds,
          })
        ) {
          return;
        }

        const shouldTrigger =
          isThread ||
          channelPolicy.trigger === "always" ||
          (channelPolicy.trigger === "mention" && wasMentioned);
        if (!shouldTrigger) return;

        if (markIngressMessageSeen(message.id)) return;

        let effectiveChatId = message.channelId;
        let effectiveThreadId: string | null = isThread
          ? message.channelId
          : null;

        // Place the conversation according to the per-channel policy. For
        // thread placement, persist a thread-specific route before emitting
        // inbound so the generic registry can find the newly-created thread
        // immediately. For channel placement, ensure a top-level channel route
        // exists when an agent_id is configured.
        const movedTopLevelMessageToThread =
          !isThread && channelPolicy.conversation === "thread";
        if (movedTopLevelMessageToThread) {
          const createdThread = await createThreadForMessage(message, content);
          if (!createdThread) return;
          effectiveChatId = createdThread.id;
          effectiveThreadId = createdThread.id;
          await ensureDiscordianThreadRoute(message.channelId, createdThread.id);
        } else if (!isThread && channelPolicy.conversation === "channel") {
          await ensureDiscordianChannelRoute(message.channelId);
        } else if (isThread && effectiveThreadId) {
          await ensureDiscordianThreadRoute(
            parentChannelId ?? message.channelId,
            effectiveThreadId,
          );
        }

        const attachments = await collectAttachments(
          message.attachments,
          effectiveChatId,
        );
        const normalizedText = wasMentioned
          ? normalizeDiscordMentionText(content, botUserId)
          : content;
        if (!normalizedText && (!attachments || attachments.length === 0))
          return;

        const inbound = {
          channel: CHANNEL_ID,
          accountId: config.accountId,
          chatId: effectiveChatId,
          senderId: userId,
          senderName: resolveDisplayName(message),
          chatLabel:
            "name" in message.channel
              ? (message.channel.name ?? undefined)
              : undefined,
          text: normalizedText,
          timestamp: message.createdTimestamp,
          messageId: message.id,
          threadId: effectiveThreadId,
          parentChannelId: isThread
            ? (parentChannelId ?? undefined)
            : message.channelId,
          chatType: "channel",
          isMention: wasMentioned,
          isOpenChannel: channelPolicy.trigger === "always",
          skipLifecycleReactions: movedTopLevelMessageToThread,
          attachments,
          raw: message,
        };

        try {
          await adapter.onMessage(inbound);
        } catch (error) {
          console.error("[Discord] Error handling guild message:", error);
          await notifyDiscordDeliveryError(message, error);
        }
      });

      // ── Reaction events ──────────────────────────────────────
      const handleReactionEvent = async (
        reaction: DiscordReactionLike,
        user: DiscordUserLike,
        action: "added" | "removed",
      ) => {
        if (!adapter.onMessage) return;
        if (isSelfDiscordUser(user)) return;

        try {
          if (reaction.partial) await reaction.fetch();
          if (reaction.message.partial) await reaction.message.fetch?.();
        } catch {
          return;
        }

        const msg = reaction.message;
        const channelId = msg.channelId;
        if (!channelId) return;

        const emoji = reaction.emoji.id
          ? reaction.emoji.toString()
          : (reaction.emoji.name ?? reaction.emoji.toString());
        if (!emoji) return;

        const chatType = resolveDiscordChatType(msg.guildId);
        const isThread =
          msg.channel &&
          "isThread" in msg.channel &&
          typeof msg.channel.isThread === "function" &&
          msg.channel.isThread();

        // In guilds, only react on messages in threads we're tracking
        if (chatType === "channel" && !isThread) return;

        let effectiveChannelConfig;
        if (chatType === "channel" && isThread) {
          effectiveChannelConfig = resolveDiscordianEffectiveChannelConfig({
            channelId,
            parentChannelId:
              (msg.channel as { parentId?: string | null }).parentId ?? null,
            isThread: true,
            channels: config.channels,
            autoThreadOnMention: config.autoThreadOnMention,
            respondToBots: config.respondToBots,
            allowedBotIds: config.allowedBotIds,
            acknowledgeMessageReaction: config.acknowledgeMessageReaction,
          });
          if (!effectiveChannelConfig.allowed) return;
          if (
            user.bot &&
            !isAllowedBotSender(user, {
              respondToBots: effectiveChannelConfig.respondToBots,
              allowedBotIds: effectiveChannelConfig.allowedBotIds,
            })
          ) {
            return;
          }
        } else if (user.bot) {
          if (
            !isAllowedBotSender(user, {
              respondToBots: config.respondToBots,
              allowedBotIds: config.allowedBotIds,
            })
          ) {
            return;
          }
        }

        const inbound = {
          channel: CHANNEL_ID,
          accountId: config.accountId,
          chatId: channelId,
          senderId: user.id,
          senderName: user.username ?? undefined,
          text: "",
          timestamp: Date.now(),
          messageId: msg.id,
          threadId: isThread ? channelId : null,
          chatType,
          isMention: false,
          reaction: {
            action,
            emoji,
            targetMessageId: msg.id,
            targetSenderId: msg.author?.id,
          },
          raw: { reaction, user },
        };

        try {
          await adapter.onMessage(inbound);
        } catch (error) {
          console.error(`[Discord] Error handling reaction ${action}:`, error);
        }
      };

      client.on(
        "messageReactionAdd",
        async (reaction: DiscordReactionLike, user: DiscordUserLike) => {
          await handleReactionEvent(reaction, user, "added");
        },
      );

      client.on(
        "messageReactionRemove",
        async (reaction: DiscordReactionLike, user: DiscordUserLike) => {
          await handleReactionEvent(reaction, user, "removed");
        },
      );

      client.on("error", (err: unknown) => {
        console.error("[Discord] Client error:", err);
      });

      await client.login(config.token);
    },

    async stop(): Promise<void> {
      if (!running || !client) return;
      client.destroy();
      client = null;
      running = false;
      botUserId = null;
      seenIngressMessageKeys.clear();
      lifecycleStateByMessageKey.clear();
      lifecycleOperationByMessageKey.clear();
      lifecycleErrorReplyKeys.clear();
      console.log("[Discord] Bot stopped");
    },

    isRunning(): boolean {
      return running;
    },

    async handleTurnLifecycleEvent(
      event: ChannelTurnLifecycleEvent,
    ): Promise<void> {
      if (!running) return;
      if (event.type === "queued") {
        await scheduleLifecycleTransition(event.source, "queued");
        return;
      }
      if (event.type === "processing") return;
      const nextState: LifecycleState =
        event.outcome === "completed"
          ? "completed"
          : event.outcome === "cancelled"
            ? "cancelled"
            : "error";
      await Promise.all(
        event.sources.map((source) =>
          scheduleLifecycleTransition(source, nextState),
        ),
      );

      const errorText = event.outcome === "error" ? event.error?.trim() : null;
      if (!errorText) return;

      const uniqueReplySources = new Map();
      for (const source of event.sources) {
        const key = getLifecycleReplyKey(source);
        if (!key || uniqueReplySources.has(key)) continue;
        uniqueReplySources.set(key, source);
      }

      await Promise.all(
        Array.from(uniqueReplySources.values()).map(async (source) => {
          try {
            await sendLifecycleErrorReply(source, errorText);
          } catch (error) {
            console.warn(
              `[Discord] Failed to post lifecycle error for ${source.chatId}:`,
              error instanceof Error ? error.message : error,
            );
          }
        }),
      );
    },

    async sendMessage(
      msg,
    ): Promise<{ messageId: string }> {
      if (!client) throw new Error("Discord not started");

      // Handle reactions
      if (msg.reaction) {
        const targetMessageId = msg.targetMessageId ?? msg.replyToMessageId;
        if (!targetMessageId) {
          throw new Error("Discord reactions require a target message ID.");
        }
        const emoji = resolveDiscordReactionEmoji(msg.reaction);
        const targetChannelId = msg.threadId ?? msg.chatId;
        const channel = await client.channels.fetch(targetChannelId);
        if (!hasDiscordMessageFetcher(channel)) {
          throw new Error(
            `Discord channel not found or not text-based: ${targetChannelId}`,
          );
        }
        const message = await channel.messages.fetch(targetMessageId);
        if (msg.removeReaction) {
          const resolved = message.reactions.resolve?.(emoji) ?? null;
          if (resolved && botUserId) {
            await resolved.users.remove(botUserId);
          }
        } else {
          await message.react(emoji);
        }
        return { messageId: targetMessageId };
      }

      // Handle file uploads
      if (msg.mediaPath) {
        const targetChannelId = msg.threadId ?? msg.chatId;
        const channel = await client.channels.fetch(targetChannelId);
        if (!isDiscordSendableChannel(channel)) {
          throw new Error(
            `Discord channel not found or not text-based: ${targetChannelId}`,
          );
        }
        const reply = buildDiscordReplyOptions(
          msg.replyToMessageId,
          targetChannelId,
        );
        const result = await channel.send({
          content: msg.text?.trim() || undefined,
          ...(reply ?? {}),
          files: [
            {
              attachment: msg.mediaPath,
              name: msg.fileName ?? basename(msg.mediaPath),
            },
          ],
        });
        return { messageId: result.id };
      }

      // Handle text messages
      const targetChannelId = msg.threadId ?? msg.chatId;
      const channel = await client.channels.fetch(targetChannelId);
      if (!isDiscordSendableChannel(channel)) {
        throw new Error(
          `Discord channel not found or not text-based: ${targetChannelId}`,
        );
      }
      const reply = buildDiscordReplyOptions(
        msg.replyToMessageId,
        targetChannelId,
      );
      const chunks = splitMessageText(msg.text, DISCORD_SPLIT_THRESHOLD);
      let lastMessageId = "";
      for (const chunk of chunks) {
        const result = await channel.send({
          content: chunk,
          ...(reply ?? {}),
        });
        lastMessageId = result.id;
      }
      return { messageId: lastMessageId };
    },

    async sendDirectReply(
      chatId: string,
      text: string,
      options?: { replyToMessageId?: string },
    ): Promise<void> {
      if (!client) throw new Error("Discord not started");
      const channel = await client.channels.fetch(chatId);
      if (!isDiscordSendableChannel(channel)) {
        return;
      }
      const reply = buildDiscordReplyOptions(options?.replyToMessageId, chatId);
      await channel.send({
        content: text,
        ...(reply ?? {}),
      });
    },

    async prepareInboundMessage(
      msg,
      options?: { isFirstRouteTurn?: boolean },
    ) {
      if (
        !options?.isFirstRouteTurn ||
        msg.channel !== CHANNEL_ID ||
        msg.chatType !== "channel" ||
        !isNonEmptyString(msg.threadId) ||
        !client
      ) {
        return msg;
      }

      const starter = await resolveDiscordThreadStarter({
        client,
        threadChannelId: msg.threadId,
      });
      const history = await resolveDiscordThreadHistory({
        client,
        threadChannelId: msg.threadId,
        currentMessageId: msg.messageId,
        limit: INITIAL_THREAD_HISTORY_LIMIT,
      });

      if (!starter && history.length === 0) {
        return msg;
      }

      const label = msg.chatLabel
        ? `Discord thread in ${msg.chatLabel}`
        : `Discord thread ${msg.chatId}`;

      return {
        ...msg,
        threadContext: {
          label,
          ...(starter
            ? {
                starter: {
                  messageId: starter.id,
                  senderId: starter.userId ?? starter.botId,
                  text: starter.text,
                },
              }
            : {}),
          ...(history.length > 0
            ? {
                history: history.map((entry) => ({
                  messageId: entry.id,
                  senderId: entry.userId ?? entry.botId,
                  text: entry.text,
                })),
              }
            : {}),
        },
      };
    },

    onMessage: undefined,
  };

  return adapter;
}
