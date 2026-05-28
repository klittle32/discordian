import { createDiscordAdapter } from "./adapter";
import { discordianMessageActions } from "./message-actions";
import { CHANNEL_ID, DISPLAY_NAME } from "./runtime.mjs";

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
    allowedChannels: readConfig(
      account,
      "allowedChannels",
      readConfig(account, "allowed_channels", undefined),
    ),
    autoThreadOnMention: readConfig(
      account,
      "autoThreadOnMention",
      readConfig(account, "auto_thread_on_mention", true),
    ),
    threadPolicyByChannel: readConfig(
      account,
      "threadPolicyByChannel",
      readConfig(account, "thread_policy_by_channel", undefined),
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
