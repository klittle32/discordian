# Discordian Plan

## Objective

Build `discordian` as a custom Letta Code channel adapter by copying the native Discord channel implementation as closely as possible, renaming it to run under the custom channel ID `discordian`, and testing whether it can achieve headless feature parity with the bundled native Discord channel.

This is a parity probe, not the final architecture. The goal is to learn where custom channels match native channels and where first-party/internal assumptions leak through.

## Why this strategy

The native Discord channel already solves the real problems we care about:

- connecting to Discord as a long-running listener;
- receiving inbound messages;
- mapping Discord users/channels/threads into Letta Code chats;
- supporting pairing and routing;
- delivering messages into agent conversations;
- sending outbound replies through the `MessageChannel` tool;
- handling Discord-specific details such as message formatting, attachments, and thread behavior where supported.

If the native implementation can run as a custom channel under a different ID, that is strong evidence that Letta Code's custom channel feature can support native-channel-level behavior for headless deployments.

If it cannot, the failure points will identify exactly which capabilities are still native-only or dependent on private internals.

## Non-goals

- Do not build or depend on Letta Code desktop app configuration screens.
- Do not optimize or redesign the Discord adapter during the first pass.
- Do not treat the first copied implementation as the clean long-term implementation.
- Do not override the bundled `discord` channel ID. The custom channel must use `discordian`.

## Core hypothesis

A custom channel named `discordian` can provide the same practical headless behavior as the native Discord channel if:

1. the native adapter code can be loaded from a custom channel plugin;
2. native Discord dependencies can be resolved through custom channel runtime packages/modules;
3. native configuration assumptions can be expressed through `accounts.json`;
4. routing, pairing, and `MessageChannel` do not require hardcoded `channel === "discord"` behavior.

## Expected fault lines

### 1. Private Letta Code internals

The native Discord implementation may import helpers, types, services, or runtime modules that are not available to custom channel plugins. If so, copy or replace the minimum required helpers and document each gap.

### 2. Channel identity assumptions

Some Letta Code logic may special-case the native channel ID `discord`. Renaming the adapter to `discordian` should reveal whether routing, pairing, tool exposure, permissions, or formatting depends on hardcoded native-channel names.

### 3. Runtime dependency loading

The native channel may rely on dependencies bundled with Letta Code. For a portable custom channel, declare required packages in `channel.json` using `runtimePackages` and `runtimeModules` where possible.

### 4. Configuration shape

The native Discord channel may read config from first-party config paths, environment variables, or app-managed account state. `discordian` should instead use the documented custom channel account envelope in `accounts.json`, with channel-specific settings under each account's `config` object.

### 5. Adapter contract mismatch

The native adapter may implement a richer internal interface than the documented custom channel adapter contract. Any mismatch is important evidence for custom-channel parity limits.

## First-pass approach

The first implementation should stay as close to the native Discord channel as possible.

1. Locate the native Discord channel source in the installed Letta Code package or upstream repository.
2. Copy the implementation into this repo.
3. Rename only the channel identity from `discord` to `discordian`.
4. Preserve behavior until a change is required for custom-channel loading.
5. Replace native app/config assumptions with `accounts.json` config.
6. Declare runtime dependencies explicitly in `channel.json`.
7. Avoid cleanup, abstraction, or redesign until the parity test has run.

Every required modification should be treated as data: it tells us where custom channels differ from bundled native channels.

## Test checklist

Minimum full-loop test:

1. `letta channels status` discovers `discordian`.
2. The `discordian` account loads from `accounts.json`.
3. `letta channels install discordian` installs required runtime dependencies.
4. `letta server --channels discordian` starts the adapter.
5. The adapter connects to Discord successfully.
6. An inbound Discord message calls `adapter.onMessage(...)`.
7. Unknown users create pairing records when `dmPolicy` is `pairing`.
8. `letta channels pair` or manual routing binds the chat to an agent conversation.
9. The inbound message appears in the target agent conversation.
10. The agent can reply through `MessageChannel`.
11. The Discord chat receives the outbound reply.

Additional parity tests:

- Discord thread behavior.
- Attachments and uploaded files.
- Voice/audio attachment handling.
- Mentions and bot ignore rules.
- Multi-account behavior.
- Restart behavior with existing routes.
- Route changes while the listener is already running.

## Success criteria

The experiment succeeds if `discordian` can run headlessly as a custom channel and complete the inbound/outbound loop with comparable behavior to native Discord.

