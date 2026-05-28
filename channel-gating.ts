/**
 * Discord guild-channel gating and policy resolution.
 *
 * Preferred config is `channels`, a first-class per-channel map with account
 * defaults and channel-level overrides. `allowedChannels` remains supported as
 * a legacy compatibility input:
 *   - Legacy `string[]`: simple allowlist, entries default to mention-triggered
 *   - Legacy mode map: `Record<channelId, "mention" | "mention-only" | "open" | boolean>`
 *   - Policy map: `Record<channelId, { trigger, conversation }>`
 */

export type DiscordianChannelTrigger = "mention" | "always" | "never";
export type DiscordianConversationPlacement = "channel" | "thread";

export interface DiscordianChannelPolicy {
  allowed: boolean;
  trigger: DiscordianChannelTrigger;
  conversation: DiscordianConversationPlacement;
}

export interface DiscordianEffectiveChannelConfig
  extends DiscordianChannelPolicy {
  respondToBots: boolean;
  allowedBotIds: string[];
  acknowledgeMessageReaction: boolean;
}

export interface DiscordChannelGateParams {
  /** ID of the channel the message arrived in. For thread messages this is the thread's channel ID. */
  channelId: string;
  /** Parent channel ID when the message is in a thread; null otherwise. */
  parentChannelId: string | null;
  /** Whether the message is in a thread. */
  isThread: boolean;
  /** Preferred first-class per-channel config map. */
  channels?: unknown;
  /** Legacy allowlist, mode map, or policy map (may be empty/undefined to mean "no gate"). */
  allowedChannels?: unknown;
}

export interface DiscordChannelPolicyParams extends DiscordChannelGateParams {
  /** Legacy setting used to map simple mention configs to channel/thread placement. */
  autoThreadOnMention?: boolean;
}

export interface DiscordEffectiveChannelConfigParams
  extends DiscordChannelPolicyParams {
  respondToBots?: boolean;
  allowedBotIds?: unknown;
  acknowledgeMessageReaction?: boolean;
}

/** Resolved channel ID for gating purposes (thread → parent fallback). */
function resolveGateChannelId(
  channelId: string,
  parentChannelId: string | null,
  isThread: boolean,
): string {
  return isThread ? (parentChannelId ?? channelId) : channelId;
}

function isLegacyStringArray(allowedChannels: unknown): allowedChannels is string[] {
  return Array.isArray(allowedChannels);
}

