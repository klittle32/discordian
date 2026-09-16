# Discordian implementation notes

This document records durable implementation details for maintainers. Historical live-test logs, local route ids, and private environment details are intentionally omitted so the repository can be published safely.

## Architecture

Discordian is implemented as a Letta Code custom channel that closely follows the native Discord adapter shape while using the custom-channel plugin contract.

Key files:

- `channel.json` declares the custom channel and runtime dependency on `discord.js`.
- `plugin.ts` normalizes account config and exports the channel plugin.
- `adapter.ts` connects to Discord, filters inbound events, prepares routes, forwards accepted messages to Letta Code, and sends outbound Discord messages.
- `plugin.mjs` is the bundled ESM artifact loaded by Letta Code.

The adapter uses the custom channel id `discordian`, not the native `discord` id.

## Custom-channel routing constraints

Letta Code's generic custom-channel registry does not automatically create Discord-aware routes. Discordian compensates by creating route records before forwarding accepted inbound messages.

The native bundled Discord channel does this with runtime-internal helpers:

- `ensureDiscordRoute(adapter, msg, config)` checks whether an inbound Discord message already has a route and decides whether a new route should be created.
- `createDiscordRoute(config, msg)` creates the route object for a Discord channel/thread/DM.
- `createConversationForAgent(agentId, summary)` creates the fresh Letta conversation used by the route.
- `addRoute(msg.channel, route)` persists that route into Letta Code's route store.

Those helpers are methods/functions inside the Letta Code runtime, not stable exports in the custom-channel plugin contract. Discordian therefore does not import them. Instead, it mirrors their behavior with public/custom-channel surfaces:

1. create a fresh Letta conversation via the public conversations API;
2. write a Discordian route record into this channel's `routing.json`;
3. forward the inbound message after the exact route exists.

Routing targets Letta Code >=0.32.11: `routing-store.ts` reads canonical `routing.json`, falling back to legacy `routing.yaml` (JSON content) only on ENOENT. Both absent means a fresh empty store; malformed documents, invalid known field types, and permission/IO errors propagate before conversation creation. Unknown top-level metadata and route fields remain intact. A legacy-only read is read-only; the next mutation writes JSON without deleting YAML. Existing JSON is never automatically merged with stale YAML, even when its routes array is empty.

`readRoutingStore(directory)` returns `{ routingPath, document }`; `writeRoutingStore(store)` preserves the whole document and writes via an exclusive same-directory temporary file (0600), file sync, close, and atomic rename, cleaning temporary files on failure. `withRoutingStoreLock(directory, operation)` must wrap the entire read/modify/write cycle. Its module-level lock serializes all accounts and adapters sharing that store within one process. It does not coordinate external CLI writers or guarantee directory-entry durability across sudden power loss. Stop listeners before link/unlink or offline recovery; back up both formats first. Recovery must be explicit and must not silently replace established conversation mappings. No runtime version detection or automatic stale-file recovery is performed.

Route creation requires a Letta API key available to the listener process because step 1 calls the public Letta API:

- preferred: `DISCORDIAN_LETTA_API_KEY` exported into the `letta server --channels discordian` process environment;
- fallback: nested `config.discordian_letta_api_key`.

Operational finding: Letta Cloud/Letta Code agent secrets available to the interactive agent/tool runtime do not automatically flow through to a separately launched `letta server` listener or its custom-channel plugin process. In local testing, removing `config.discordian_letta_api_key` and starting the listener without explicitly exporting `DISCORDIAN_LETTA_API_KEY` produced `credentialSource":"missing"` in the plugin startup log. Starting the listener with `DISCORDIAN_LETTA_API_KEY` in that process environment produced `credentialSource":"DISCORDIAN_LETTA_API_KEY"`.

The Letta base URL follows `LETTA_BASE_URL` when set and otherwise defaults to `https://api.letta.com`.

## Conversation isolation

New routes create fresh Letta conversations through the public conversations API.

Route shapes:

```json
{
  "accountId": "main",
  "chatId": "DISCORD_CHANNEL_ID",
  "chatType": "channel",
  "threadId": null,
  "agentId": "AGENT_ID",
  "conversationId": "CONVERSATION_ID",
  "enabled": true
}
```