The experiment is still useful if it fails, as long as the failure is reduced to specific, documented gaps such as unavailable private imports, hardcoded native channel names, or unsupported adapter contract features.

## Development rule

Do not prematurely improve the copied implementation. First make the native behavior run under the custom channel system. Cleanups and redesigns come after the parity boundary is understood.

## Implemented enhancement: Discordian-owned auth and thread routing

Live v1 testing confirmed two custom-channel parity gaps:

1. Generic custom-channel `dmPolicy: allowlist` applies to all inbound custom-channel messages, not just DMs. This blocks bot-originated guild/thread messages even after Discordian's own `respond_to_bots` filter allows them.
2. Generic custom-channel route matching requires exact `threadId`; externally-created Discord threads need routes with `chatId === threadId` and `threadId === threadId`.

Implemented fix:

- Preserve user-facing Discord-style config in `accounts.json`.
- Move Discordian-specific human/bot authorization into `adapter.ts`.
- Avoid relying on the generic custom-channel allowlist for guild/thread authorization.
- Generalize the thread-route shim so all allowed Discord thread messages, including externally-created bot threads, get exact thread routes before `adapter.onMessage(...)` forwards them.
- Prefer bot whitelisting with `respond_to_bots: true` plus `allowed_bot_ids`, while supporting broad bot mode with an empty `allowed_bot_ids` array.

See `docs/IMPLEMENTATION_NOTES.md` for the detailed findings, design, and acceptance tests.

## Simplified Discordian custom-channel auth config

Broad bot response and externally-created thread routing are functional. The configuration model now describes intent instead of implementation history.

### Problem with unclear names

Earlier implementation drafts used temporary `original_*` names for Discordian-owned DM policy. Those names exposed migration history instead of intent, so the supported config now uses direct Discordian policy names under `config`.

### Supported config model

Use top-level custom-channel account fields only for Letta's generic registry compatibility:

```json
{
  "dmPolicy": "open",
  "allowedUsers": []
}
```

Use `config` for Discordian's actual Discord-aware access policy:

```json
{
  "config": {
    "dm_policy": "allowlist",
    "allowed_users": ["295423483368964096"],
    "respond_to_bots": true,
    "allowed_bot_ids": []
  }
}
```

Meaning:

- top-level `dmPolicy: "open"`: prevent the generic custom-channel registry from applying a global allowlist to guild/thread/bot messages;
- `config.dm_policy`: Discordian's real DM policy;
- `config.allowed_users`: Discordian's real DM allowlist;
- `config.respond_to_bots` / `config.allowed_bot_ids`: Discordian's bot policy.

### Implementation summary

1. Config reading now keeps top-level registry fields and nested Discordian config fields separate.
2. Normalized internal fields are named `discordianDmPolicy` and `discordianAllowedUsers`.
3. Interim `original_*` aliases were removed before commit because they were never a stable public config contract.
4. `accounts.example.json` uses the simplified shape.
5. Docs explain registry-open compatibility and adapter-owned Discordian policy.
6. `plugin.mjs` was rebuilt and live-tested after deployment.

## Next enhancement: per-channel trigger and conversation policies

Goal: make Needle unnecessary in channels where Discordian should create agent threads itself, while still supporting channels that require mentions and/or top-level replies.

The important design change is to separate two concepts that are currently tangled together:

1. **Trigger policy** — when should the agent engage with a top-level channel message?
2. **Conversation placement** — where should the agent conversation happen once triggered?

This lets different Discord channels behave differently without rewriting the thread creation machinery.

### Target config model

Prefer an object form under `config.allowed_channels`:

```json
{
  "allowed_channels": {
    "DISCORD_CHANNEL_A": {
      "trigger": "mention",
      "conversation": "channel"
    },
    "DISCORD_CHANNEL_B": {
      "trigger": "always",
      "conversation": "thread"
    },
    "DISCORD_CHANNEL_C": {
      "trigger": "mention",
      "conversation": "thread"
    }
  }
}
```

Semantics:

- `trigger: "mention"`: a top-level channel message triggers the agent only if the Discordian bot is mentioned.
- `trigger: "always"`: any allowed top-level channel message from an authorized sender triggers the agent; no mention required.
- `trigger: "never"`: explicit disable for a channel.
- `conversation: "channel"`: keep the conversation in the top-level Discord channel; replies are top-level channel replies.
- `conversation: "thread"`: create/use a Discord thread and route the agent conversation there.

