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

## Next enhancement: first-class per-channel config

Goal: promote Discordian's per-channel behavior from an `allowed_channels` policy map into a first-class `channels` config model with account-level defaults and channel-level overrides.

The previous change added per-channel `trigger` and `conversation` under `allowed_channels`. That works, but the broader model should let each Discord channel decide more than just routing. In particular, bot participation is channel-specific: normal human channels should often ignore bots, while integration channels may need to accept messages from Needle or other specific bots.

### Desired config model

Preferred future shape under each account's `config`:

```json
{
  "respond_to_bots": false,
  "allowed_bot_ids": [],
  "acknowledge_message_reaction": false,
  "allowed_channels": [],
  "channels": {
    "HUMAN_SUPPORT_CHANNEL_ID": {
      "enabled": true,
      "trigger": "mention",
      "conversation": "channel"
    },
    "NEEDLE_TRIAGE_CHANNEL_ID": {
      "enabled": true,
      "trigger": "always",
      "conversation": "thread",
      "respond_to_bots": true,
      "allowed_bot_ids": ["NEEDLE_BOT_USER_ID"]
    },
    "BOT_LAB_CHANNEL_ID": {
      "enabled": true,
      "trigger": "always",
      "conversation": "thread",
      "respond_to_bots": true,
      "allowed_bot_ids": [],
      "acknowledge_message_reaction": true
    }
  }
}
```

`channels` is the preferred first-class model. `allowed_channels` remains supported as a legacy/compatibility input.

### Account defaults vs per-channel overrides

Account-level config provides defaults:

- `respond_to_bots`
- `allowed_bot_ids`
- `acknowledge_message_reaction`
- existing DM-only policy fields such as `dm_policy` and `allowed_users`

Per-channel config may override:

- `enabled`
- `trigger`
- `conversation`
- `respond_to_bots`
- `allowed_bot_ids`
- `acknowledge_message_reaction`

Effective inheritance rules:

```ts
effective.respondToBots =
  channel.respond_to_bots ?? account.respond_to_bots ?? false;

effective.allowedBotIds =
  channel.allowed_bot_ids ?? account.allowed_bot_ids ?? [];

effective.acknowledgeMessageReaction =
  channel.acknowledge_message_reaction ??
  account.acknowledge_message_reaction ??
  false;
```

Discordian's own bot user is always ignored globally. No per-channel override should allow self-loops.

### Bot authorization semantics

For a guild/channel message after resolving its effective channel config:

1. Human users are allowed if the channel config allows the channel and the message satisfies `trigger` rules.
2. Bot users are always ignored when the bot user is Discordian itself.
3. Other bot users are ignored unless `effective.respondToBots === true`.
4. If `effective.respondToBots === true` and `effective.allowedBotIds` is empty, allow any non-self bot.
5. If `effective.respondToBots === true` and `effective.allowedBotIds` contains IDs, allow only those bot user IDs.

This permits useful channel-specific patterns:

- normal support channels ignore all bots;
- Needle integration channels accept only Needle;
- bot lab/test channels accept any non-self bot.

### Trigger and conversation semantics

Preserve the existing policy behavior:

- `trigger: "mention"` means top-level channel messages require a Discordian bot mention;
- `trigger: "always"` means authorized top-level messages do not require a mention;
- `trigger: "never"` or `enabled: false` disables the channel;
- `conversation: "channel"` keeps replies in the top-level channel;
- `conversation: "thread"` creates/uses a Discord thread and routes replies there.

Thread messages under an allowed parent channel continue to route through existing/permissive route repair and should not create nested threads.

### Backward compatibility

Keep all existing config forms working:

- `allowed_channels: []` or missing: conservative default, allowed but mention-triggered and channel conversation;
- `allowed_channels: ["CHANNEL_ID"]`: legacy allowlist, mention-triggered, placement derived from `auto_thread_on_mention`;
- `allowed_channels` object with string/boolean modes: preserve current mappings;
- `allowed_channels` object with `{ trigger, conversation }`: preserve current behavior;
- `auto_thread_on_mention` and `thread_policy_by_channel`: legacy inputs only, used to derive defaults for old config forms.

When both `channels` and `allowed_channels` mention the same channel, `channels` wins. `allowed_channels` acts as compatibility fallback only.

### Proposed internal model

Add a richer effective config type, replacing the current narrow policy shape at adapter call sites:

```ts
type DiscordianChannelTrigger = "mention" | "always" | "never";
type DiscordianConversationPlacement = "channel" | "thread";

interface DiscordianEffectiveChannelConfig {
  allowed: boolean;
  trigger: DiscordianChannelTrigger;
  conversation: DiscordianConversationPlacement;
  respondToBots: boolean;
  allowedBotIds: string[];
  acknowledgeMessageReaction: boolean;
}
```

