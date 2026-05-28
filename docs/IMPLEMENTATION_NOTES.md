# Implementation Notes

## First pass

The first `discordian` implementation is copied from Letta Code's native Discord channel source and bundled into `plugin.mjs` for custom-channel loading.

Source basis:

- Letta Code `src/channels/discord/adapter.ts`
- Letta Code `src/channels/discord/channel-gating.ts`
- Letta Code `src/channels/discord/error-reply.ts`
- Letta Code `src/channels/discord/media.ts`
- Letta Code `src/channels/discord/message-actions.ts`

The copied code was adapted only where required for user custom channel loading:

- channel ID changed from `discord` to `discordian`;
- display name changed from `Discord` to `Discordian`;
- native `@/...` imports were removed or replaced;
- runtime loading now resolves `discord.js` from the custom channel runtime;
- account config is normalized from custom-channel `accounts.json` `config` fields;
- transcription import is stubbed for now because native transcription is not exposed to custom plugins;
- the plugin is bundled with Bun into `plugin.mjs` so Letta Code can import a single ESM file.

## Build command

```bash
bun build plugin.ts \
  --target=node \
  --format=esm \
  --outfile=plugin.mjs \
  --external:discord.js \
  --external:./runtime.mjs \
  --external:./transcription-stub.mjs
```

## Current parity notes

- Some first-party Discord routing behavior is still hardcoded behind `channel === "discord"`; Discordian compensates by creating exact custom-channel channel/thread routes itself before delivering inbound messages. New Discordian channel/thread routes create fresh Letta conversations via the public conversations API instead of falling back to the account/default conversation. The API key comes from `DISCORDIAN_LETTA_API_KEY` or nested `config.discordian_letta_api_key`. The base URL intentionally follows Letta Code's `LETTA_BASE_URL` environment/default instead of a per-account override.
- Native transcription is stubbed in the custom plugin copy. Audio attachments are delivered as local files, but adapter-native automatic voice transcription should be treated as a future parity enhancement.
- `MessageChannel` send/react and inbound reaction notifications have been live-tested through the custom channel path.

## Bot-to-bot response controls

Discordian defaults to ignoring messages and reactions from Discord bot users, while always ignoring its own bot user to avoid self-loops.

Two config keys control exceptions:

```json
{
  "respond_to_bots": false,
  "allowed_bot_ids": []
}
```

Semantics:

- `respond_to_bots: false`: ignore all bots, regardless of `allowed_bot_ids`.
- `respond_to_bots: true` with `allowed_bot_ids: []`: allow messages/reactions from any bot except Discordian itself.
- `respond_to_bots: true` with one or more `allowed_bot_ids`: allow only those bot user IDs.

For integrations such as Needle, prefer the whitelist form:

```json
{
  "respond_to_bots": true,
  "allowed_bot_ids": ["NEEDLE_BOT_USER_ID"]
}
```

This mirrors the Letta Discord bot example's `RESPOND_TO_BOTS` naming while adding a safer whitelist for multi-bot channels.

## Confirmed custom-channel gaps from live Discord testing

Live testing with JoJo/Johnny5 and a real Discord bot exposed two important differences between first-class Discord (`channel === "discord"`) and this custom `discordian` channel.

### Gap 1: generic custom-channel `dmPolicy` applies to guild/thread messages

Expected first-class Discord behavior:

- `dmPolicy: "allowlist"` gates direct messages.
- Guild/channel/thread messages are governed by Discord channel gating and route logic.
- Native Discord's `ensureDiscordRoute(...)` path only checks `allowedUsers` for DMs.

Observed `discordian` behavior:

- Because `discordian` does not satisfy `msg.channel === "discord"`, Letta Code skips the native Discord registry branch.
- The message falls through to generic custom-channel handling.
- Generic custom-channel handling applies `dmPolicy: "allowlist"` to every inbound message, including guild thread messages.
- A bot message that passed Discordian's adapter-level `respond_to_bots` filter was still rejected with:

```text
You are not on the allowed users list for this bot.
```

Temporary workaround used for testing:

- Add both the human Discord user ID and the source bot's Discord user ID to top-level `allowedUsers`.

Why this is not the final fix:

- `allowedUsers` is too coarse for Discord guild behavior.
- It cannot represent `respond_to_bots: true` with an empty `allowed_bot_ids` array, because the generic registry does not know which senders are bots.
- It forces bot authorization into a field intended to model user/DM authorization.

### Gap 2: externally-created Discord threads need exact thread-scoped routes

Expected first-class Discord behavior:

- Native Discord can auto-create or resolve Discord routes with thread awareness in `ensureDiscordRoute(...)` / `createDiscordRoute(...)`.
- A top-level mention can create a thread and route replies into that thread.

Observed `discordian` behavior:

- Human mentions where JoJo creates the thread now work because Discordian writes a thread route before forwarding inbound.
- Threads created externally by another bot (for example Needle) are different: Discordian receives a message already inside a thread.
- Generic custom-channel routing requires an exact route match on `(channel, accountId, chatId, threadId)`.
- `letta channels route add --chat-id <thread-id>` created a route with `threadId: null`, which did not match inbound thread messages where `threadId === chatId`.
- Manually editing the route to include `threadId: <thread-id>` made delivery work.

Working route shape for a Discord thread:

```json
{
  "accountId": "main",
  "chatId": "1509355065272434871",
  "threadId": "1509355065272434871",
  "chatType": "channel",
  "agentId": "agent-bc25ee20-21b5-42bb-b497-e3a5f3a51417",
  "conversationId": "conv-6446c2cb-e883-4502-ad55-423b88f1c9e0",
  "enabled": true
}
```

Temporary workaround used for testing:

- Manually create/update the route with `threadId` equal to the Discord thread channel ID.

Why this is not the final fix:

- The CLI cannot currently express `threadId` for `route add`.
- External bot-created threads should not require manual route-file surgery.
- This is another place where first-class Discord route creation exists but custom `discordian` falls through to generic exact matching.

## Implemented fixes

Discordian now performs Discord-specific authorization and route preparation inside the adapter/plugin boundary before handing messages to Letta Code's generic custom-channel registry.

### Fix 1: Discordian-owned auth/gating avoids generic allowlist blocking

Goal: preserve Discord-style access control while preventing generic custom-channel `dmPolicy` from incorrectly rejecting guild/thread messages.

Implemented approach:

1. Keep user config as-is in `accounts.json`:

```json
{
  "dmPolicy": "open",
  "allowedUsers": [],
  "config": {
    "dm_policy": "allowlist",
    "allowed_users": ["HUMAN_USER_ID"],
    "respond_to_bots": true,
    "allowed_bot_ids": []
  }
}
```

2. In `normalizeAccount(...)`, read Discordian's actual DM policy from nested config-only fields and expose them to the adapter under explicit names:

```ts
discordianDmPolicy: readNestedConfig(account, "dm_policy", "allowlist"),
discordianAllowedUsers: readNestedConfig(account, "allowed_users", []),
```

3. Keep top-level `dmPolicy: "open"` / `allowedUsers: []` in `accounts.json` so Letta's generic custom-channel registry does not block already-vetted guild/thread messages. The adapter enforces `discordianDmPolicy` / `discordianAllowedUsers` for DMs.

4. The adapter's sender authorization now follows these rules:

- always ignore Discordian's own bot user to prevent self-loops;
- ignore other bot users unless `respond_to_bots` is true;
- if `respond_to_bots` is true and `allowed_bot_ids` is empty, allow any non-self bot;
- if `allowed_bot_ids` contains IDs, allow only those bot users;
- apply `config.dm_policy` / `config.allowed_users` only to direct messages;
- do not use DM allowlists to reject guild/channel/thread messages.

5. Rejection messages are Discord-specific and only appear in the appropriate surface:

- Unauthorized DM human: send allowlist rejection.
- Unauthorized bot: silently ignore by default to avoid bot-loop noise, or log in debug only.
- Unauthorized guild human should be controlled by channel gating / route presence, not `allowedUsers`.

Acceptance tests / live validation:

