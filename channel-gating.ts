/**
 * Discord guild-channel gating and policy resolution.
 *
 * `channels` is a first-class per-channel override map. It is not an
 * allowlist: channels without an explicit entry inherit account/global
 * defaults. Resolution precedence is exact channel > `*` wildcard > defaults.
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
  /** First-class per-channel config override map. */
  channels?: unknown;
}

export interface DiscordChannelPolicyParams extends DiscordChannelGateParams {
  /** Account-level default used when a channel omits `conversation`. */
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

function defaultConversation(
  trigger: DiscordianChannelTrigger,
  autoThreadOnMention?: boolean,
): DiscordianConversationPlacement {
  return trigger === "mention"
    ? defaultMentionConversation(autoThreadOnMention)
    : "channel";
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

function resolveChannelEntry(
  channels: unknown,
  gateChannelId: string,
): Record<string, unknown> {
  if (!isChannelMap(channels)) return {};
  const exact = channels[gateChannelId];
  if (isChannelMap(exact)) return exact;
  const wildcard = channels["*"];
  if (isChannelMap(wildcard)) return wildcard;
  return {};
}

function resolveChannelPolicy(
  entry: Record<string, unknown>,
  autoThreadOnMention?: boolean,
): DiscordianChannelPolicy {
  if (entry.enabled === false) {
    return { allowed: false, trigger: "never", conversation: "channel" };
  }
  const trigger = isTrigger(entry.trigger) ? entry.trigger : "mention";
  const conversation = isConversation(entry.conversation)
    ? entry.conversation
    : defaultConversation(trigger, autoThreadOnMention);
  return {
    allowed: trigger !== "never",
    trigger,
    conversation,
  };
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
  const policy = resolveChannelPolicy(channelEntry, autoThreadOnMention);

  return {
    ...policy,
    respondToBots: isBoolean(channelEntry.respond_to_bots)
      ? channelEntry.respond_to_bots
      : respondToBots === true,
    allowedBotIds: Array.isArray(channelEntry.allowed_bot_ids)
      ? normalizedStringList(channelEntry.allowed_bot_ids)
      : normalizedStringList(allowedBotIds),
    acknowledgeMessageReaction: isBoolean(
      channelEntry.acknowledge_message_reaction,
    )
      ? channelEntry.acknowledge_message_reaction
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
 * Resolve the Discordian per-channel routing policy.
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