Example use cases:

- Channel A requires mentioning, and the agent replies at top level:

```json
"DISCORD_CHANNEL_A": { "trigger": "mention", "conversation": "channel" }
```

- Channel B does not require mentioning, and Discordian creates a thread automatically:

```json
"DISCORD_CHANNEL_B": { "trigger": "always", "conversation": "thread" }
```

- Channel C requires mentioning, and Discordian creates a thread after the mention:

```json
"DISCORD_CHANNEL_C": { "trigger": "mention", "conversation": "thread" }
```

### Backward compatibility

Keep existing `allowed_channels` forms working.

Array form remains conservative:

```json
"allowed_channels": ["DISCORD_CHANNEL_ID"]
```

Map to:

```json
{ "trigger": "mention", "conversation": "thread" }
```

when `auto_thread_on_mention` is true, and to:

```json
{ "trigger": "mention", "conversation": "channel" }
```

when `auto_thread_on_mention` is false.

String/object legacy modes should also continue to work:

```json
"allowed_channels": {
  "DISCORD_CHANNEL_A": "mention",
  "DISCORD_CHANNEL_B": "open"
}
```

Suggested mapping:

- `"mention"` -> `{ "trigger": "mention", "conversation": auto_thread_on_mention ? "thread" : "channel" }`
- `"open"` -> `{ "trigger": "always", "conversation": "channel" }`
- `true` -> same as `"mention"` for conservative compatibility
- `false` -> `{ "trigger": "never", "conversation": "channel" }`

Important: legacy `"open"` should not automatically imply auto-threading, because that would remove the valid behavior where an agent simply replies in the top-level channel. Users opt into no-mention auto-threading with the new object form:

```json
"DISCORD_CHANNEL_ID": { "trigger": "always", "conversation": "thread" }
```

### Internal model

Introduce a normalized channel policy type:

```ts
type DiscordianChannelTrigger = "mention" | "always" | "never";
type DiscordianConversationPlacement = "channel" | "thread";

type DiscordianChannelPolicy = {
  allowed: boolean;
  trigger: DiscordianChannelTrigger;
  conversation: DiscordianConversationPlacement;
};
```

Add a resolver that replaces/augments `resolveDiscordChannelMode(...)`:

```ts
function resolveDiscordianChannelPolicy(options: {
  channelId: string;
  parentChannelId?: string | null;
  isThread: boolean;
  allowedChannels: unknown;
  autoThreadOnMention: boolean;
}): DiscordianChannelPolicy;
```

Resolver requirements:

- For top-level messages, resolve policy from `message.channelId`.
- For thread messages, resolve policy from `parentChannelId` when available.
- Preserve current behavior for array and string forms.
- Validate unsupported object values by falling back safely to disabled or conservative mention behavior.

### Guild-message flow after refactor

Current logic uses `wasMentioned` and `isOpenChannel`. Replace that with policy-driven logic:

```ts
const policy = resolveDiscordianChannelPolicy({
  channelId: message.channelId,
  parentChannelId,
  isThread,
  allowedChannels: config.allowedChannels,
  autoThreadOnMention: config.autoThreadOnMention,
});

if (!policy.allowed) return;

const shouldTrigger =
  isThread ||
  policy.trigger === "always" ||
  (policy.trigger === "mention" && wasMentioned);

if (!shouldTrigger) return;
```

Then place the conversation:

```ts
let effectiveChatId = message.channelId;
let effectiveThreadId = isThread ? message.channelId : null;

if (!isThread && policy.conversation === "thread") {
  const createdThread = await createThreadForMessage(message, content);
  if (!createdThread) return;
  effectiveChatId = createdThread.id;
  effectiveThreadId = createdThread.id;
  await ensureDiscordianThreadRoute(message.channelId, createdThread.id);
} else if (!isThread && policy.conversation === "channel") {
  await ensureDiscordianChannelRoute(message.channelId);
} else if (isThread && effectiveThreadId) {
  await ensureDiscordianThreadRoute(parentChannelId ?? message.channelId, effectiveThreadId);
}
```

Mention normalization remains mention-specific:

```ts
const normalizedText = wasMentioned
  ? normalizeDiscordMentionText(content, botUserId)
  : content;
```

### Route helpers

The existing thread route helper should stay and be reused:

```ts
ensureDiscordianThreadRoute(parentChannelId, threadId)
```

