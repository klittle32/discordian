# Discordian typing indicator feature spec

## Status

Implemented in Discordian.

## Goal

Show Discord's native typing indicator while Discordian is actively processing an inbound message that may produce a Discord reply. The indicator should appear in the same Discord surface where the reply will be sent: the top-level channel for channel-routed conversations and the Discord thread for thread-routed conversations.

This improves user feedback for long-running Letta turns. Lifecycle reactions are useful but easy to miss in busy Discord channels and threads; typing is the expected Discord affordance for "the bot received this and is working."

## Non-goals

- Do not replace lifecycle reactions. Typing is additional UX, not an acknowledgement-state system.
- Do not add streaming or progressive message edits.
- Do not expose typing as an agent tool action.
- Do not send any Discord text placeholder such as "thinking...".
- Do not try to explicitly stop typing with an API call; modern Discord typing indicators are pulse-based and expire naturally.
- Do not start typing for messages that Discordian filters out before they become Letta turns.

## Research summary

### Discord API behavior through discord.js

Modern `discord.js` text-based channels expose:

```ts
await channel.sendTyping();
```

Key behavior:

- `sendTyping()` sends one typing pulse.
- There is no modern `stopTyping()` API.
- The visible indicator expires automatically after Discord's short TTL.
- Long turns require periodic `sendTyping()` refreshes.
- "Stopping" is implemented by clearing Discordian's refresh interval and letting the last pulse expire.
- Thread channels support the same text-based `sendTyping()` behavior, so using the effective target channel id is enough for typing inside threads.

### Letta Code Telegram precedent

The built-in Letta Code Telegram channel uses turn lifecycle events:

- On `processing`, start typing for each lifecycle source.
- On terminal events, stop typing for each source.
- On outbound send, clear typing for the chat.
- On adapter stop, clear all typing timers.
- Track active source keys per chat so overlapping turns do not clear typing prematurely.
- Include a max-duration timeout as a safety guard.

This lifecycle-driven design is the best fit for Discordian because Discordian is a Letta Code channel adapter and already implements `handleTurnLifecycleEvent(...)`.

### Discord bot example precedent

`letta-ai/letta-discord-bot-example` starts Discord typing directly inside message processing:

```ts
void discordMessageObject.channel.sendTyping();
typingInterval = setInterval(() => {
  void discordMessageObject.channel.sendTyping().catch(...);
}, 8000);
```

Then it clears the interval in `finally` after the stream finishes. This confirms the Discord mechanism and a workable refresh cadence, but Discordian should use lifecycle events rather than embedding typing in inbound message handling.

### Existing upstream feature request

`letta-ai/letta-code#1846` requests the same behavior for Discord:

- send a typing indicator when a turn starts processing;
- keep it alive for longer-running turns;
- stop once the turn finishes or output is sent.

## User-facing behavior

### Enabled path

When Discordian receives and accepts a message that enters a Letta turn:

1. The Letta Code channel runtime emits a lifecycle `processing` event.
2. Discordian resolves each lifecycle source to the Discord channel/thread where a reply would be sent.
3. Discordian calls `sendTyping()` immediately for that Discord target.
4. Discordian refreshes `sendTyping()` on an interval while the source remains active.
5. When a reply is sent or the lifecycle reaches `completed`, `error`, or `cancelled`, Discordian clears the refresh interval for that source.
6. Discord's last typing pulse expires naturally.

### Channel versus thread placement

Typing must target the same Discord location as outbound messages:

- If `source.threadId` is present, type in `source.threadId`.
- Otherwise, type in `source.chatId`.

For manually-created or externally-created Discord threads, this means the typing indicator appears in the thread conversation, not in the parent channel.

### Filtered or observe-only messages

Typing should only start from lifecycle `processing` events. Messages that are filtered by Discordian before reaching Letta do not create lifecycle processing events and therefore do not show typing.

If Letta Code can produce lifecycle events for listen/observe-only sources that cannot send replies, Discordian should avoid typing for them if the source includes an explicit non-reply/observe signal. If no such signal exists in the current source shape, this remains a known limitation and should be revisited only if observed in practice.

### Errors

On turn errors:

