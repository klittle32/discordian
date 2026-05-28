import { createDiscordAdapter } from "./adapter";
import { discordianMessageActions } from "./message-actions";
import { CHANNEL_ID, DISPLAY_NAME } from "./runtime.mjs";


const DISCORD_TYPING_INDICATOR_DEFAULT = true;
const DISCORD_TYPING_REFRESH_MS_DEFAULT = 8_000;
const DISCORD_TYPING_REFRESH_MS_MIN = 3_000;
const DISCORD_TYPING_REFRESH_MS_MAX = 30_000;
const DISCORD_TYPING_MAX_MS_DEFAULT = 10 * 60 * 1000;
const DISCORD_TYPING_MAX_MS_MIN = 30_000;
const DISCORD_TYPING_MAX_MS_MAX = 60 * 60 * 1000;

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resolveBooleanConfig(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function resolveMillisecondsConfig(value, fallback, min, max) {
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

function resolveTypingLogConfig(normalized) {
  return {
    typingIndicator: resolveBooleanConfig(
      normalized.typingIndicator,
      DISCORD_TYPING_INDICATOR_DEFAULT,
    ),
    typingIndicatorRefreshMs: resolveMillisecondsConfig(
      normalized.typingIndicatorRefreshMs,
      DISCORD_TYPING_REFRESH_MS_DEFAULT,
      DISCORD_TYPING_REFRESH_MS_MIN,
      DISCORD_TYPING_REFRESH_MS_MAX,
    ),
    typingIndicatorMaxMs: resolveMillisecondsConfig(
      normalized.typingIndicatorMaxMs,
      DISCORD_TYPING_MAX_MS_DEFAULT,
      DISCORD_TYPING_MAX_MS_MIN,
      DISCORD_TYPING_MAX_MS_MAX,
    ),
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
  if (nested !== undefined) return nested;
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
    defaultPermissionMode: readConfig(
      account,
      "defaultPermissionMode",
      readConfig(account, "default_permission_mode", "standard"),
    ),
    discordianDmPolicy,
    discordianAllowedUsers,
    // Discordian enforces Discord-style DM/bot authorization in the adapter.
    // Keep the generic custom-channel registry open so its global dmPolicy
    // check does not incorrectly reject guild/thread messages.
    dmPolicy: "open",
    allowedUsers: [],
    channels: readConfig(
      account,
      "channels",
      readConfig(account, "channels", undefined),
    ),
    autoThreadOnMention: readConfig(
      account,
      "autoThreadOnMention",
      readConfig(account, "auto_thread_on_mention", true),
    ),
    inboundDebounceMs: readConfig(
      account,
      "inboundDebounceMs",
      readConfig(account, "inbound_debounce_ms", undefined),
    ),
    acknowledgeMessageReaction: readConfig(
      account,
      "acknowledgeMessageReaction",
      readConfig(account, "acknowledge_message_reaction", false),
    ),
    removeStaleRoutes: readConfig(
      account,
      "removeStaleRoutes",
      readConfig(account, "remove_stale_routes", false),
    ),
    transcribeVoice: readConfig(
      account,
      "transcribeVoice",
      readConfig(account, "transcribe_voice", false),
    ),
    respondToBots: readConfig(
      account,
      "respondToBots",
      readConfig(account, "respond_to_bots", false),
    ) === true,
    allowedBotIds: readConfig(
      account,
      "allowedBotIds",
      readConfig(account, "allowed_bot_ids", []),
    ),
    typingIndicator: readConfig(
      account,
      "typingIndicator",
      readConfig(account, "typing_indicator", undefined),
    ),
    typingIndicatorRefreshMs: readConfig(
      account,
      "typingIndicatorRefreshMs",
      readConfig(account, "typing_indicator_refresh_ms", undefined),
    ),
    typingIndicatorMaxMs: readConfig(
      account,
      "typingIndicatorMaxMs",
      readConfig(account, "typing_indicator_max_ms", undefined),
    ),
  };
}

export const channelPlugin = {
  metadata: {
    id: CHANNEL_ID,
    displayName: DISPLAY_NAME,
    runtimePackages: ["discord.js@14.18.0"],
    runtimeModules: ["discord.js"],
  },

  createAdapter(account) {
    const normalized = normalizeAccount(account);
    const baseUrl = (process.env.LETTA_BASE_URL || "https://api.letta.com").replace(/\/+$/, "");
    const typingLogConfig = resolveTypingLogConfig(normalized);
    console.log(
      "[Discordian] Loaded plugin",
      JSON.stringify({
        build: "public-api-route-conversations",
        accountId: normalized.accountId,
        agentConfigured: typeof normalized.agentId === "string" && normalized.agentId.length > 0,
        credentialSource: resolveDiscordianCredentialSource(account),
        baseUrl,
        ...typingLogConfig,
      }),
    );

    // The channel registry keeps and later consults this same account object
    // for generic custom-channel dmPolicy enforcement. Mutate the live account
    // to open after preserving the original policy in `normalized`, so
    // Discordian-owned adapter auth can enforce DM/bot rules without the
    // generic registry rejecting guild/thread messages.
    account.dmPolicy = "open";
    account.allowedUsers = [];

    return createDiscordAdapter(normalized);
  },

  messageActions: discordianMessageActions,
};

export default channelPlugin;