- Guild/thread human messages are not rejected solely because the sender is absent from top-level `allowedUsers`.
- `respond_to_bots: true`, `allowed_bot_ids: []` allows Needle while still ignoring Discordian itself.
- Needle-created threads reach the agent without adding Needle to top-level `allowedUsers`.

Remaining tests if needed before broader release:

- Human allowlisted DM reaches the agent.
- Non-allowlisted human DM is rejected.
- `respond_to_bots: false` ignores Needle/other bots.
- `respond_to_bots: true`, `allowed_bot_ids: ["NEEDLE_ID"]` allows Needle and ignores other bots.

### Fix 2: auto-create exact thread routes for externally-created threads

Goal: when Discordian receives an allowed message inside a Discord thread that lacks a thread route, create the exact custom-channel route needed by generic routing before forwarding inbound.

Implemented approach:

1. Generalize the existing `ensureDiscordianThreadRoute(parentChannelId, threadId)` shim.

Current shim handles top-level mentions where Discordian creates the thread. It should also run for messages that are already inside a Discord thread.

2. For any inbound guild thread message that passes sender/channel gating:

```ts
if (isThread && effectiveThreadId) {
  await ensureDiscordianThreadRoute(parentChannelId ?? message.channelId, effectiveThreadId);
}
```

3. Route derivation rules:

- Use account config `agent_id`; if it is missing, do not auto-create a new route.
- For new routes, create a fresh Letta conversation for that agent through the public conversations API.
- Never inherit `conversationId` from a parent-channel route, `config.conversationId`, `LETTA_CONVERSATION_ID`, or `"default"`.
- If a legacy incomplete thread route already exists with `chatId === threadId` and `threadId: null`, migrate only the route metadata and preserve its existing `conversationId`.

4. Persist route shape exactly as generic custom-channel matching expects:

```json
{
  "accountId": config.accountId,
  "chatId": threadId,
  "threadId": threadId,
  "chatType": "channel",
  "agentId": resolvedAgentId,
  "conversationId": resolvedConversationId,
  "enabled": true
}
```

5. Prevent duplicate routes:

- Check for an existing exact `(accountId, chatId: threadId, threadId)` route before writing.
- Also consider migrating a legacy/incomplete `(chatId: threadId, threadId: null)` route to `threadId: threadId` if present.

6. Preserve routing.yaml safely:

- Continue using JSON-compatible formatting for the current file because Letta accepts it as YAML.
- Use atomic-ish write (`write temp` then rename) if this grows beyond test code, to avoid corrupting routes on process interruption.

7. Add debug logging for route creation/migration:

```text
[Discordian] Created thread route { accountId, parentChannelId, threadId, agentId, conversationId }
[Discordian] Migrated thread route from null threadId to exact threadId { ... }
```

Acceptance tests:

- JoJo-created mention thread still routes and replies into the created thread.
- Needle/external bot-created thread routes automatically without manual `routing.yaml` editing.
- Restart preserves created routes.
- Duplicate messages in the same thread do not create duplicate routes.
- A stale `threadId: null` route for a thread is upgraded or no longer blocks correct routing.

### Live validation summary

Validated with the local `discordian-test` listener and JoJo Discord bot:

- Needle-created thread messages route to Johnny5 with `respond_to_bots: true` and `allowed_bot_ids: []`.
- Exact thread routes are auto-created with `chatId === threadId` and `threadId === threadId`.
- Replies sent through `MessageChannel` land in the correct thread.
- Audio attachments are copied to local temp paths and delivered in inbound notifications.
- Inbound reactions are delivered as reaction notifications.
- Outbound reactions via `MessageChannel` work.

## Config simplification: replace `original_*` with Discordian-owned policy names

The initial adapter-owned auth implementation briefly used interim `original_*` names to preserve the user's top-level custom-channel policy while bypassing generic registry policy. Those names were removed before commit; the supported user-facing configuration is now `dm_policy` and `allowed_users` under `config`.

Preferred model:

```json
{
  "dmPolicy": "open",
  "allowedUsers": [],
  "config": {
    "dm_policy": "allowlist",
    "allowed_users": ["295423483368964096"],
    "respond_to_bots": true,
    "allowed_bot_ids": []
  }
}
```