function isChannelMap(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function defaultMentionConversation(
  autoThreadOnMention?: boolean,
): DiscordianConversationPlacement {
  return autoThreadOnMention === false ? "channel" : "thread";
}

function isTrigger(value: unknown): value is DiscordianChannelTrigger {
  return value === "mention" || value === "always" || value === "never";
}

function isConversation(
  value: unknown,
): value is DiscordianConversationPlacement {
  return value === "channel" || value === "thread";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function normalizedStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item: unknown): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function normalizeStringPolicy(
  value: string,
  autoThreadOnMention?: boolean,
): DiscordianChannelPolicy {
  switch (value) {
    case "open":
    case "always":
      return { allowed: true, trigger: "always", conversation: "channel" };
    case "mention":
    case "mention-only":
      return {
        allowed: true,
        trigger: "mention",
        conversation: defaultMentionConversation(autoThreadOnMention),
      };
    case "off":
    case "never":
    case "disabled":
      return { allowed: false, trigger: "never", conversation: "channel" };
    default:
      return { allowed: false, trigger: "never", conversation: "channel" };
  }
}

function normalizeLegacyChannelPolicy(
  value: unknown,
  autoThreadOnMention?: boolean,
): DiscordianChannelPolicy {
  if (typeof value === "string") {
    return normalizeStringPolicy(value, autoThreadOnMention);
  }
  if (value === true) {
    return {
      allowed: true,
      trigger: "mention",
      conversation: defaultMentionConversation(autoThreadOnMention),
    };
  }
  if (value === false || value == null) {
    return { allowed: false, trigger: "never", conversation: "channel" };
  }
  if (isChannelMap(value)) {
    const trigger = isTrigger(value.trigger) ? value.trigger : "mention";
    const conversation = isConversation(value.conversation)
      ? value.conversation
      : defaultMentionConversation(autoThreadOnMention);
    return {
      allowed: trigger !== "never",
      trigger,
      conversation,
    };
  }
  return { allowed: false, trigger: "never", conversation: "channel" };
}

function normalizeFirstClassChannelPolicy(
  value: unknown,
  autoThreadOnMention?: boolean,
): DiscordianChannelPolicy {
  if (!isChannelMap(value)) {
    return normalizeLegacyChannelPolicy(value, autoThreadOnMention);
  }
  if (value.enabled === false) {
    return { allowed: false, trigger: "never", conversation: "channel" };
  }
  const trigger = isTrigger(value.trigger) ? value.trigger : "mention";
  const conversation = isConversation(value.conversation)
    ? value.conversation
    : defaultMentionConversation(autoThreadOnMention);
  return {
    allowed: trigger !== "never",
    trigger,
    conversation,
  };
}

function resolveChannelEntry(
  channels: unknown,
  gateChannelId: string,
): unknown {
  if (!isChannelMap(channels)) return undefined;
  if (gateChannelId in channels) return channels[gateChannelId];
  if ("*" in channels) return channels["*"];
  return undefined;
}

function resolveLegacyPolicy(
  options: {
    gateChannelId: string;
    allowedChannels?: unknown;
    autoThreadOnMention?: boolean;
  },
): DiscordianChannelPolicy {
  const { gateChannelId, allowedChannels, autoThreadOnMention } = options;

  if (!allowedChannels) {
    return { allowed: true, trigger: "mention", conversation: "channel" };
  }

  if (isLegacyStringArray(allowedChannels)) {
    if (allowedChannels.length === 0) {
      return { allowed: true, trigger: "mention", conversation: "channel" };
    }
    if (!allowedChannels.includes(gateChannelId)) {
      return { allowed: false, trigger: "never", conversation: "channel" };
    }
    return {
      allowed: true,
      trigger: "mention",
      conversation: defaultMentionConversation(autoThreadOnMention),
    };
  }

  if (isChannelMap(allowedChannels)) {
    const keys = Object.keys(allowedChannels);
    if (keys.length === 0) {
      return { allowed: true, trigger: "mention", conversation: "channel" };
    }
    if (gateChannelId in allowedChannels) {
      return normalizeLegacyChannelPolicy(
        allowedChannels[gateChannelId],
        autoThreadOnMention,
      );
    }
    if ("*" in allowedChannels) {
      return normalizeLegacyChannelPolicy(
        allowedChannels["*"],
        autoThreadOnMention,
      );
    }
    return { allowed: false, trigger: "never", conversation: "channel" };
  }

  return { allowed: true, trigger: "mention", conversation: "channel" };
}

/**
 * Resolve the effective Discordian per-channel config, including channel-level
 * overrides for bot participation and lifecycle acknowledgement behavior.
 */
export function resolveDiscordianEffectiveChannelConfig(
  params: DiscordEffectiveChannelConfigParams,
): DiscordianEffectiveChannelConfig {
  const {
    channelId,
    parentChannelId,
    isThread,
    channels,
    allowedChannels,
    autoThreadOnMention,
    respondToBots,
    allowedBotIds,
    acknowledgeMessageReaction,
  } = params;
  const gateChannelId = resolveGateChannelId(
    channelId,
    parentChannelId,
    isThread,
  );
  const channelEntry = resolveChannelEntry(channels, gateChannelId);
  const policy = channelEntry !== undefined
    ? normalizeFirstClassChannelPolicy(channelEntry, autoThreadOnMention)
    : resolveLegacyPolicy({
        gateChannelId,
        allowedChannels,
        autoThreadOnMention,
      });
  const channelRecord = isChannelMap(channelEntry) ? channelEntry : undefined;

  return {
    ...policy,
    respondToBots: isBoolean(channelRecord?.respond_to_bots)
      ? channelRecord.respond_to_bots
      : respondToBots === true,
    allowedBotIds: Array.isArray(channelRecord?.allowed_bot_ids)
      ? normalizedStringList(channelRecord.allowed_bot_ids)
      : normalizedStringList(allowedBotIds),
    acknowledgeMessageReaction: isBoolean(
      channelRecord?.acknowledge_message_reaction,
    )
      ? channelRecord.acknowledge_message_reaction
      : acknowledgeMessageReaction === true,
  };
}

/**
 * Returns true when the message should be processed, false when the gate
 * blocks it. Messages outside guilds (DMs) should not be passed through this
 * helper — gate them at the call site by checking chat type first.
 */
export function isDiscordGuildChannelAllowed(
  params: DiscordChannelGateParams,
): boolean {
  return resolveDiscordianChannelPolicy(params).allowed;
}

/**
 * Resolve the Discordian per-channel routing policy. Compatibility wrapper for
 * older call sites that do not need bot/reaction overrides.
 */
export function resolveDiscordianChannelPolicy(
  params: DiscordChannelPolicyParams,
): DiscordianChannelPolicy {
  const effective = resolveDiscordianEffectiveChannelConfig(params);
  return {
    allowed: effective.allowed,
    trigger: effective.trigger,
    conversation: effective.conversation,
  };
}

/**
 * Legacy helper retained for older call sites/tests.
 */
export function resolveDiscordChannelMode(
  channelId: string,
  parentChannelId: string | null,
  isThread: boolean,
  allowedChannels?: unknown,
): string | null {
  if (!allowedChannels) return null;
  const policy = resolveDiscordianChannelPolicy({
    channelId,
    parentChannelId,
    isThread,
    allowedChannels,
  });
  if (!policy.allowed) return null;
  return policy.trigger === "always" ? "open" : "mention-only";
}