The resolver should accept both account defaults and channel-specific maps:

```ts
function resolveDiscordianEffectiveChannelConfig(options: {
  channelId: string;
  parentChannelId?: string | null;
  isThread: boolean;
  channels?: unknown;
  allowedChannels?: unknown;
  autoThreadOnMention?: boolean;
  respondToBots?: boolean;
  allowedBotIds?: unknown;
  acknowledgeMessageReaction?: boolean;
}): DiscordianEffectiveChannelConfig;
```

`resolveDiscordianChannelPolicy(...)` can remain as a compatibility wrapper that calls the richer resolver and returns only `{ allowed, trigger, conversation }`.

### Adapter flow changes

Current sender processing applies global `respondToBots` before guild channel policy is fully resolved. The refactor should split sender processing by chat type:

1. Ignore self immediately for all messages/reactions.
2. For DMs:
   - continue using account-level DM policy;
   - apply account-level bot policy if DMs from bots are ever relevant.
3. For guild/channel messages:
   - compute `parentChannelId`, `isThread`, and effective channel config first;
   - reject disabled/disallowed channels;
   - apply effective channel bot policy;
   - apply trigger rules for top-level messages;
   - create channel/thread routes as today;
   - include effective flags in the inbound source where needed.
4. For reactions:
   - compute effective channel config using the parent channel for thread messages;
   - apply effective bot policy;
   - use `effective.acknowledgeMessageReaction` / reaction policy where relevant.

### Implementation plan

1. Extend account normalization in `plugin.ts`.
   - Read nested `config.channels` into `config.channels`.
   - Keep existing `allowed_channels`, `respond_to_bots`, `allowed_bot_ids`, and `acknowledge_message_reaction` fields.

2. Extend `channel-gating.ts`.
   - Define `DiscordianEffectiveChannelConfig`.
   - Add helpers to normalize string lists and booleans safely.
   - Add `resolveDiscordianEffectiveChannelConfig(...)`.
   - Preserve `resolveDiscordianChannelPolicy(...)` and `isDiscordGuildChannelAllowed(...)` as wrappers for compatibility.
   - Ensure `channels` overrides `allowed_channels` for the same channel.

3. Refactor adapter guild message flow.
   - Resolve effective config before guild sender bot filtering.
   - Replace global `respondToBots` use for guild messages with effective channel bot policy.
   - Keep DM handling behavior unchanged except for any necessary helper extraction.

4. Refactor reaction flow.
   - Resolve effective config for thread reactions.
   - Apply effective bot policy.
   - Decide whether per-channel `acknowledge_message_reaction` affects reaction notifications, lifecycle acks, or both; document the chosen semantics.

5. Update examples and docs.
   - `accounts.example.json` should show `channels` as preferred.
   - README should describe account defaults + channel overrides.
   - Implementation notes should mark `allowed_channels` as legacy-compatible.

6. Add lightweight tests if practical.
   - Test effective config resolution for:
     - account defaults only;
     - channel overrides;
     - bot whitelist inheritance;
     - `channels` winning over `allowed_channels`;
     - legacy allowed-channel forms.

7. Rebuild and live-test.
   - Rebuild `plugin.mjs`.
   - Deploy/reinstall/restart one listener.
   - Smoke test:
     - human no-tag auto-thread channel;
     - Needle/bot-allowed channel if available;
     - bot-disallowed channel if available;
     - existing thread message;
     - reactions if possible.

8. Commit after validation.

### Per-channel config refactor smoke validation

After implementing first-class `config.channels`, removing the duplicate live `allowed_channels` entry, deploying the current repo to `~/.letta/channels/discordian/`, reinstalling, and restarting a single listener, the following live tests passed:

- `channels`-only config drove top-level no-tag auto-thread behavior with `allowed_channels: {}`.
  - message/thread id: `1509547058036609174`
- Existing-thread no-tag and tagged human messages routed through the existing thread without nested threads.
  - no-tag message id: `1509547278921105620`
  - tagged message id: `1509547452221489272`
  - thread id: `1509547058036609174`
- Old thread routing continued to work after the refactor and route-repair path.
  - old thread id: `1509533185837629450`
  - message id: `1509547680643154032`
- Needle-created thread flow worked with per-channel bot override enabled on `#needle-jojo`.
  - Needle sender id: `1509256975060304035`
  - Needle message id: `1509554928530755746`
  - thread/original message id: `1509554925955190864`
  - parent channel id: `1509348071664779334`
- `#needle-jojo` also handled a top-level human message with a JoJo mention directly, creating a JoJo thread while Needle skipped it.
  - message/thread id: `1509555347319423016`
