/**
 * Discord guild-channel gating and policy resolution.
 *
 * `allowedChannels` accepts three formats:
 *   - Legacy `string[]`: simple allowlist, entries default to mention-triggered
 *   - Legacy mode map: `Record<channelId, "mention" | "mention-only" | "open" | boolean>`
 *   - Policy map: `Record<channelId, { trigger, conversation }>`
 *
 * The policy map separates two concerns:
 *   - trigger: when a top-level channel message should engage the agent
 *   - conversation: whether the agent conversation happens in-channel or in a thread
 */

export type DiscordianChannelTrigger = "mention" | "always" | "never";
export type DiscordianConversationPlacement = "channel" | "thread";

export interface DiscordianChannelPolicy {
  allowed: boolean;
  trigger: DiscordianChannelTrigger;
  conversation: DiscordianConversationPlacement;
}

export interface DiscordChannelGateParams {
  /** ID of the channel the message arrived in. For thread messages this is the thread's channel ID. */
  channelId: string;
  /** Parent channel ID when the message is in a thread; null otherwise. */
  parentChannelId: string | null;
  /** Whether the message is in a thread. */
  isThread: boolean;
  /** The configured allowlist, mode map, or policy map (may be empty/undefined to mean "no gate"). */
  allowedChannels?: unknown;
}

export interface DiscordChannelPolicyParams extends DiscordChannelGateParams {
  /** Legacy setting used to map simple mention configs to channel/thread placement. */
  autoThreadOnMention?: boolean;
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
  allowedChannels: unknown,
): allowedChannels is Record<string, unknown> {
  return (
    !!allowedChannels &&
    typeof allowedChannels === "object" &&
    !Array.isArray(allowedChannels)
  );
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

function normalizeChannelPolicy(
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
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const trigger = isTrigger(record.trigger) ? record.trigger : "mention";
    const conversation = isConversation(record.conversation)
      ? record.conversation
      : defaultMentionConversation(autoThreadOnMention);
    return {
      allowed: trigger !== "never",
      trigger,
      conversation,
    };
  }
  return { allowed: false, trigger: "never", conversation: "channel" };
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
 * Resolve the full Discordian per-channel policy.
 */
export function resolveDiscordianChannelPolicy(
  params: DiscordChannelPolicyParams,
): DiscordianChannelPolicy {
  const {
    channelId,
    parentChannelId,
    isThread,
    allowedChannels,
    autoThreadOnMention,
  } = params;

  if (!allowedChannels) {
    return { allowed: true, trigger: "mention", conversation: "channel" };
  }

  const gateChannelId = resolveGateChannelId(
    channelId,
    parentChannelId,
    isThread,
  );

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
      return normalizeChannelPolicy(
        allowedChannels[gateChannelId],
        autoThreadOnMention,
      );
    }
    if ("*" in allowedChannels) {
      return normalizeChannelPolicy(allowedChannels["*"], autoThreadOnMention);
    }
    return { allowed: false, trigger: "never", conversation: "channel" };
  }

  return { allowed: true, trigger: "mention", conversation: "channel" };
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
