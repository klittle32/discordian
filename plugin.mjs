var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// transcription-stub.mjs
var exports_transcription_stub = {};
__export(exports_transcription_stub, {
  transcribeAudioFile: () => transcribeAudioFile,
  isTranscriptionConfigured: () => isTranscriptionConfigured
});
function isTranscriptionConfigured() {
  return false;
}
async function transcribeAudioFile() {
  return { success: false, text: "" };
}

// adapter.ts
import { promises as fs } from "node:fs";
import { basename, dirname as dirname2, join as join3 } from "node:path";

// channel-gating.ts
function resolveGateChannelId(channelId, parentChannelId, isThread) {
  return isThread ? parentChannelId ?? channelId : channelId;
}
function isChannelMap(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function defaultMentionConversation(autoThreadOnMention) {
  return autoThreadOnMention === false ? "channel" : "thread";
}
function defaultConversation(trigger, autoThreadOnMention) {
  return trigger === "mention" ? defaultMentionConversation(autoThreadOnMention) : "channel";
}
function isTrigger(value) {
  return value === "mention" || value === "always" || value === "never";
}
function isConversation(value) {
  return value === "channel" || value === "thread";
}
function isBoolean(value) {
  return typeof value === "boolean";
}
function normalizedStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim().length > 0) : [];
}
function resolveChannelEntry(channels, gateChannelId) {
  if (!isChannelMap(channels))
    return {};
  const exact = channels[gateChannelId];
  if (isChannelMap(exact))
    return exact;
  const wildcard = channels["*"];
  if (isChannelMap(wildcard))
    return wildcard;
  return {};
}
function resolveChannelPolicy(entry, autoThreadOnMention) {
  if (entry.enabled === false) {
    return { allowed: false, trigger: "never", conversation: "channel" };
  }
  const trigger = isTrigger(entry.trigger) ? entry.trigger : "mention";
  const conversation = isConversation(entry.conversation) ? entry.conversation : defaultConversation(trigger, autoThreadOnMention);
  return {
    allowed: trigger !== "never",
    trigger,
    conversation
  };
}
function resolveDiscordianEffectiveChannelConfig(params) {
  const {
    channelId,
    parentChannelId,
    isThread,
    channels,
    autoThreadOnMention,
    respondToBots,
    allowedBotIds,
    acknowledgeMessageReaction
  } = params;
  const gateChannelId = resolveGateChannelId(channelId, parentChannelId, isThread);
  const channelEntry = resolveChannelEntry(channels, gateChannelId);
  const policy = resolveChannelPolicy(channelEntry, autoThreadOnMention);
  return {
    ...policy,
    respondToBots: isBoolean(channelEntry.respond_to_bots) ? channelEntry.respond_to_bots : respondToBots === true,
    allowedBotIds: Array.isArray(channelEntry.allowed_bot_ids) ? normalizedStringList(channelEntry.allowed_bot_ids) : normalizedStringList(allowedBotIds),
    acknowledgeMessageReaction: isBoolean(channelEntry.acknowledge_message_reaction) ? channelEntry.acknowledge_message_reaction : acknowledgeMessageReaction === true
  };
}

