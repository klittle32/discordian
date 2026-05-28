import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  resolveDiscordianEffectiveChannelConfig,
} from "./channel-gating";
import { formatDiscordDeliveryError } from "./error-reply";
import {
  resolveDiscordInboundAttachments,
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
  hasThread?: boolean;
  thread?: { id?: string | null } | null;
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
  sendTyping?: () => Promise<unknown>;
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

interface LettaConversationCreateResponse {
  id?: string;
}

type DiscordianRouteLockKey = string;

// Mirrors first-party Letta Code channel conversation creation. The current
// bundled value is empty, but keep the field explicit so parity is obvious and
// easy to update if Letta Code exposes non-empty isolated labels later.
const DISCORDIAN_ISOLATED_BLOCK_LABELS: string[] = [];

function normalizeLettaBaseUrl(): string {
  const raw = process.env.LETTA_BASE_URL || "https://api.letta.com";
  return raw.replace(/\/+$/, "");
}

function resolveLettaApiKey(config: Record<string, unknown>): string | null {
  const envValue = process.env.DISCORDIAN_LETTA_API_KEY;
  if (envValue && envValue.trim().length > 0) {
    return envValue.trim();
  }
  const configured = config.discordianLettaApiKey ?? config.discordian_letta_api_key;
  return typeof configured === "string" && configured.trim().length > 0
    ? configured.trim()
    : null;
}

function buildDiscordianConversationSummary(input: {
  chatKind: "channel" | "thread" | "direct";
  discordChatId: string;
  parentChannelId?: string | null;
}): string {
  if (input.chatKind === "thread") {
    return input.parentChannelId
      ? `Discordian thread ${input.discordChatId} in channel ${input.parentChannelId}`
      : `Discordian thread ${input.discordChatId}`;
  }
  if (input.chatKind === "direct") {
    return `Discordian DM ${input.discordChatId}`;
  }
  return `Discordian channel ${input.discordChatId}`;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type DiscordMessage = DiscordMessageLike;

const DISCORD_SPLIT_THRESHOLD = 1900;
const INGRESS_DEDUPE_TTL_MS = 60_000;
const INGRESS_DEDUPE_MAX = 2_000;
const LIFECYCLE_STATE_TTL_MS = 6 * 60 * 60 * 1000;
const LIFECYCLE_STATE_MAX = 2_000;
const DISCORD_LIFECYCLE_ERROR_TEXT_MAX = 1500;
const THREAD_STARTER_REFETCH_DELAY_MS = 750;
const DISCORD_TYPING_INDICATOR_DEFAULT = true;
const DISCORD_TYPING_REFRESH_MS_DEFAULT = 8_000;
const DISCORD_TYPING_REFRESH_MS_MIN = 3_000;
const DISCORD_TYPING_REFRESH_MS_MAX = 30_000;
const DISCORD_TYPING_MAX_MS_DEFAULT = 10 * 60 * 1000;
const DISCORD_TYPING_MAX_MS_MIN = 30_000;
const DISCORD_TYPING_MAX_MS_MAX = 60 * 60 * 1000;

type DiscordTypingTargetId = string;
type DiscordTypingSourceKey = string;

interface DiscordTypingState {
  sourceKeys: Set<DiscordTypingSourceKey>;
  timer: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
}

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

function isDiscordTypingChannel(
  channel: DiscordChannelLike | null,
): channel is DiscordChannelLike & {
  sendTyping: () => Promise<unknown>;
} {
  return isDiscordTextChannel(channel) && typeof channel.sendTyping === "function";
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function resolveBooleanConfig(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolveMillisecondsConfig(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return clampNumber(Math.round(numeric), min, max);
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
  const discordianRouteLocks = new Map<DiscordianRouteLockKey, Promise<void>>();
  const typingByChatId = new Map<DiscordTypingTargetId, DiscordTypingState>();
  const typingIndicatorEnabled = resolveBooleanConfig(
    config.typingIndicator ?? config.typing_indicator,
    DISCORD_TYPING_INDICATOR_DEFAULT,
  );
  const typingRefreshMs = resolveMillisecondsConfig(
    config.typingIndicatorRefreshMs ?? config.typing_indicator_refresh_ms,
    DISCORD_TYPING_REFRESH_MS_DEFAULT,
    DISCORD_TYPING_REFRESH_MS_MIN,
    DISCORD_TYPING_REFRESH_MS_MAX,
  );
  const typingMaxMs = resolveMillisecondsConfig(
    config.typingIndicatorMaxMs ?? config.typing_indicator_max_ms,
    DISCORD_TYPING_MAX_MS_DEFAULT,
    DISCORD_TYPING_MAX_MS_MIN,
    DISCORD_TYPING_MAX_MS_MAX,
  );

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

  function getTypingTargetId(source): string | null {
    if (source.channel !== CHANNEL_ID) return null;
    const targetId = source.threadId ?? source.chatId;
    return isNonEmptyString(targetId) ? targetId : null;
  }

  function getTypingSourceKey(source): DiscordTypingSourceKey | null {
    const targetId = getTypingTargetId(source);
    if (!targetId) return null;
    return [
      source.accountId ?? "",
      source.channel ?? "",
      source.chatId ?? "",
      source.threadId ?? "",
      source.messageId ?? "",
      source.agentId ?? "",
      source.conversationId ?? "",
    ].join(":");
  }

  async function sendTypingAction(targetChannelId: string): Promise<void> {
    if (!running || !client) return;
    try {
      const channel = await client.channels.fetch(targetChannelId);
      if (!isDiscordTypingChannel(channel)) return;
      await channel.sendTyping();
    } catch (error) {
      console.warn(
        `[Discord] Failed to send typing indicator for ${targetChannelId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  function clearTypingForChat(targetChannelId: string): void {
    const entry = typingByChatId.get(targetChannelId);
    if (!entry) return;
    clearInterval(entry.timer);
    clearTimeout(entry.timeout);
    typingByChatId.delete(targetChannelId);
  }

  function clearAllTyping(): void {
    for (const entry of typingByChatId.values()) {
      clearInterval(entry.timer);
      clearTimeout(entry.timeout);
    }
    typingByChatId.clear();
  }

  function startTypingForSource(source): void {
    if (!typingIndicatorEnabled) return;
    const targetId = getTypingTargetId(source);
    const sourceKey = getTypingSourceKey(source);
    if (!targetId || !sourceKey) return;

    const existing = typingByChatId.get(targetId);
    if (existing) {
      existing.sourceKeys.add(sourceKey);
      return;
    }

    void sendTypingAction(targetId);
    const timer = setInterval(() => {
      void sendTypingAction(targetId);
    }, typingRefreshMs);
    const timeout = setTimeout(() => {
      clearTypingForChat(targetId);
    }, typingMaxMs);
    timer.unref?.();
    timeout.unref?.();

    typingByChatId.set(targetId, {
      sourceKeys: new Set([sourceKey]),
      timer,
      timeout,
    });
  }

  function stopTypingForSource(source): void {
    const targetId = getTypingTargetId(source);
    const sourceKey = getTypingSourceKey(source);
    if (!targetId || !sourceKey) return;
    const entry = typingByChatId.get(targetId);
    if (!entry) return;
    entry.sourceKeys.delete(sourceKey);
    if (entry.sourceKeys.size === 0) {
      clearTypingForChat(targetId);
    }
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

  function isDiscordThreadStarterMessage(message: DiscordFetchedMessageLike): boolean {
    return message.hasThread === true || Boolean(message.thread?.id);
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function isParentChannelThreadStarterMessage(message: DiscordMessage): Promise<boolean> {
    if (isDiscordThreadStarterMessage(message)) return true;
    try {
      await sleep(THREAD_STARTER_REFETCH_DELAY_MS);
      const fetched = await message.channel.messages?.fetch(message.id);
      return fetched ? isDiscordThreadStarterMessage(fetched) : false;
    } catch (error) {
      console.warn(
        "[Discordian] Failed to refetch possible thread starter",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
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
    const tmpPath = `${routingPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(
      tmpPath,
      JSON.stringify({ routes }, null, 2) + "\n",
      "utf8",
    );
    await fs.rename(tmpPath, routingPath);
  }

  async function runDiscordianRouteLocked(
    key: DiscordianRouteLockKey,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = discordianRouteLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    discordianRouteLocks.set(key, next);
    try {
      await next;
    } finally {
      if (discordianRouteLocks.get(key) === next) {
        discordianRouteLocks.delete(key);
      }
    }
  }

  async function createDiscordianConversationRouteTarget(input: {
    agentId: string;
    chatKind: "channel" | "thread" | "direct";
    discordChatId: string;
    parentChannelId?: string | null;
  }): Promise<string> {
    const apiKey = resolveLettaApiKey(config);
    if (!apiKey) {
      throw new Error(
        "Cannot create Discordian route conversation: missing DISCORDIAN_LETTA_API_KEY or config.discordian_letta_api_key",
      );
    }

    const baseUrl = normalizeLettaBaseUrl();
    const url = new URL(`${baseUrl}/v1/conversations/`);
    url.searchParams.set("agent_id", input.agentId);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        isolated_block_labels: DISCORDIAN_ISOLATED_BLOCK_LABELS,
        summary: buildDiscordianConversationSummary(input),
      }),
    });

    if (!response.ok) {
      let details = response.statusText;
      try {
        details = await response.text();
      } catch {}
      throw new Error(
        `Letta conversation creation failed (${response.status}): ${details}`,
      );
    }

    const conversation = await response.json() as LettaConversationCreateResponse;
    if (!conversation.id) {
      throw new Error("Letta conversation creation returned no conversation id");
    }
    return conversation.id;
  }

  async function ensureDiscordianChannelRoute(channelId: string): Promise<void> {
    if (!config.agentId) return;
    // Route creation is a read/modify/write of one routing file. Serialize all
    // Discordian route mutations in-process, not just identical chat ids, so
    // concurrent first messages in different channels/threads do not overwrite
    // each other's newly-added routes.
    const lockKey = `${config.accountId}:routes`;
    await runDiscordianRouteLocked(lockKey, async () => {
      const { routingPath, routes } = await getDiscordianRoutes();
      const existingRoute = routes.find(
        (route) =>
          route.accountId === config.accountId &&
          route.chatId === channelId &&
          (route.threadId ?? null) === null &&
          route.enabled !== false,
      );
      if (existingRoute) return;

      let conversationId: string;
      try {
        conversationId = await createDiscordianConversationRouteTarget({
          agentId: config.agentId,
          chatKind: "channel",
          discordChatId: channelId,
        });
      } catch (error) {
        console.error(
          "[Discordian] Failed to create channel route conversation",
          JSON.stringify({
            accountId: config.accountId,
            channelId,
            agentId: config.agentId,
            baseUrl: normalizeLettaBaseUrl(),
            error: asErrorMessage(error),
          }),
        );
        throw error;
      }

      const now = new Date().toISOString();
      const route = {
        accountId: config.accountId,
        chatId: channelId,
        chatType: "channel",
        threadId: null,
        agentId: config.agentId,
        conversationId,
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
    });
  }

  async function ensureDiscordianDirectRoute(chatId: string): Promise<void> {
    if (!config.agentId) return;
    // Direct-message chats need a persisted route before the first inbound DM is
    // forwarded, otherwise the generic custom-channel registry reports that the
    // chat is not connected to a Letta agent yet.
    const lockKey = `${config.accountId}:routes`;
    await runDiscordianRouteLocked(lockKey, async () => {
      const { routingPath, routes } = await getDiscordianRoutes();
      const existingRoute = routes.find(
        (route) =>
          route.accountId === config.accountId &&
          route.chatId === chatId &&
          (route.threadId ?? null) === null &&
          route.enabled !== false,
      );
      if (existingRoute) return;

      let conversationId: string;
      try {
        conversationId = await createDiscordianConversationRouteTarget({
          agentId: config.agentId,
          chatKind: "direct",
          discordChatId: chatId,
        });
      } catch (error) {
        console.error(
          "[Discordian] Failed to create DM route conversation",
          JSON.stringify({
            accountId: config.accountId,
            chatId,
            agentId: config.agentId,
            baseUrl: normalizeLettaBaseUrl(),
            error: asErrorMessage(error),
          }),
        );
        throw error;
      }

      const now = new Date().toISOString();
      const route = {
        accountId: config.accountId,
        chatId,
        chatType: "direct",
        threadId: null,
        agentId: config.agentId,
        conversationId,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };
      routes.push(route);
      await saveDiscordianRoutes(routingPath, routes);
      console.log(
        "[Discordian] Created DM route",
        JSON.stringify({
          accountId: config.accountId,
          chatId,
          agentId: route.agentId,
          conversationId: route.conversationId,
        }),
      );
    });
  }

  async function ensureDiscordianThreadRoute(
    parentChannelId: string,
    threadId: string,
  ): Promise<void> {
    if (!config.agentId) return;
    // Route creation is a read/modify/write of one routing file. Serialize all
    // Discordian route mutations in-process, not just identical chat ids, so
    // concurrent first messages in different channels/threads do not overwrite
    // each other's newly-added routes.
    const lockKey = `${config.accountId}:routes`;
    await runDiscordianRouteLocked(lockKey, async () => {
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

      let conversationId: string;
      try {
        conversationId = await createDiscordianConversationRouteTarget({
          agentId: config.agentId,
          chatKind: "thread",
          discordChatId: threadId,
          parentChannelId,
        });
      } catch (error) {
        console.error(
          "[Discordian] Failed to create thread route conversation",
          JSON.stringify({
            accountId: config.accountId,
            parentChannelId,
            threadId,
            agentId: config.agentId,
            baseUrl: normalizeLettaBaseUrl(),
            error: asErrorMessage(error),
          }),
        );
        throw error;
      }

      const now = new Date().toISOString();
      const route = {
        accountId: config.accountId,
        chatId: threadId,
        chatType: "channel",
        threadId,
        agentId: config.agentId,
        conversationId,
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
    });
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
          await ensureDiscordianDirectRoute(message.channelId);

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

        // Discord emits the thread starter as a normal parent-channel message
        // and then emits subsequent messages inside the thread. `hasThread` may
        // not be populated immediately on the messageCreate payload, so briefly
        // refetch before allowing a top-level channel route to answer. Let the
        // actual thread message path create/use the thread route instead.
        if (!isThread && (await isParentChannelThreadStarterMessage(message))) {
          console.log(
            "[Discordian] Ignoring parent-channel thread starter",
            JSON.stringify({
              accountId: config.accountId,
              channelId: message.channelId,
              messageId: message.id,
              threadId: message.thread?.id ?? message.id,
            }),
          );
          return;
        }

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
          console.log(
            "[Discordian] Moved top-level message into thread route",
            JSON.stringify({
              accountId: config.accountId,
              parentChannelId: message.channelId,
              messageId: message.id,
              threadId: createdThread.id,
            }),
          );
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
      clearAllTyping();
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
      if (event.type === "processing") {
        for (const source of event.sources) {
          startTypingForSource(source);
        }
        return;
      }
      for (const source of event.sources) {
        stopTypingForSource(source);
      }
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
        clearTypingForChat(targetChannelId);
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
        clearTypingForChat(targetChannelId);
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
      clearTypingForChat(targetChannelId);
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
      // Discordian creates a fresh Letta conversation for every new Discord
      // channel/thread route. Do not hydrate the first turn with Discord thread
      // starter/history; the triggering inbound message should be the new
      // conversation's first user message.
      return msg;
    },

    onMessage: undefined,
  };

  return adapter;
}