Add a sibling helper for top-level channel conversations:

```ts
ensureDiscordianChannelRoute(channelId)
```

It should persist a route shape like:

```json
{
  "accountId": "main",
  "chatId": "DISCORD_CHANNEL_ID",
  "chatType": "channel",
  "threadId": null,
  "agentId": "...",
  "conversationId": "...",
  "enabled": true
}
```

This is needed for `conversation: "channel"` so the generic custom-channel registry can deliver top-level channel messages without manual route setup.

### Naming cleanup

Rename the existing mention-specific helper:

```ts
createThreadForMention(...)
```

to:

```ts
createThreadForMessage(...)
```

because it will now be used for both mention-triggered and always-triggered auto-threading.

Update the Discord audit reason from mention-specific wording to generic Discordian auto-thread wording.

### Documentation updates

Update `accounts.example.json` to show the new object form, likely with comments impossible in JSON so use representative IDs:

```json
"allowed_channels": {
  "DISCORD_CHANNEL_REQUIRES_MENTION_TOP_LEVEL": {
    "trigger": "mention",
    "conversation": "channel"
  },
  "DISCORD_CHANNEL_AUTO_THREAD": {
    "trigger": "always",
    "conversation": "thread"
  },
  "DISCORD_CHANNEL_MENTION_THREAD": {
    "trigger": "mention",
    "conversation": "thread"
  }
}
```

Also update implementation notes to describe the new policy model and the legacy mappings.

### Acceptance tests

Use one test channel initially by changing config between cases, or use three channels if convenient.

1. `trigger: "mention", conversation: "channel"`
   - top-level non-mention is ignored;
   - top-level mention reaches the agent;
   - agent reply appears in top-level channel;
   - no Discord thread is created.

2. `trigger: "always", conversation: "thread"`
   - top-level non-mention creates a Discord thread;
   - exact thread route is created automatically;
   - agent reply appears in the created thread;
   - Needle is not involved.

3. `trigger: "mention", conversation: "thread"`
   - top-level non-mention is ignored;
   - top-level mention creates a Discord thread;
   - agent reply appears in the created thread.

4. Existing thread messages
   - never create nested threads;
   - use parent channel policy for authorization/route inheritance;
   - ensure exact thread routes still exist.

5. Legacy config compatibility
   - array form still behaves like mention-triggered channels;
   - legacy `"open"` still permits no-mention top-level messages without forcing auto-threading;
   - legacy `"mention"` still requires a mention.

6. Bot/self behavior
   - Discordian still ignores itself;
   - `respond_to_bots` continues to control whether bot messages can trigger policies.

### Implementation order

1. Add normalized channel policy resolver and unit/smoke checks where practical.
2. Refactor guild-message flow to use policy while preserving current behavior for existing config.
3. Add object-form policy support.
4. Add `ensureDiscordianChannelRoute(...)` for top-level channel conversations.
5. Rename `createThreadForMention` to `createThreadForMessage`.
6. Update docs/examples.
7. Rebuild, deploy, and live-test the three policy combinations.
8. Commit after live validation.

## Resume plan: cleanup and validation after live auto-thread test

Status at pause:

- Source edits are in `~/Code/discordian/`.
- Runtime copy was deployed to `~/.letta/channels/discordian/` during testing.
- Latest live validation for `trigger: "always", conversation: "thread"` succeeded:
  - fresh top-level message created an exact thread route;
  - agent turn was delivered to the created thread;
  - lifecycle `Unknown Message` warning did not recur after the starter-message lifecycle skip fix.
- Low-risk cleanup already applied:
  - lifecycle skip logic extracted into `shouldSkipLifecycleReaction(source)`;
  - stale `shouldAutoThreadOnDiscordMention(...)` removed;
  - route file helpers typed with `DiscordianRoute` / `DiscordianRoutesFile`;
  - route file imports moved to top-level;
  - thread-already-created check extracted into `isDiscordThreadAlreadyExistsError(error)`;
  - `plugin.mjs` rebuilt from source.

### Remaining cleanup/design items

1. Clarify default policy semantics.
   - Current defaults are intentionally conservative but subtle:
     - no/empty `allowedChannels` means allowed, mention-triggered, channel conversation;
     - legacy string-array allowlist entries mean allowed, mention-triggered, conversation derived from `autoThreadOnMention`.
   - Decide whether this asymmetry is desired and document it clearly in README / implementation notes.