// error-reply.ts
function readTrimmedString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
function escapeDiscordInlineCode(value) {
  return value.replace(/`/g, "\\`").replace(/\r?\n/g, " ");
}
function extractErrorDetail(error) {
  const e = error;
  return readTrimmedString(e?.error?.error?.detail) || readTrimmedString(e?.error?.error?.message) || readTrimmedString(e?.error?.detail) || readTrimmedString(e?.error?.message) || readTrimmedString(e?.message) || String(error);
}
function formatDiscordDeliveryError(error) {
  const status = error?.status;
  const detail = extractErrorDetail(error);
  if (status === 404 && /Agent with ID .* not found/i.test(detail)) {
    return "Sorry, I couldn't deliver your message — the agent I'm bound to " + "wasn't found. The operator needs to rebind this bot with " + "`letta channels bind --channel discord --agent <id>`.";
  }
  if (status === 401 || status === 403) {
    return "Sorry, I couldn't deliver your message — my Letta API credentials " + "were rejected. The operator needs to check the API key.";
  }
  const MAX_DETAIL = 200;
  const truncated = detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail;
  const safeDetail = escapeDiscordInlineCode(truncated);
  return `Sorry, something went wrong while forwarding your message: \`${safeDetail}\``;
}

// media.ts
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
var DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 15000;
var DISCORD_ATTACHMENTS_DIR = join(tmpdir(), "letta-discord-attachments");
var MAX_DISCORD_ATTACHMENT_BYTES = 20 * 1024 * 1024;
function ensureAttachmentsDir() {
  mkdirSync(DISCORD_ATTACHMENTS_DIR, { recursive: true });
  return DISCORD_ATTACHMENTS_DIR;
}
function sanitizeDiscordPathSegment(input) {
  const cleaned = input.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "attachment";
}
function resolveAttachmentKind(contentType) {
  if (!contentType)
    return "file";
  if (contentType.startsWith("image/"))
    return "image";
  if (contentType.startsWith("audio/"))
    return "audio";
  if (contentType.startsWith("video/"))
    return "video";
  return "file";
}
async function resolveDiscordInboundAttachments(params) {
  if (params.rawAttachments.length === 0) {
    return [];
  }
  const dir = ensureAttachmentsDir();
  const results = [];
  for (const attachment of params.rawAttachments) {
    const name = attachment.name ?? `attachment-${attachment.id}`;
    const kind = resolveAttachmentKind(attachment.contentType);
    const localFileName = [
      Date.now(),
      randomUUID(),
      sanitizeDiscordPathSegment(params.accountId),
      sanitizeDiscordPathSegment(params.chatId),
      sanitizeDiscordPathSegment(attachment.id),
      sanitizeDiscordPathSegment(name)
    ].join("-");
    const localPath = join(dir, localFileName);
    try {
      const controller = new AbortController;
      const timeout = setTimeout(() => controller.abort(), DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
      const response = await fetch(attachment.url, {
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) {
        console.warn(`[Discord] Failed to download attachment ${name}: HTTP ${response.status}`);
        continue;
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        const parsedLength = Number(contentLength);
        if (Number.isFinite(parsedLength) && parsedLength > MAX_DISCORD_ATTACHMENT_BYTES) {
          console.warn(`[Discord] Skipping oversized attachment ${name}: ${parsedLength} bytes`);
          continue;
        }
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_DISCORD_ATTACHMENT_BYTES) {
        console.warn(`[Discord] Skipping oversized attachment ${name}: ${buffer.byteLength} bytes`);
        continue;
      }
      await writeFile(localPath, buffer);
      const entry = {
        id: attachment.id,
        name,
        mimeType: attachment.contentType ?? undefined,
        sizeBytes: attachment.size,
        kind,
        localPath
      };
      if (kind === "image" && attachment.contentType?.startsWith("image/")) {
        entry.imageDataBase64 = buffer.toString("base64");
      }
      if (kind === "audio" && params.transcribeVoice) {
        const { isTranscriptionConfigured: isTranscriptionConfigured2, transcribeAudioFile: transcribeAudioFile2 } = await Promise.resolve().then(() => exports_transcription_stub);
        if (isTranscriptionConfigured2()) {
          const result = await transcribeAudioFile2(localPath);
          if (result.success && result.text) {
            entry.transcription = result.text;
          }
        }
      }
      results.push(entry);
    } catch (error) {
      console.warn(`[Discord] Failed to download attachment ${name}:`, error instanceof Error ? error.message : error);
    }
  }
  return results;
}

// runtime.mjs
import { createRequire } from "node:module";
import { dirname, join as join2 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var CHANNEL_ID = "discordian";
var DISPLAY_NAME = "Discordian";
var __dirname2 = dirname(fileURLToPath(import.meta.url));
async function loadDiscordModule() {
  const require2 = createRequire(import.meta.url);
  const candidates = [
    join2(__dirname2, "runtime", "package.json"),
    join2(__dirname2, "package.json")
  ];
  for (const candidate of candidates) {
    try {
      const resolved = createRequire(candidate).resolve("discord.js");
      return import(pathToFileURL(resolved).href);
    } catch {}
  }
  try {
    const resolved = require2.resolve("discord.js");
    return import(pathToFileURL(resolved).href);
  } catch {
    throw new Error("Discordian support is not installed. Run: letta channels install discordian");
  }
}

// adapter.ts
var DISCORDIAN_ISOLATED_BLOCK_LABELS = [];
function normalizeLettaBaseUrl() {
  const raw = process.env.LETTA_BASE_URL || "https://api.letta.com";
  return raw.replace(/\/+$/, "");
}
function resolveLettaApiKey(config) {
  const envValue = process.env.DISCORDIAN_LETTA_API_KEY;
  if (envValue && envValue.trim().length > 0) {
    return envValue.trim();
  }
  const configured = config.discordianLettaApiKey ?? config.discordian_letta_api_key;
  return typeof configured === "string" && configured.trim().length > 0 ? configured.trim() : null;
}
function buildDiscordianConversationSummary(input) {
  if (input.chatKind === "thread") {
    return input.parentChannelId ? `Discordian thread ${input.discordChatId} in channel ${input.parentChannelId}` : `Discordian thread ${input.discordChatId}`;
  }
  if (input.chatKind === "direct") {
    return `Discordian DM ${input.discordChatId}`;
  }
  return `Discordian channel ${input.discordChatId}`;
}
function asErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
var DISCORD_SPLIT_THRESHOLD = 1900;
var INGRESS_DEDUPE_TTL_MS = 60000;
var INGRESS_DEDUPE_MAX = 2000;
var LIFECYCLE_STATE_TTL_MS = 6 * 60 * 60 * 1000;
var LIFECYCLE_STATE_MAX = 2000;
var DISCORD_LIFECYCLE_ERROR_TEXT_MAX = 1500;
var THREAD_STARTER_REFETCH_DELAY_MS = 750;
var DISCORD_TYPING_INDICATOR_DEFAULT = true;
var DISCORD_TYPING_REFRESH_MS_DEFAULT = 8000;
var DISCORD_TYPING_REFRESH_MS_MIN = 3000;
var DISCORD_TYPING_REFRESH_MS_MAX = 30000;
var DISCORD_TYPING_MAX_MS_DEFAULT = 10 * 60 * 1000;
var DISCORD_TYPING_MAX_MS_MIN = 30000;
var DISCORD_TYPING_MAX_MS_MAX = 60 * 60 * 1000;
function formatChannelLifecycleErrorMessage(errorText, options = {}) {
  const maxLength = options.maxLength ?? 1500;
  const normalized = String(errorText ?? "").trim() || "Unknown error";
  const truncated = normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1).trimEnd()}…` : normalized;
  if (!options.codeBlock)
    return truncated;
  return `Turn failed:
\`\`\`
${truncated.replace(/```/g, "``​`")}
\`\`\``;
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isDiscordTextChannel(channel) {
  return typeof channel?.isTextBased === "function" && channel.isTextBased();
}
function hasDiscordMessageFetcher(channel) {
  return isDiscordTextChannel(channel) && !!channel.messages && typeof channel.messages.fetch === "function";
}
function isDiscordSendableChannel(channel) {
  return isDiscordTextChannel(channel) && typeof channel.send === "function";
}
function isDiscordTypingChannel(channel) {
  return isDiscordTextChannel(channel) && typeof channel.sendTyping === "function";
}
function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
function resolveBooleanConfig(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function resolveMillisecondsConfig(value, fallback, min, max) {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim().length > 0 ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return clampNumber(Math.round(numeric), min, max);
}
function splitMessageText(text, maxLength) {
  if (text.length <= maxLength) {
    return [text];
  }
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf(`
`, maxLength);
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
function normalizeDiscordMentionText(text, botUserId) {
  if (!botUserId)
    return text;
  return text.replace(new RegExp(`<@!?${botUserId}>\\s*`, "g"), "").trim();
}
function resolveDiscordChatType(guildId) {
  return guildId ? "channel" : "direct";
}
function resolveDiscordReactionEmoji(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("<:") || trimmed.startsWith("<a:")) {
    return trimmed;
  }
  const normalized = trimmed.replace(/^:+|:+$/g, "");
  const nameMap = {
    eyes: "\uD83D\uDC40",
    white_check_mark: "✅",
    x: "❌"
  };
  return nameMap[normalized] ?? normalized;
}
function buildDiscordIngressMessageKey(accountId, messageId) {
  if (!isNonEmptyString(accountId) || !isNonEmptyString(messageId)) {
    return null;
  }
  return `${accountId}:${messageId}`;
}
function buildDiscordReplyOptions(replyToMessageId, channelId) {
  const trimmed = replyToMessageId?.trim();
  if (!trimmed || trimmed === channelId) {
    return;
  }
  return {
    reply: {
      messageReference: trimmed,
      failIfNotExists: false
    }
  };
}
function formatDiscordLifecycleErrorMessage(errorText) {
  return formatChannelLifecycleErrorMessage(errorText, {
    codeBlock: true,
    maxLength: DISCORD_LIFECYCLE_ERROR_TEXT_MAX
  });
}
async function notifyDiscordDeliveryError(message, error) {
  try {
    if (typeof message.channel.send !== "function")
      return;
    const reply = buildDiscordReplyOptions(message.id, message.channelId);
    await message.channel.send({
      allowedMentions: { parse: [] },
      content: formatDiscordDeliveryError(error),
      ...reply ?? {}
    });
  } catch (sendError) {
    console.error("[Discord] Failed to forward delivery error to user:", sendError);
  }
}
function createDiscordAdapter(config) {
  let client = null;
  let running = false;
  let botUserId = null;
  const seenIngressMessageKeys = new Map;
  const lifecycleStateByMessageKey = new Map;
  const lifecycleOperationByMessageKey = new Map;
  const lifecycleErrorReplyKeys = new Map;
  const discordianRouteLocks = new Map;
  const typingByChatId = new Map;
  const typingIndicatorEnabled = resolveBooleanConfig(config.typingIndicator ?? config.typing_indicator, DISCORD_TYPING_INDICATOR_DEFAULT);
  const typingRefreshMs = resolveMillisecondsConfig(config.typingIndicatorRefreshMs ?? config.typing_indicator_refresh_ms, DISCORD_TYPING_REFRESH_MS_DEFAULT, DISCORD_TYPING_REFRESH_MS_MIN, DISCORD_TYPING_REFRESH_MS_MAX);
  const typingMaxMs = resolveMillisecondsConfig(config.typingIndicatorMaxMs ?? config.typing_indicator_max_ms, DISCORD_TYPING_MAX_MS_DEFAULT, DISCORD_TYPING_MAX_MS_MIN, DISCORD_TYPING_MAX_MS_MAX);
  function pruneSeenIngressMessageKeys(now = Date.now()) {
    for (const [key, expiresAt] of seenIngressMessageKeys) {
      if (expiresAt <= now) {
        seenIngressMessageKeys.delete(key);
      }
    }
    if (seenIngressMessageKeys.size <= INGRESS_DEDUPE_MAX) {
      return;
    }
    const oldestEntries = Array.from(seenIngressMessageKeys.entries()).sort((a, b) => a[1] - b[1]);
    const overflowCount = seenIngressMessageKeys.size - INGRESS_DEDUPE_MAX;
    for (let index = 0;index < overflowCount; index += 1) {
      const entry = oldestEntries[index];
      if (entry) {
        seenIngressMessageKeys.delete(entry[0]);
      }
    }
  }
  function markIngressMessageSeen(messageId) {
    const key = buildDiscordIngressMessageKey(config.accountId, messageId);
    if (!key)
      return false;
    const now = Date.now();
    pruneSeenIngressMessageKeys(now);
    if (seenIngressMessageKeys.has(key))
      return true;
    seenIngressMessageKeys.set(key, now + INGRESS_DEDUPE_TTL_MS);
    return false;
  }
  function normalizedStringList2(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim().length > 0) : [];
  }
  function isSelfDiscordUser(user) {
    return !user.id || user.id === botUserId;
  }
  function isAllowedBotSender(user, options) {
    if (!user.bot)
      return true;
    if (options.respondToBots !== true)
      return false;
    const allowedBotIds = normalizedStringList2(options.allowedBotIds);
    if (allowedBotIds.length === 0)
      return true;
    return allowedBotIds.includes(user.id);
  }
  function shouldProcessDiscordDmSender(user) {
    if (isSelfDiscordUser(user))
      return false;
    if (user.bot) {
      return isAllowedBotSender(user, {
        respondToBots: config.respondToBots,
        allowedBotIds: config.allowedBotIds
      });
    }
    const discordianDmPolicy = config.discordianDmPolicy ?? config.dmPolicy;
    if (discordianDmPolicy === "allowlist") {
      return normalizedStringList2(config.discordianAllowedUsers).includes(user.id);
    }
    return true;
  }
  function getLifecycleMessageKey(source) {
    if (source.channel !== CHANNEL_ID || !isNonEmptyString(source.chatId) || !isNonEmptyString(source.messageId)) {
      return null;
    }
    return `${source.chatId}:${source.messageId}`;
  }
  function getLifecycleReplyKey(source) {
    if (source.channel !== CHANNEL_ID || !isNonEmptyString(source.chatId)) {
      return null;
    }
    return [
      source.chatId,
      source.threadId ?? source.messageId ?? "",
      source.conversationId
    ].join(":");
  }
  function getTypingTargetId(source) {
    if (source.channel !== CHANNEL_ID)
      return null;
    const targetId = source.threadId ?? source.chatId;
    return isNonEmptyString(targetId) ? targetId : null;
  }
  function getTypingSourceKey(source) {
    const targetId = getTypingTargetId(source);
    if (!targetId)
      return null;
    return [
      source.accountId ?? "",
      source.channel ?? "",
      source.chatId ?? "",
      source.threadId ?? "",
      source.messageId ?? "",
      source.agentId ?? "",
      source.conversationId ?? ""
    ].join(":");
  }
  async function sendTypingAction(targetChannelId) {
    if (!running || !client)
      return;
    try {
      const channel = await client.channels.fetch(targetChannelId);
      if (!isDiscordTypingChannel(channel))
        return;
      await channel.sendTyping();
    } catch (error) {
      console.warn(`[Discord] Failed to send typing indicator for ${targetChannelId}:`, error instanceof Error ? error.message : error);
    }
  }
  function clearTypingForChat(targetChannelId) {
    const entry = typingByChatId.get(targetChannelId);
    if (!entry)
      return;
    clearInterval(entry.timer);
    clearTimeout(entry.timeout);
    typingByChatId.delete(targetChannelId);
  }
  function clearAllTyping() {
    for (const entry of typingByChatId.values()) {
      clearInterval(entry.timer);
      clearTimeout(entry.timeout);
    }
    typingByChatId.clear();
  }
  function startTypingForSource(source) {
    if (!typingIndicatorEnabled)
      return;
    const targetId = getTypingTargetId(source);
    const sourceKey = getTypingSourceKey(source);
    if (!targetId || !sourceKey)
      return;
    const existing = typingByChatId.get(targetId);
    if (existing) {
      existing.sourceKeys.add(sourceKey);
      return;
    }
    sendTypingAction(targetId);
    const timer = setInterval(() => {
      sendTypingAction(targetId);
    }, typingRefreshMs);
    const timeout = setTimeout(() => {
      clearTypingForChat(targetId);
    }, typingMaxMs);
    timer.unref?.();
    timeout.unref?.();
    typingByChatId.set(targetId, {
      sourceKeys: new Set([sourceKey]),
      timer,
      timeout
    });
  }
  function stopTypingForSource(source) {
    const targetId = getTypingTargetId(source);
    const sourceKey = getTypingSourceKey(source);
    if (!targetId || !sourceKey)
      return;
    const entry = typingByChatId.get(targetId);
    if (!entry)
      return;
    entry.sourceKeys.delete(sourceKey);
    if (entry.sourceKeys.size === 0) {
      clearTypingForChat(targetId);
    }
  }
  function pruneLifecycleState(now = Date.now()) {
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
    const oldestEntries = Array.from(lifecycleStateByMessageKey.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const overflowCount = lifecycleStateByMessageKey.size - LIFECYCLE_STATE_MAX;
    for (let index = 0;index < overflowCount; index += 1) {
      const entry = oldestEntries[index];
      if (entry) {
        lifecycleStateByMessageKey.delete(entry[0]);
      }
    }
  }
  function rememberLifecycleErrorReply(key) {
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
  function shouldSkipLifecycleReaction(source) {
    return source.skipLifecycleReactions === true || isNonEmptyString(source.messageId) && (source.threadId === source.messageId || source.chatId === source.messageId);
  }
  async function sendLifecycleReaction(source, emoji, remove = false) {
    if (shouldSkipLifecycleReaction(source))
      return;
    if (!client || !isNonEmptyString(source.messageId))
      return;
    try {
      const reactionChannelId = source.lifecycleReactionChatId ?? source.chatId;
      const channel = await client.channels.fetch(reactionChannelId);
      if (!hasDiscordMessageFetcher(channel))
        return;
      const message = await channel.messages.fetch(source.messageId);
      const resolvedEmoji = resolveDiscordReactionEmoji(emoji);
      if (remove) {
        const resolved = "resolve" in message.reactions && typeof message.reactions.resolve === "function" ? message.reactions.resolve(resolvedEmoji) : null;
        if (resolved && botUserId) {
          await resolved.users.remove(botUserId);
        }
        return;
      }
      await message.react(resolvedEmoji);
    } catch (error) {
      console.warn(`[Discord] Failed to ${remove ? "remove" : "add"} lifecycle reaction:`, error instanceof Error ? error.message : error);
    }
  }
  async function sendLifecycleErrorReply(source, errorText) {
    if (!client)
      return;
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
      ...reply ?? {}
    });
  }
  function scheduleLifecycleTransition(source, nextState) {
    const key = getLifecycleMessageKey(source);
    if (!key)
      return null;
    const previous = lifecycleOperationByMessageKey.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      pruneLifecycleState();
      const currentState = lifecycleStateByMessageKey.get(key)?.state;
      if (currentState === nextState) {
        lifecycleStateByMessageKey.set(key, {
          state: nextState,
          updatedAt: Date.now()
        });
        return;
      }
      if (nextState === "queued") {
        if (!currentState) {
          await sendLifecycleReaction(source, "eyes");
          lifecycleStateByMessageKey.set(key, {
            state: nextState,
            updatedAt: Date.now()
          });
        }
        return;
      }
      if (currentState === "queued") {
        try {
          await sendLifecycleReaction(source, "eyes", true);
        } catch {}
      }
      await sendLifecycleReaction(source, nextState === "completed" ? "white_check_mark" : "x");
      lifecycleStateByMessageKey.set(key, {
        state: nextState,
        updatedAt: Date.now()
      });
    }).catch((error) => {
      console.warn(`[Discord] Failed to update lifecycle reaction for ${key}:`, error instanceof Error ? error.message : error);
    }).finally(() => {
      if (lifecycleOperationByMessageKey.get(key) === operation) {
        lifecycleOperationByMessageKey.delete(key);
      }
    });
    lifecycleOperationByMessageKey.set(key, operation);
    return operation;
  }
  function resolveDisplayName(message) {
    return message.member?.displayName ?? message.author.globalName ?? message.author.username ?? message.author.id;
  }
  function hasBotMention(message) {
    if (!client?.user)
      return false;
    return message.mentions.has(client.user);
  }
  function isThreadMessage(message) {
    const ch = message.channel;
    return typeof ch.isThread === "function" && ch.isThread();
  }
  function isDiscordThreadStarterMessage(message) {
    return message.hasThread === true || Boolean(message.thread?.id);
  }
  async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  async function isParentChannelThreadStarterMessage(message) {
    if (isDiscordThreadStarterMessage(message))
      return true;
    try {
      await sleep(THREAD_STARTER_REFETCH_DELAY_MS);
      const fetched = await message.channel.messages?.fetch(message.id);
      return fetched ? isDiscordThreadStarterMessage(fetched) : false;
    } catch (error) {
      console.warn("[Discordian] Failed to refetch possible thread starter", error instanceof Error ? error.message : error);
      return false;
    }
  }
  function isDiscordThreadAlreadyExistsError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes("thread has already been created");
  }
  async function createThreadForMessage(message, seedText) {
    const normalized = seedText.replace(/<@!?\d+>/g, "").trim();
    const firstLine = normalized.split(`
`)[0]?.trim();
    const threadName = (firstLine || `${message.author.username} question`).slice(0, 100);
    try {
      const thread = await message.startThread({
        name: threadName,
        reason: "letta-code discordian auto-thread"
      });
      return { id: thread.id, name: thread.name ?? undefined };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (isDiscordThreadAlreadyExistsError(error)) {
        const existingThread = await client?.channels.fetch(message.id).catch(() => null);
        if (existingThread && "id" in existingThread) {
          return {
            id: existingThread.id,
            name: "name" in existingThread && typeof existingThread.name === "string" ? existingThread.name : undefined
          };
        }
        return { id: message.id };
      }
      console.warn("[Discord] Failed to create thread for message:", errorMessage);
      return null;
    }
  }
  async function getDiscordianRoutes() {
    const routingPath = join3(process.env.HOME || ".", ".letta", "channels", CHANNEL_ID, "routing.yaml");
    let routes = [];
    try {
      const parsed = JSON.parse(await fs.readFile(routingPath, "utf8"));
      routes = Array.isArray(parsed.routes) ? parsed.routes : [];
    } catch {}
    return { routingPath, routes };
  }
  async function saveDiscordianRoutes(routingPath, routes) {
    await fs.mkdir(dirname2(routingPath), { recursive: true });
    const tmpPath = `${routingPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify({ routes }, null, 2) + `
`, "utf8");
    await fs.rename(tmpPath, routingPath);
  }
  async function runDiscordianRouteLocked(key, operation) {
    const previous = discordianRouteLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {
      return;
    }).then(operation);
    discordianRouteLocks.set(key, next);
    try {
      await next;
    } finally {
      if (discordianRouteLocks.get(key) === next) {
        discordianRouteLocks.delete(key);
      }
    }
  }
  async function createDiscordianConversationRouteTarget(input) {
    const apiKey = resolveLettaApiKey(config);
    if (!apiKey) {
      throw new Error("Cannot create Discordian route conversation: missing DISCORDIAN_LETTA_API_KEY or config.discordian_letta_api_key");
    }
    const baseUrl = normalizeLettaBaseUrl();
    const url = new URL(`${baseUrl}/v1/conversations/`);
    url.searchParams.set("agent_id", input.agentId);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        isolated_block_labels: DISCORDIAN_ISOLATED_BLOCK_LABELS,
        summary: buildDiscordianConversationSummary(input)
      })
    });
    if (!response.ok) {
      let details = response.statusText;
      try {
        details = await response.text();
      } catch {}
      throw new Error(`Letta conversation creation failed (${response.status}): ${details}`);
    }
    const conversation = await response.json();
    if (!conversation.id) {
      throw new Error("Letta conversation creation returned no conversation id");
    }
    return conversation.id;
  }
  async function ensureDiscordianChannelRoute(channelId) {
    if (!config.agentId)
      return;
    const lockKey = `${config.accountId}:routes`;
    await runDiscordianRouteLocked(lockKey, async () => {
      const { routingPath, routes } = await getDiscordianRoutes();
      const existingRoute = routes.find((route2) => route2.accountId === config.accountId && route2.chatId === channelId && (route2.threadId ?? null) === null && route2.enabled !== false);
      if (existingRoute)
        return;
      let conversationId;
      try {
        conversationId = await createDiscordianConversationRouteTarget({
          agentId: config.agentId,
          chatKind: "channel",
          discordChatId: channelId
        });
      } catch (error) {
        console.error("[Discordian] Failed to create channel route conversation", JSON.stringify({
          accountId: config.accountId,
          channelId,
          agentId: config.agentId,
          baseUrl: normalizeLettaBaseUrl(),
          error: asErrorMessage(error)
        }));
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
        updatedAt: now
      };
      routes.push(route);
      await saveDiscordianRoutes(routingPath, routes);
      console.log("[Discordian] Created channel route", JSON.stringify({
        accountId: config.accountId,
        channelId,
        agentId: route.agentId,
        conversationId: route.conversationId
      }));
    });
  }
  async function ensureDiscordianDirectRoute(chatId) {
    if (!config.agentId)
      return;
    const lockKey = `${config.accountId}:routes`;
    await runDiscordianRouteLocked(lockKey, async () => {
      const { routingPath, routes } = await getDiscordianRoutes();
      const existingRoute = routes.find((route2) => route2.accountId === config.accountId && route2.chatId === chatId && (route2.threadId ?? null) === null && route2.enabled !== false);
      if (existingRoute)
        return;
      let conversationId;
      try {
        conversationId = await createDiscordianConversationRouteTarget({
          agentId: config.agentId,
          chatKind: "direct",
          discordChatId: chatId
        });
      } catch (error) {
        console.error("[Discordian] Failed to create DM route conversation", JSON.stringify({
          accountId: config.accountId,
          chatId,
          agentId: config.agentId,
          baseUrl: normalizeLettaBaseUrl(),
          error: asErrorMessage(error)
        }));
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
        updatedAt: now
      };
      routes.push(route);
      await saveDiscordianRoutes(routingPath, routes);
      console.log("[Discordian] Created DM route", JSON.stringify({
        accountId: config.accountId,
        chatId,
        agentId: route.agentId,
        conversationId: route.conversationId
      }));
    });
  }
  async function ensureDiscordianThreadRoute(parentChannelId, threadId) {
    if (!config.agentId)
      return;
    const lockKey = `${config.accountId}:routes`;
    await runDiscordianRouteLocked(lockKey, async () => {
      const { routingPath, routes } = await getDiscordianRoutes();
      const existingExactRoute = routes.find((route2) => route2.accountId === config.accountId && route2.chatId === threadId && route2.threadId === threadId && route2.enabled !== false);
      if (existingExactRoute)
        return;
      const incompleteThreadRoute = routes.find((route2) => route2.accountId === config.accountId && route2.chatId === threadId && (route2.threadId ?? null) === null && route2.enabled !== false);
      if (incompleteThreadRoute) {
        incompleteThreadRoute.threadId = threadId;
        incompleteThreadRoute.chatType = incompleteThreadRoute.chatType ?? "channel";
        incompleteThreadRoute.updatedAt = new Date().toISOString();
        await saveDiscordianRoutes(routingPath, routes);
        console.log("[Discordian] Migrated thread route", JSON.stringify({ accountId: config.accountId, parentChannelId, threadId }));
        return;
      }
      let conversationId;
      try {
        conversationId = await createDiscordianConversationRouteTarget({
          agentId: config.agentId,
          chatKind: "thread",
          discordChatId: threadId,
          parentChannelId
        });
      } catch (error) {
        console.error("[Discordian] Failed to create thread route conversation", JSON.stringify({
          accountId: config.accountId,
          parentChannelId,
          threadId,
          agentId: config.agentId,
          baseUrl: normalizeLettaBaseUrl(),
          error: asErrorMessage(error)
        }));
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
        updatedAt: now
      };
      routes.push(route);
      await saveDiscordianRoutes(routingPath, routes);
      console.log("[Discordian] Created thread route", JSON.stringify({
        accountId: config.accountId,
        parentChannelId,
        threadId,
        agentId: route.agentId,
        conversationId: route.conversationId
      }));
    });
  }
  async function collectAttachments(rawAttachments, chatId) {
    const list = Array.from(rawAttachments.values());
    if (list.length === 0)
      return [];
    return resolveDiscordInboundAttachments({
      accountId: config.accountId,
      rawAttachments: list.map((a) => ({
        id: a.id,
        name: a.name ?? null,
        contentType: a.contentType ?? null,
        size: a.size ?? 0,
        url: a.url
      })),
      chatId
    });
  }
  const adapter = {
    id: `${CHANNEL_ID}:${config.accountId}`,
    channelId: CHANNEL_ID,
    accountId: config.accountId,
    name: DISPLAY_NAME,
    async start() {
      if (running)
        return;
      const discord = await loadDiscordModule();
      const GatewayIntentBits = discord.GatewayIntentBits;
      const Partials = discord.Partials;
      client = new discord.Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildMessageReactions,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.DirectMessageReactions
        ],
        partials: [
          Partials.Channel,
          Partials.Message,
          Partials.Reaction,
          Partials.User
        ]
      });
      client.once("ready", () => {
        botUserId = client?.user?.id ?? null;
        const tag = client?.user?.tag ?? "(unknown)";
        console.log(`[Discord] Bot logged in as ${tag} (dm_policy: ${config.dmPolicy})`);
        running = true;
      });
      client.on("messageCreate", async (message) => {
        if (!adapter.onMessage)
          return;
        const content = (message.content ?? "").trim();
        const userId = message.author.id;
        if (!userId)
          return;
        const chatType = resolveDiscordChatType(message.guildId);
        const isThread = isThreadMessage(message);
        const wasMentioned = chatType === "channel" && hasBotMention(message);
        if (chatType === "direct") {
          if (!shouldProcessDiscordDmSender(message.author)) {
            if (!message.author.bot) {
              await adapter.sendDirectReply(message.channelId, "You are not on the allowed users list for this Discordian bot.");
            }
            return;
          }
          if (markIngressMessageSeen(message.id))
            return;
          await ensureDiscordianDirectRoute(message.channelId);
          const attachments2 = await collectAttachments(message.attachments, message.channelId);
          if (!content && (!attachments2 || attachments2.length === 0))
            return;
          const inbound2 = {
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
            attachments: attachments2,
            raw: message
          };
          try {
            await adapter.onMessage(inbound2);
          } catch (error) {
            console.error("[Discord] Error handling DM:", error);
            await notifyDiscordDeliveryError(message, error);
          }
          return;
        }
        const parentChannelId = message.channel.parentId ?? null;
        const channelPolicy = resolveDiscordianEffectiveChannelConfig({
          channelId: message.channelId,
          parentChannelId,
          isThread,
          channels: config.channels,
          autoThreadOnMention: config.autoThreadOnMention,
          respondToBots: config.respondToBots,
          allowedBotIds: config.allowedBotIds,
          acknowledgeMessageReaction: config.acknowledgeMessageReaction
        });
        if (!channelPolicy.allowed)
          return;
        if (isSelfDiscordUser(message.author))
          return;
        if (message.author.bot && !isAllowedBotSender(message.author, {
          respondToBots: channelPolicy.respondToBots,
          allowedBotIds: channelPolicy.allowedBotIds
        })) {
          return;
        }
        const shouldTrigger = isThread || channelPolicy.trigger === "always" || channelPolicy.trigger === "mention" && wasMentioned;
        if (!shouldTrigger)
          return;
        if (!isThread && await isParentChannelThreadStarterMessage(message)) {
          console.log("[Discordian] Ignoring parent-channel thread starter", JSON.stringify({
            accountId: config.accountId,
            channelId: message.channelId,
            messageId: message.id,
            threadId: message.thread?.id ?? message.id
          }));
          return;
        }
        if (markIngressMessageSeen(message.id))
          return;
        let effectiveChatId = message.channelId;
        let effectiveThreadId = isThread ? message.channelId : null;
        const movedTopLevelMessageToThread = !isThread && channelPolicy.conversation === "thread";
        if (movedTopLevelMessageToThread) {
          const createdThread = await createThreadForMessage(message, content);
          if (!createdThread)
            return;
          effectiveChatId = createdThread.id;
          effectiveThreadId = createdThread.id;
          await ensureDiscordianThreadRoute(message.channelId, createdThread.id);
          console.log("[Discordian] Moved top-level message into thread route", JSON.stringify({
            accountId: config.accountId,
            parentChannelId: message.channelId,
            messageId: message.id,
            threadId: createdThread.id
          }));
        } else if (!isThread && channelPolicy.conversation === "channel") {
          await ensureDiscordianChannelRoute(message.channelId);
        } else if (isThread && effectiveThreadId) {
          await ensureDiscordianThreadRoute(parentChannelId ?? message.channelId, effectiveThreadId);
        }
        const attachments = await collectAttachments(message.attachments, effectiveChatId);
        const normalizedText = wasMentioned ? normalizeDiscordMentionText(content, botUserId) : content;
        if (!normalizedText && (!attachments || attachments.length === 0))
          return;
        const inbound = {
          channel: CHANNEL_ID,
          accountId: config.accountId,
          chatId: effectiveChatId,
          senderId: userId,
          senderName: resolveDisplayName(message),
          chatLabel: "name" in message.channel ? message.channel.name ?? undefined : undefined,
          text: normalizedText,
          timestamp: message.createdTimestamp,
          messageId: message.id,
          threadId: effectiveThreadId,
          parentChannelId: isThread ? parentChannelId ?? undefined : message.channelId,
          chatType: "channel",
          isMention: wasMentioned,
          isOpenChannel: channelPolicy.trigger === "always",
          skipLifecycleReactions: movedTopLevelMessageToThread,
          attachments,
          raw: message
        };
        try {
          await adapter.onMessage(inbound);
        } catch (error) {
          console.error("[Discord] Error handling guild message:", error);
          await notifyDiscordDeliveryError(message, error);
        }
      });
      const handleReactionEvent = async (reaction, user, action) => {
        if (!adapter.onMessage)
          return;
        if (isSelfDiscordUser(user))
          return;
        try {
          if (reaction.partial)
            await reaction.fetch();
          if (reaction.message.partial)
            await reaction.message.fetch?.();
        } catch {
          return;
        }
        const msg = reaction.message;
        const channelId = msg.channelId;
        if (!channelId)
          return;
        const emoji = reaction.emoji.id ? reaction.emoji.toString() : reaction.emoji.name ?? reaction.emoji.toString();
        if (!emoji)
          return;
        const chatType = resolveDiscordChatType(msg.guildId);
        const isThread = msg.channel && "isThread" in msg.channel && typeof msg.channel.isThread === "function" && msg.channel.isThread();
        if (chatType === "channel" && !isThread)
          return;
        let effectiveChannelConfig;
        if (chatType === "channel" && isThread) {
          effectiveChannelConfig = resolveDiscordianEffectiveChannelConfig({
            channelId,
            parentChannelId: msg.channel.parentId ?? null,
            isThread: true,
            channels: config.channels,
            autoThreadOnMention: config.autoThreadOnMention,
            respondToBots: config.respondToBots,
            allowedBotIds: config.allowedBotIds,
            acknowledgeMessageReaction: config.acknowledgeMessageReaction
          });
          if (!effectiveChannelConfig.allowed)
            return;
          if (user.bot && !isAllowedBotSender(user, {
            respondToBots: effectiveChannelConfig.respondToBots,
            allowedBotIds: effectiveChannelConfig.allowedBotIds
          })) {
            return;
          }
        } else if (user.bot) {
          if (!isAllowedBotSender(user, {
            respondToBots: config.respondToBots,
            allowedBotIds: config.allowedBotIds
          })) {
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
            targetSenderId: msg.author?.id
          },
          raw: { reaction, user }
        };
        try {
          await adapter.onMessage(inbound);
        } catch (error) {
          console.error(`[Discord] Error handling reaction ${action}:`, error);
        }
      };
      client.on("messageReactionAdd", async (reaction, user) => {
        await handleReactionEvent(reaction, user, "added");
      });
      client.on("messageReactionRemove", async (reaction, user) => {
        await handleReactionEvent(reaction, user, "removed");
      });
      client.on("error", (err) => {
        console.error("[Discord] Client error:", err);
      });
      await client.login(config.token);
    },
    async stop() {
      if (!running || !client)
        return;
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
    isRunning() {
      return running;
    },
    async handleTurnLifecycleEvent(event) {
      if (!running)
        return;
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
      const nextState = event.outcome === "completed" ? "completed" : event.outcome === "cancelled" ? "cancelled" : "error";
      await Promise.all(event.sources.map((source) => scheduleLifecycleTransition(source, nextState)));
      const errorText = event.outcome === "error" ? event.error?.trim() : null;
      if (!errorText)
        return;
      const uniqueReplySources = new Map;
      for (const source of event.sources) {
        const key = getLifecycleReplyKey(source);
        if (!key || uniqueReplySources.has(key))
          continue;
        uniqueReplySources.set(key, source);
      }
      await Promise.all(Array.from(uniqueReplySources.values()).map(async (source) => {
        try {
          await sendLifecycleErrorReply(source, errorText);
        } catch (error) {
          console.warn(`[Discord] Failed to post lifecycle error for ${source.chatId}:`, error instanceof Error ? error.message : error);
        }
      }));
    },
    async sendMessage(msg) {
      if (!client)
        throw new Error("Discord not started");
      if (msg.reaction) {
        const targetMessageId = msg.targetMessageId ?? msg.replyToMessageId;
        if (!targetMessageId) {
          throw new Error("Discord reactions require a target message ID.");
        }
        const emoji = resolveDiscordReactionEmoji(msg.reaction);
        const targetChannelId2 = msg.threadId ?? msg.chatId;
        clearTypingForChat(targetChannelId2);
        const channel2 = await client.channels.fetch(targetChannelId2);
        if (!hasDiscordMessageFetcher(channel2)) {
          throw new Error(`Discord channel not found or not text-based: ${targetChannelId2}`);
        }
        const message = await channel2.messages.fetch(targetMessageId);
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
      if (msg.mediaPath) {
        const targetChannelId2 = msg.threadId ?? msg.chatId;
        const channel2 = await client.channels.fetch(targetChannelId2);
        if (!isDiscordSendableChannel(channel2)) {
          throw new Error(`Discord channel not found or not text-based: ${targetChannelId2}`);
        }
        const reply2 = buildDiscordReplyOptions(msg.replyToMessageId, targetChannelId2);
        clearTypingForChat(targetChannelId2);
        const result = await channel2.send({
          content: msg.text?.trim() || undefined,
          ...reply2 ?? {},
          files: [
            {
              attachment: msg.mediaPath,
              name: msg.fileName ?? basename(msg.mediaPath)
            }
          ]
        });
        return { messageId: result.id };
      }
      const targetChannelId = msg.threadId ?? msg.chatId;
      const channel = await client.channels.fetch(targetChannelId);
      if (!isDiscordSendableChannel(channel)) {
        throw new Error(`Discord channel not found or not text-based: ${targetChannelId}`);
      }
      const reply = buildDiscordReplyOptions(msg.replyToMessageId, targetChannelId);
      clearTypingForChat(targetChannelId);
      const chunks = splitMessageText(msg.text, DISCORD_SPLIT_THRESHOLD);
      let lastMessageId = "";
      for (const chunk of chunks) {
        const result = await channel.send({
          content: chunk,
          ...reply ?? {}
        });
        lastMessageId = result.id;
      }
      return { messageId: lastMessageId };
    },
    async sendDirectReply(chatId, text, options) {
      if (!client)
        throw new Error("Discord not started");
      const channel = await client.channels.fetch(chatId);
      if (!isDiscordSendableChannel(channel)) {
        return;
      }
      const reply = buildDiscordReplyOptions(options?.replyToMessageId, chatId);
      await channel.send({
        content: text,
        ...reply ?? {}
      });
    },
    async prepareInboundMessage(msg, options) {
      return msg;
    },
    onMessage: undefined
  };
  return adapter;
}

// message-actions.ts
async function sendDiscordMessage(ctx) {
  const { request, route, adapter, formatText } = ctx;
  const text = request.message ?? "";
  if (text.trim().length === 0 && !request.mediaPath) {
    return "Error: Discord send requires message or media.";
  }
  const formatted = formatText(text);
  const result = await adapter.sendMessage({
    channel: CHANNEL_ID,
    accountId: route.accountId,
    chatId: request.chatId,
    text: formatted.text,
    replyToMessageId: request.replyToMessageId,
    threadId: request.threadId ?? route.threadId ?? null,
    mediaPath: request.mediaPath,
    fileName: request.filename,
    title: request.title,
    parseMode: formatted.parseMode
  });
  return request.mediaPath ? `Attachment sent to ${DISPLAY_NAME} (message_id: ${result.messageId})` : `Message sent to ${DISPLAY_NAME} (message_id: ${result.messageId})`;
}
async function reactInDiscord(ctx) {
  const { request, route, adapter } = ctx;
  if (!request.emoji?.trim()) {
    return "Error: Discord react requires emoji.";
  }
  if (!request.messageId?.trim()) {
    return "Error: Discord react requires messageId.";
  }
  const result = await adapter.sendMessage({
    channel: CHANNEL_ID,
    accountId: route.accountId,
    chatId: request.chatId,
    text: "",
    targetMessageId: request.messageId,
    reaction: request.emoji,
    removeReaction: request.remove,
    threadId: request.threadId ?? route.threadId ?? null
  });
  return request.remove ? `Reaction removed on ${DISPLAY_NAME} (message_id: ${result.messageId})` : `Reaction added on ${DISPLAY_NAME} (message_id: ${result.messageId})`;
}
var discordianMessageActions = {
  describeMessageTool() {
    return {
      actions: ["send", "react", "upload-file"]
    };
  },
  async handleAction(ctx) {
    switch (ctx.request.action) {
      case "send":
        return await sendDiscordMessage(ctx);
      case "upload-file":
        if (!ctx.request.mediaPath?.trim()) {
          return "Error: Discord upload-file requires media.";
        }
        return await sendDiscordMessage(ctx);
      case "react":
        return await reactInDiscord(ctx);
      default:
        return `Error: Action "${ctx.request.action}" is not supported on ${DISPLAY_NAME}.`;
    }
  }
};

// plugin.ts
var DISCORD_TYPING_INDICATOR_DEFAULT2 = true;
var DISCORD_TYPING_REFRESH_MS_DEFAULT2 = 8000;
var DISCORD_TYPING_REFRESH_MS_MIN2 = 3000;
var DISCORD_TYPING_REFRESH_MS_MAX2 = 30000;
var DISCORD_TYPING_MAX_MS_DEFAULT2 = 10 * 60 * 1000;
var DISCORD_TYPING_MAX_MS_MIN2 = 30000;
var DISCORD_TYPING_MAX_MS_MAX2 = 60 * 60 * 1000;
function clampNumber2(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
function resolveBooleanConfig2(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function resolveMillisecondsConfig2(value, fallback, min, max) {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim().length > 0 ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return clampNumber2(Math.round(numeric), min, max);
}
function resolveTypingLogConfig(normalized) {
  return {
    typingIndicator: resolveBooleanConfig2(normalized.typingIndicator, DISCORD_TYPING_INDICATOR_DEFAULT2),
    typingIndicatorRefreshMs: resolveMillisecondsConfig2(normalized.typingIndicatorRefreshMs, DISCORD_TYPING_REFRESH_MS_DEFAULT2, DISCORD_TYPING_REFRESH_MS_MIN2, DISCORD_TYPING_REFRESH_MS_MAX2),
    typingIndicatorMaxMs: resolveMillisecondsConfig2(normalized.typingIndicatorMaxMs, DISCORD_TYPING_MAX_MS_DEFAULT2, DISCORD_TYPING_MAX_MS_MIN2, DISCORD_TYPING_MAX_MS_MAX2)
  };
}
function readTopLevel(account, key, fallback = undefined) {
  if (account && Object.prototype.hasOwnProperty.call(account, key)) {
    return account[key];
  }
  return fallback;
}
function readNestedConfig(account, key, fallback = undefined) {
  if (account?.config && Object.prototype.hasOwnProperty.call(account.config, key)) {
    return account.config[key];
  }
  return fallback;
}
function readConfig(account, key, fallback = undefined) {
  const nested = readNestedConfig(account, key, undefined);
  if (nested !== undefined)
    return nested;
  return readTopLevel(account, key, fallback);
}
function resolveDiscordianCredentialSource(account) {
  const envValue = process.env.DISCORDIAN_LETTA_API_KEY;
  if (typeof envValue === "string" && envValue.trim().length > 0) {
    return "DISCORDIAN_LETTA_API_KEY";
  }
  const configured = readConfig(account, "discordian_letta_api_key", null);
  if (typeof configured === "string" && configured.trim().length > 0) {
    return "config.discordian_letta_api_key";
  }
  return "missing";
}
function normalizeAccount(account) {
  const discordianDmPolicy = readNestedConfig(account, "dm_policy", "allowlist");
  const discordianAllowedUsers = readNestedConfig(account, "allowed_users", []);
  return {
    ...account,
    channel: CHANNEL_ID,
    accountId: account.accountId ?? "main",
    displayName: account.displayName ?? DISPLAY_NAME,
    enabled: account.enabled !== false,
    token: readConfig(account, "token", ""),
    agentId: readConfig(account, "agentId", readConfig(account, "agent_id", null)),
    discordianLettaApiKey: readConfig(account, "discordian_letta_api_key", null),
    defaultPermissionMode: readConfig(account, "defaultPermissionMode", readConfig(account, "default_permission_mode", "standard")),
    discordianDmPolicy,
    discordianAllowedUsers,
    dmPolicy: "open",
    allowedUsers: [],
    channels: readConfig(account, "channels", readConfig(account, "channels", undefined)),
    autoThreadOnMention: readConfig(account, "autoThreadOnMention", readConfig(account, "auto_thread_on_mention", true)),
    inboundDebounceMs: readConfig(account, "inboundDebounceMs", readConfig(account, "inbound_debounce_ms", undefined)),
    acknowledgeMessageReaction: readConfig(account, "acknowledgeMessageReaction", readConfig(account, "acknowledge_message_reaction", false)),
    removeStaleRoutes: readConfig(account, "removeStaleRoutes", readConfig(account, "remove_stale_routes", false)),
    transcribeVoice: readConfig(account, "transcribeVoice", readConfig(account, "transcribe_voice", false)),
    respondToBots: readConfig(account, "respondToBots", readConfig(account, "respond_to_bots", false)) === true,
    allowedBotIds: readConfig(account, "allowedBotIds", readConfig(account, "allowed_bot_ids", [])),
    typingIndicator: readConfig(account, "typingIndicator", readConfig(account, "typing_indicator", undefined)),
    typingIndicatorRefreshMs: readConfig(account, "typingIndicatorRefreshMs", readConfig(account, "typing_indicator_refresh_ms", undefined)),
    typingIndicatorMaxMs: readConfig(account, "typingIndicatorMaxMs", readConfig(account, "typing_indicator_max_ms", undefined))
  };
}
var channelPlugin = {
  metadata: {
    id: CHANNEL_ID,
    displayName: DISPLAY_NAME,
    runtimePackages: ["discord.js@14.18.0"],
    runtimeModules: ["discord.js"]
  },
  createAdapter(account) {
    const normalized = normalizeAccount(account);
    const baseUrl = (process.env.LETTA_BASE_URL || "https://api.letta.com").replace(/\/+$/, "");
    const typingLogConfig = resolveTypingLogConfig(normalized);
    console.log("[Discordian] Loaded plugin", JSON.stringify({
      build: "public-api-route-conversations",
      accountId: normalized.accountId,
      agentConfigured: typeof normalized.agentId === "string" && normalized.agentId.length > 0,
      credentialSource: resolveDiscordianCredentialSource(account),
      baseUrl,
      ...typingLogConfig
    }));
    account.dmPolicy = "open";
    account.allowedUsers = [];
    return createDiscordAdapter(normalized);
  },
  messageActions: discordianMessageActions
};
var plugin_default = channelPlugin;
export {
  plugin_default as default,
  channelPlugin
};
