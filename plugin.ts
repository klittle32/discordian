import { createDiscordAdapter } from "./adapter";
import { discordianMessageActions } from "./message-actions";
import { CHANNEL_ID, DISPLAY_NAME } from "./runtime.mjs";

function readConfig(account, key, fallback = undefined) {
  if (account && Object.prototype.hasOwnProperty.call(account, key)) {
    return account[key];
  }
  if (account?.config && Object.prototype.hasOwnProperty.call(account.config, key)) {
    return account.config[key];
  }
  return fallback;
}

function normalizeAccount(account) {
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
    dmPolicy: readConfig(account, "dmPolicy", readConfig(account, "dm_policy", "pairing")),
    allowedUsers: readConfig(account, "allowedUsers", readConfig(account, "allowed_users", [])),
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
    return createDiscordAdapter(normalizeAccount(account));
  },

  messageActions: discordianMessageActions,
};

export default channelPlugin;
