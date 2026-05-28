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