- `#jojo-only-mention-required` accepted a top-level human message only when JoJo was mentioned, then created a thread.
  - accepted message/thread id: `1509556178756309073`
  - a separate no-mention top-level message in the same channel produced no Discordian delivery, confirming the negative path.
- `#jojo-only-no-mention-or-thread` accepted top-level human messages without a mention and stayed in the channel rather than creating a thread.
  - no-mention message id: `1509556671742087168`
  - mention message id: `1509556922578370640`
  - channel/chat id: `1509552736587350119`
- Each validation used one listener process and produced one normal protocol delivery when a delivery was expected.
- No lifecycle `Unknown Message` / reaction warnings appeared during these tests.

Current validation state: ready to commit. Optional future hardening: restrict `#needle-jojo` `allowed_bot_ids` to Needle's bot user id instead of allowing any non-self bot, if that channel should become Needle-only rather than bot-friendly.

### Roadmap: Discord reply-reference / grouped-message placement

Future enhancement idea: add a placement style between current `conversation: "channel"` and `conversation: "thread"`.

Options considered:

- Keep `conversation: "channel"` and add a send-style flag such as `reply_to_message: true`, causing outbound replies to use Discord's message-reference UI while staying in the top-level channel.
- Add a shorthand/alias such as `conversation: "reply"` for channel placement with Discord reply references.
- Detect situations where multiple user messages arrive before the Letta agent responds and group them into a thread instead of replying to one specific source message.

Open design questions:

- If a single agent response corresponds to multiple inbound Discord messages, which message should the Discord reply reference?
  - latest source message;
  - first source message;
  - no reference when ambiguous;
  - split replies, if the runtime ever supports that cleanly.
- Should grouped-message detection be a channel policy, a debounce policy, or a runtime-level behavior?
- How would this interact with existing `conversation: "thread"` auto-threading and route repair?

Decision for now: table this as a roadmap/future enhancement. Current refactor remains focused on first-class per-channel config, per-channel bot policy, and existing channel/thread placement behavior.

## Cleanup plan: simplify channel config before public release

Goal: remove unnecessary legacy channel-config support while keeping useful account/global defaults. This project is still private/new, so we can simplify the public config surface before open-sourcing it for the Letta community.

Desired config model:

- `config.channels` is an override map, not an allowlist.
- Effective channel config resolution precedence is:
  1. exact channel entry: `channels[gateChannelId]`;
  2. wildcard entry: `channels["*"]`;
  3. account/global defaults.
- For thread messages, `gateChannelId` is the parent channel id when available; otherwise it is the message channel id.
- Missing channel entries are allowed and use account defaults.
- `enabled: false` or `trigger: "never"` explicitly disables a channel or wildcard/default override.

Keep these account/global defaults:

```json
{
  "auto_thread_on_mention": true,
  "respond_to_bots": false,
  "allowed_bot_ids": [],
  "acknowledge_message_reaction": false
}
```

Default resolution:

```ts
const entry = channels[gateChannelId] ?? channels["*"] ?? {};

const trigger = entry.trigger ?? "mention";
const conversation = entry.conversation
  ?? (trigger === "mention" && autoThreadOnMention !== false
    ? "thread"
    : "channel");
const respondToBots = entry.respond_to_bots ?? account.respond_to_bots ?? false;
const allowedBotIds = entry.allowed_bot_ids ?? account.allowed_bot_ids ?? [];
const acknowledgeMessageReaction =
  entry.acknowledge_message_reaction
  ?? account.acknowledge_message_reaction
  ?? false;
```

Remove these legacy config surfaces from runtime support and public docs:

- `allowed_channels` / `allowedChannels`;
- legacy string modes under `allowed_channels` (`"open"`, `"mention"`, `"mention-only"`, etc.);
- array allowlist behavior under `allowed_channels`;
- boolean channel policies;
- old `{ trigger, conversation }` policy objects under `allowed_channels`;
- `thread_policy_by_channel` / `threadPolicyByChannel`, assuming no remaining runtime dependency.

Keep:

- `auto_thread_on_mention` as an account/global default that channel entries can inherit;
- `channels` exact entries and optional `channels["*"]`;
- per-channel `enabled`, `trigger`, `conversation`, `respond_to_bots`, `allowed_bot_ids`, and `acknowledge_message_reaction`;
- optional inert `comment` and `channel_name` metadata.

Implementation steps:

1. Simplify `channel-gating.ts` to resolve only first-class `channels` plus global defaults.
2. Remove `allowedChannels` and `threadPolicyByChannel` normalization from `plugin.ts`.
3. Stop passing `allowedChannels` from `adapter.ts`.
4. Remove obsolete compatibility wrappers/helpers if no code uses them.
5. Remove legacy/deprecated config references from README, example config, and implementation notes; keep old history in `docs/PLAN.md` only as historical context.
6. Rebuild `plugin.mjs`, run syntax/diff checks, redeploy, and re-run the three-channel smoke matrix.