```json
{
  "accountId": "main",
  "chatId": "DISCORD_THREAD_ID",
  "chatType": "channel",
  "threadId": "DISCORD_THREAD_ID",
  "agentId": "AGENT_ID",
  "conversationId": "CONVERSATION_ID",
  "enabled": true
}
```

```json
{
  "accountId": "main",
  "chatId": "DISCORD_DM_CHANNEL_ID",
  "chatType": "direct",
  "threadId": null,
  "agentId": "AGENT_ID",
  "conversationId": "CONVERSATION_ID",
  "enabled": true
}
```

Rules:

- Top-level channel routes get one conversation per Discord channel.
- Thread routes get one conversation per Discord thread.
- Direct-message routes get one conversation per Discord DM channel.
- New routes do not inherit a parent channel conversation, `LETTA_CONVERSATION_ID`, or `"default"`.
- Existing routes keep their stored `conversationId`.
- Legacy incomplete thread routes with `chatId === threadId` and `threadId: null` may be migrated by setting `threadId` while preserving the existing conversation.

## Authorization model

Discordian keeps generic custom-channel authorization open and enforces Discord-aware policy in the adapter.

Top-level account fields should usually be:

```json
{
  "dmPolicy": "open",
  "allowedUsers": []
}
```

Nested Discordian config controls actual policy:

```json
{
  "config": {
    "dm_policy": "allowlist",
    "allowed_users": ["DISCORD_USER_ID"],
    "respond_to_bots": false,
    "allowed_bot_ids": []
  }
}
```

Rules:

- Discordian always ignores its own bot user.
- Human DMs are controlled by nested `dm_policy` and `allowed_users`.
- Guild/channel/thread human messages are controlled by channel trigger policy and route eligibility, not the DM allowlist.
- Other bot users are ignored unless `respond_to_bots` is true.
- If `respond_to_bots` is true and `allowed_bot_ids` is empty, any non-self bot is allowed.
- If `allowed_bot_ids` contains ids, only those bot users are allowed.

## Channel policy

Channel policy separates trigger behavior from conversation placement.

- `trigger: "mention"` requires a top-level mention of the Discordian bot.
- `trigger: "always"` accepts authorized top-level messages without a mention.
- `trigger: "never"` disables the channel.
- `conversation: "channel"` routes the agent conversation to the top-level Discord channel.
- `conversation: "thread"` creates or uses a Discord thread and routes the agent conversation there.

Channel resolution order is exact channel entry, then `"*"` wildcard entry, then account/global defaults.

## Thread handling

Discordian supports both bot-created and externally-created Discord threads.

- For top-level messages in `conversation: "thread"` channels, Discordian creates or reuses a thread and forwards the original message to that thread route.
- For messages already inside a Discord thread, Discordian resolves the parent channel policy and creates an exact thread route before forwarding.
- Parent-channel thread-starter events for manually-created Discord threads are suppressed to avoid duplicate parent-channel and thread replies.

## Direct messages

DM support requires Discord-side bot settings/intents and Discordian route creation.

Accepted DM messages call `ensureDiscordianDirectRoute(chatId)` before forwarding inbound. This prevents the first authorized DM from falling through to the generic “chat is not connected to a Letta agent yet” path.

## Typing indicators

Typing indicators are lifecycle-driven.

- `processing` lifecycle events start typing for each source.
- Terminal lifecycle outcomes stop typing for each source.
- Outbound text/file sends clear typing for the target before sending the visible response.
- Adapter shutdown clears all typing timers.
- Failures to send typing are warning-only.

Discord typing is pulse-based; Discordian refreshes `sendTyping()` while active and stops by clearing the refresh interval.

## Build

```bash
bun build plugin.ts \
  --target=node \
  --format=esm \
  --outfile=plugin.mjs \
  --external:discord.js \
  --external:./runtime.mjs \
  --external:./transcription-stub.mjs

node --check plugin.mjs
```

## Public-release hygiene

Before publishing:

- Ensure `accounts.json`, route files, logs, and transcript artifacts are not tracked.
- Search for real Discord snowflakes, agent ids, conversation ids, usernames, bot names, and tokens.
- Rotate any credential that was ever committed, pasted into logs, or shown in a shared transcript.
- Add an explicit license if public reuse is intended.