2. Use full resolved policy consistently for reaction events.
   - Reaction handling currently checks only `isDiscordGuildChannelAllowed(...)` / `.allowed` for the parent channel.
   - Decide whether `conversation: "channel"` should suppress thread reaction events, or whether reactions in existing threads should remain allowed whenever the parent channel is allowed.
   - If stricter behavior is desired, change reaction handling to call `resolveDiscordianChannelPolicy(...)` and inspect `conversation` / `trigger` as appropriate.

3. Decide how broad automatic exact thread-route creation should be.
   - Current behavior creates/migrates an exact thread route for any allowed inbound thread message before forwarding.
   - This is useful for externally-created Discord/Needle threads, but may be too permissive if a parent channel is only configured for top-level mention/channel conversations.
   - Possible stricter gates:
     - only create exact routes for threads under channels with `conversation: "thread"`;
     - only create exact routes when the message mentions the bot;
     - only create exact routes when a parent channel route already exists;
     - keep current behavior and document it as Discordian's route-repair behavior.

4. Consider stronger detection for Discord's "thread already created" error.
   - The fallback is isolated in `isDiscordThreadAlreadyExistsError(error)`, but still string-matches Discord's error message.
   - If discord.js exposes a stable error code for this case, prefer that.

5. Clean up docs before commit.
   - `docs/PLAN.md` is currently large and contains implementation-order notes that are partly complete.
   - Keep durable behavior and config semantics in `docs/IMPLEMENTATION_NOTES.md` and/or README.
   - Optionally trim completed planning prose before the final commit.

6. Run focused smoke validation after any further edits.
   - Rebuild `plugin.mjs` after source changes.
   - Deploy to `~/.letta/channels/discordian/` and restart the listener.
   - Re-test at least:
     - `trigger: "always", conversation: "thread"` fresh top-level message;
     - `trigger: "mention", conversation: "channel"` top-level mention/no-mention behavior if convenient;
     - existing thread reply route behavior.

### Suggested next steps

1. Review current diff and decide whether default policy semantics are final.
2. Decide on strict vs permissive auto-route creation for existing threads.
3. Update docs to match those decisions.
4. Rebuild/deploy and run one final live smoke test.
5. Commit source + rebuilt `plugin.mjs` once validated.

### Duplicate delivery note

A duplicate-delivery symptom appeared after repeated listener restarts/testing. Investigation showed two `letta server --debug --env-name discordian-test --channels discordian` processes were running concurrently (`45447` and `45702`). That can cause multiple Discord clients to receive the same Discord event and enqueue duplicate channel turns.

Mitigation applied before pausing:

- killed all matching `discordian-test` listener processes;
- redeployed the rebuilt plugin from `~/Code/discordian/` to `~/.letta/channels/discordian/`;
- reinstalled the channel;
- restarted a single listener process.

Current single listener PID after cleanup: `46161`.

If duplicates recur, first check for multiple listeners:

```bash
ps aux | grep 'letta server --debug --env-name discordian-test --channels discordian' | grep -v grep
```

If more than one exists, kill all matching listeners and restart exactly one. The in-adapter `markIngressMessageSeen(...)` dedupe only works within one process; it cannot dedupe Discord events received by multiple concurrently-running listener processes.

### Final smoke validation after docs/rebuild

After documenting the final policy decisions, rebuilding `plugin.mjs`, redeploying to `~/.letta/channels/discordian/`, reinstalling the channel, and restarting exactly one `discordian-test` listener, the following live Discord smoke tests passed:

- No-mention top-level message in the configured auto-thread channel created a Discord thread and exact Discordian route.
  - message/thread id: `1509537618696736841`
  - parent channel id: `1509348071664779334`
- Mentioned top-level message in the same channel also created a Discord thread and exact Discordian route.
  - message/thread id: `1509537840214839438`
  - parent channel id: `1509348071664779334`
- Each test produced one normal protocol delivery path (`update_queue` then `stream_delta`) with only one listener process running.
- No lifecycle `Unknown Message` warnings appeared for either fresh starter-message thread.
- Earlier same-day voice/no-tag delivery also reached the agent and transcription worked via the external transcribe skill.

Current validation state: ready to commit after final diff review.
- Mention inside an existing Discordian-created thread routed through the existing thread route without creating a nested thread.
  - message id: `1509538042665373797`
  - thread id: `1509537840214839438`