### Next roadmap item: per-thread Letta conversation isolation

This is the next significant roadmap item after the first-class channel config cleanup. It is a delicate routing/context feature and should be investigated and implemented separately from the channel-policy refactors.

Live testing confirmed that manually-created Discord threads under a `conversation: "channel"` parent are routed and repaired correctly, but they currently reuse the configured/default Letta conversation rather than allocating a fresh context window per Discord thread.

Observed example:

- parent channel id: `1509552736587350119`
- manual thread/chat id: `1509569713477255278`
- route used existing Letta conversation: `conv-6446c2cb-e883-4502-ad55-423b88f1c9e0`

Current behavior:

- `conversation: "channel"` prevents automatic thread creation for top-level messages.
- Existing/manual Discord threads are still accepted via route repair.
- Route repair creates a separate Discordian chat surface for the thread, but binds it to the same configured/default Letta conversation.

Target behavior to investigate:

- Each Discord thread should get exactly one Letta conversation/context window.
- Existing thread routes should be reused.
- Missing thread routes should create a fresh Letta conversation bound to the configured agent, then bind the Discord thread route to that conversation.
- Top-level channel routes may remain shared channel-level conversations.
- Thread route creation/repair should avoid silently reusing the account/default conversation unless an explicit compatibility policy is introduced.

Open questions:

- Which runtime/API path should create a Letta conversation from inside a custom-channel adapter?
- Should this apply to all Discord threads, only auto-created threads, only manual/external threads, or be configurable?
- Should `conversation: "thread"` always imply new Letta conversation per Discord thread?
- How should existing routes be migrated if this changes?
- How should thread history seeding interact with a fresh Letta conversation?
- What starter context should be injected for auto-created, manual, and Needle-created threads?
- How should failures be surfaced if thread route creation succeeds but conversation creation fails?

Initial implementation sketch:

1. Locate the Letta Code custom-channel route creation/repair path and determine whether it can create conversations directly.
2. If needed, add or call a runtime/API helper that creates a conversation for the configured agent.
3. On missing Discord thread route, create a new Letta conversation, then persist the thread route with that conversation id.
4. Reuse existing thread routes unchanged.
5. Seed new thread conversations with the thread starter/recent history where practical.
6. Test auto-created threads, manual threads, Needle-created threads, repeated messages in the same thread, and top-level channel routes.

Decision for now: treat this as the next major roadmap item, not part of the current channel-config cleanup.

### Routing decision: one Letta conversation per Discord chat surface

User decision: Discordian should not route all Discord traffic to the configured/default Letta conversation. The default conversation should be treated only as bootstrap/configuration context, not as the runtime destination for every Discord channel/thread.

Desired runtime routing semantics:

- Each Discord thread gets a fresh Letta conversation when Discordian first sees that thread and no route exists yet.
- Do not seed new thread conversations with other thread history, parent channel history, or other extra context.
- Treat the first inbound message delivered from that Discord thread as the first message in the fresh Letta conversation.
- If a thread route already exists, reuse its existing Letta conversation.
- If a channel's effective `conversation` mode is `"channel"`, the top-level Discord channel itself is one shared Letta conversation.
- Each top-level Discord channel gets its own Letta conversation, just like each thread does.
- If a top-level channel route does not already point to a Letta conversation, create a new Letta conversation for that channel instead of routing to the account/default conversation.
- If a top-level channel route already exists, reuse its existing Letta conversation.
- Auto-created threads, manually-created Discord threads, and Needle/external integration threads all follow the same per-thread route rule.

Practical route model:

```text
Discord channel id  -> route(chatId = channel id, threadId = null)      -> one Letta conversation
Discord thread id   -> route(chatId = thread id, threadId = thread id)   -> one Letta conversation
```

Important implications:

- Top-level channel context and thread context are isolated from each other by default.
- Different top-level channels are isolated from each other by default.
- Different Discord threads are isolated from each other by default.
- A Discord thread's first delivered message may be a Needle-routed wrapper or a manually-created thread starter; that message becomes the first message in the new Letta conversation.
- No route should silently fall back to the account/default conversation when a new Discord chat surface is first observed, except as a temporary compatibility behavior before this feature is implemented.

Implementation notes to investigate:

- Find the custom-channel runtime/API path for creating a new Letta conversation for an existing agent.
- Replace current route-repair behavior that copies `config.conversationId` into new channel/thread routes.
- Ensure route creation remains idempotent under duplicate Discord events or listener restarts.
- Preserve existing routes and their conversation ids; do not migrate old routes automatically without an explicit migration decision.
- Decide how to handle conversation-creation failure: likely send a visible error to the originating Discord surface and avoid creating a broken route.