Top-level `dmPolicy`/`allowedUsers` are registry compatibility fields for the generic custom-channel path. They should remain open/empty for Discordian so the generic registry does not reject guild/thread/bot messages.

Nested `config.dm_policy`/`config.allowed_users` are Discordian's actual DM authorization policy, enforced by the adapter with Discord awareness. Bot authorization remains controlled separately by `config.respond_to_bots` and `config.allowed_bot_ids`.

The interim `original_*` aliases have been removed from code and examples; use only `dm_policy` and `allowed_users` under `config`.

## Per-channel trigger and conversation policies

Discordian uses `config.channels` as a first-class per-channel override map. It is not an allowlist. For any guild message, Discordian resolves the effective config in this order:

1. exact channel entry: `channels[gateChannelId]`;
2. wildcard entry: `channels["*"]`;
3. account/global defaults.

For messages inside Discord threads, `gateChannelId` is the parent channel id when available; otherwise it is the message channel id. Missing channel entries are allowed and use global defaults. Use `enabled: false` or `trigger: "never"` to block a channel.

`trigger` controls top-level channel messages:

- `mention`: require a Discordian bot mention.
- `always`: allow any authorized sender message without a mention.
- `never`: explicitly disable the channel.

`conversation` controls placement after a message triggers:

- `channel`: keep the agent conversation in the top-level Discord channel.
- `thread`: create/use a Discord thread and route replies there.

When `conversation` is omitted, mention-triggered entries inherit the account-level `auto_thread_on_mention` default (`true` -> `thread`, `false` -> `channel`); non-mention triggers default to `channel`.

For `conversation: "channel"`, Discordian auto-creates a top-level channel route with a fresh Letta conversation when `agent_id` is configured. For `conversation: "thread"`, Discordian reuses the exact thread route creation/migration path and creates a fresh Letta conversation for each new Discord thread. Existing thread messages under a parent channel use route repair so externally-created Discord/Needle threads continue working without manual route edits. Parent-channel thread-starter events for manually-created Discord threads are suppressed to avoid duplicate parent-channel replies. Reaction events follow the same effective parent-channel config for thread messages.

## Operational note: duplicate listeners

Discord delivers events to every logged-in client for the same bot. During development, running two `letta server --channels discordian` listeners against the same account causes duplicate inbound deliveries. The adapter's `markIngressMessageSeen(...)` dedupe is process-local and cannot dedupe across multiple listener processes.

Check before live tests:

```bash
ps aux | grep 'letta server --debug --env-name discordian-test --channels discordian' | grep -v grep
```

Kill duplicate listeners and restart exactly one if duplicates appear.

## First-class per-channel config

`channels` entries can override account-level bot participation and lifecycle acknowledgement defaults:

```json
{
  "auto_thread_on_mention": true,
  "respond_to_bots": false,
  "allowed_bot_ids": [],
  "acknowledge_message_reaction": false,
  "channels": {
    "HUMAN_CHANNEL": {
      "enabled": true,
      "trigger": "mention"
    },
    "NEEDLE_CHANNEL": {
      "enabled": true,
      "trigger": "mention",
      "conversation": "thread",
      "respond_to_bots": true,
      "allowed_bot_ids": ["NEEDLE_BOT_USER_ID"]
    }
  }
}
```

Resolution rules:

- Exact channel entries win over `"*"`; `"*"` wins over account/global defaults.
- If no channel entry matches and no wildcard exists, Discordian uses account/global defaults.
- Channel `respond_to_bots`, `allowed_bot_ids`, and `acknowledge_message_reaction` override account defaults only for that channel.
- Optional `comment` and `channel_name` fields are inert metadata for human operators editing `accounts.json`; the channel ID key remains authoritative.
- Discordian's own bot user is always ignored globally and cannot be enabled by channel config.
- Guild sender bot filtering happens after resolving effective channel config, so a Needle/integration channel can allow bot messages without allowing bots everywhere.
- DM authorization continues to use account-level Discordian DM config.