- Typing refresh must stop.
- Existing lifecycle error reply behavior must remain unchanged.
- Failure to send or refresh typing must not fail the turn or block lifecycle error reporting.

### Adapter shutdown

On `stop()`, Discordian must clear all typing timers so no interval can survive listener shutdown.

## Configuration

Typing should be enabled by default because it is a low-risk Discord-native UX improvement.

Supported config fields should accept both snake_case and camelCase where that matches existing Discordian config conventions:

```json
{
  "config": {
    "typing_indicator": true,
    "typing_indicator_refresh_ms": 8000,
    "typing_indicator_max_ms": 600000
  }
}
```

CamelCase aliases:

```json
{
  "config": {
    "typingIndicator": true,
    "typingIndicatorRefreshMs": 8000,
    "typingIndicatorMaxMs": 600000
  }
}
```

Defaults:

```ts
const DISCORD_TYPING_INDICATOR_DEFAULT = true;
const DISCORD_TYPING_REFRESH_MS_DEFAULT = 8_000;
const DISCORD_TYPING_MAX_MS_DEFAULT = 10 * 60 * 1000;
```

Validation and clamping:

- `typing_indicator`: boolean; default `true`.
- `typing_indicator_refresh_ms`: positive number; default `8000`; clamp to a safe range such as `3000..30000` to avoid excessive API chatter or ineffective refreshes.
- `typing_indicator_max_ms`: positive number; default `600000`; clamp to a safe range such as `30000..3600000`.
- If refresh/max values are invalid or non-numeric, use defaults and optionally log a warning at startup.

Per-channel override is optional for the first implementation. If added later, it should follow existing `config.channels[CHANNEL_ID]` override semantics.

## Internal design

### State

Add adapter-level typing state:

```ts
type DiscordTypingTargetId = string;
type DiscordTypingSourceKey = string;

interface DiscordTypingState {
  sourceKeys: Set<DiscordTypingSourceKey>;
  timer: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
}

const typingByChatId = new Map<DiscordTypingTargetId, DiscordTypingState>();
```

### Source key

A source key should identify a single lifecycle source strongly enough that overlapping sources in the same Discord target can be independently stopped:

```ts
[
  source.accountId ?? "",
  source.channel,
  source.chatId,
  source.threadId ?? "",
  source.messageId ?? "",
  source.agentId,
  source.conversationId,
].join(":")
```

If any optional field is absent, use an empty string. Do not include user text.

### Target id

```ts
function getTypingTargetId(source: ChannelTurnLifecycleSource): string | null {
  const target = source.threadId ?? source.chatId;
  return typeof target === "string" && target.length > 0 ? target : null;
}
```

### Channel guard

Add a narrow guard for typing support:

```ts
function isDiscordTypingChannel(channel: unknown): channel is { sendTyping: () => Promise<unknown> } {
  return Boolean(channel && typeof (channel as { sendTyping?: unknown }).sendTyping === "function");
}
```

It can be combined with the existing sendable-channel guard if useful, but should not assume every fetch result is sendable.

### Sending typing

```ts
async function sendTypingAction(targetChannelId: string): Promise<void> {
  if (!running || !client) return;
  try {
    const channel = await client.channels.fetch(targetChannelId);
    if (!isDiscordTypingChannel(channel)) return;
    await channel.sendTyping();
  } catch (error) {
    console.warn(`[Discord] Failed to send typing indicator for ${targetChannelId}:`, ...);
  }
}
```

Typing failures should be warning-only.

### Starting typing

```ts
function startTypingForSource(source: ChannelTurnLifecycleSource): void {
  if (!isTypingIndicatorEnabled()) return;
  const targetId = getTypingTargetId(source);
  const sourceKey = getTypingSourceKey(source);
  if (!targetId || !sourceKey) return;

  const existing = typingByChatId.get(targetId);
  if (existing) {
    existing.sourceKeys.add(sourceKey);
    return;
  }

  void sendTypingAction(targetId);
  const timer = setInterval(() => void sendTypingAction(targetId), refreshMs);
  const timeout = setTimeout(() => clearTypingForChat(targetId), maxMs);
  timer.unref?.();
  timeout.unref?.();

  typingByChatId.set(targetId, { sourceKeys: new Set([sourceKey]), timer, timeout });
}
```

### Stopping typing

```ts
function stopTypingForSource(source: ChannelTurnLifecycleSource): void {
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
```

### Clearing typing

```ts
function clearTypingForChat(targetId: string): void {
  const entry = typingByChatId.get(targetId);
  if (!entry) return;
  clearInterval(entry.timer);
  clearTimeout(entry.timeout);
  typingByChatId.delete(targetId);
}

function clearAllTyping(): void {
  for (const entry of typingByChatId.values()) {
    clearInterval(entry.timer);
    clearTimeout(entry.timeout);
  }
  typingByChatId.clear();
}
```

## Lifecycle integration

Current Discordian behavior ignores processing events. Replace that with typing start:

```ts
if (event.type === "processing") {
  for (const source of event.sources) {
    startTypingForSource(source);
  }
  return;
}
```

For terminal lifecycle events, stop typing for all sources regardless of outcome:

```ts
for (const source of event.sources) {
  stopTypingForSource(source);
}
```

The terminal cleanup should happen even if lifecycle reaction updates or error-reply sends fail. Prefer to structure `handleTurnLifecycleEvent` so typing cleanup is independent from reaction/error work.

## Outbound send integration

Before or immediately after sending a normal outbound message/file, clear typing for the target:

```ts
const targetChannelId = msg.threadId ?? msg.chatId;
clearTypingForChat(targetChannelId);
```

Do this in both:

- text send path;
- file upload path.

For reactions, clearing typing is not required because reactions are not visible message replies. It is harmless to skip.

## Logging

Startup log should include whether typing is enabled and the resolved intervals, without noisy per-pulse logs:

```json
{
  "typingIndicator": true,
  "typingRefreshMs": 8000,
  "typingMaxMs": 600000
}
```

Runtime warnings should be concise and non-fatal:

```text
[Discord] Failed to send typing indicator for <channelId>: <message>
```

Avoid logging source content or secrets.

## Testing plan

Use fake timers where practical.

Unit/integration tests should cover:

- `processing` starts typing and calls `sendTyping()` immediately.
- Typing refreshes on interval for long turns.
- `completed` clears interval and source state.
- `error` clears interval while preserving lifecycle error reply behavior.
- `cancelled` clears interval.
- Thread lifecycle sources target `threadId` rather than parent `chatId`.
- Channel lifecycle sources target `chatId`.
- Multiple lifecycle sources sharing a target keep typing active until the last source stops.
- Outbound text send clears typing for the target.
- Outbound file send clears typing for the target.
- Adapter `stop()` clears all typing timers.
- Disabled config never calls `sendTyping()`.
- Typing API failures are swallowed/logged and do not reject lifecycle handling.

Manual live validation:

1. Enable typing indicator in the live account or rely on default enabled.
2. Restart the Discordian listener.
3. Send a message that triggers a longer Letta turn.
4. Confirm Discord shows the bot typing in the correct top-level channel or thread.
5. Confirm typing stops after the reply appears.
6. Trigger an error or cancellation if practical and confirm typing does not continue indefinitely.
7. Confirm lifecycle reactions still work.

## Acceptance criteria

- Users see a Discord typing indicator during active agent processing for reply-capable Discordian turns.
- The indicator appears in the correct Discord thread/channel.
- The indicator refreshes for long-running turns and stops after completion/error/cancellation/output.
- Typing failures do not break inbound message handling, lifecycle reactions, or outbound replies.
- No timer leaks remain after terminal lifecycle events or adapter shutdown.
- Docs describe configuration and the Discord pulse/expiry semantics.

## Known limitations

- Discord provides no explicit stop-typing API; the last pulse may remain visible briefly after cleanup.
- If a process crashes, Discord's existing typing pulse expires naturally, but Discordian cannot clean up in-memory state in the crashed process.
- If Letta Code emits lifecycle events for observe-only messages without a source flag indicating non-reply capability, Discordian may type for an observe-only turn. This should be revisited only if observed.
- Multi-process duplicate listeners can each send typing pulses, just as they can each receive duplicate inbound events. The existing operational guidance remains: run one listener per Discord bot/account.
