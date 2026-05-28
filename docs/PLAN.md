# Discordian roadmap

This roadmap captures public-facing next steps. Detailed local testing history and private identifiers are intentionally excluded.

## Current status

Discordian can run as a Letta Code custom channel for Discord with support for:

- guild channels;
- Discord threads;
- direct messages;
- automatic Letta conversation and route creation;
- per-channel trigger and conversation policy;
- Discord typing indicators;
- optional lifecycle reaction acknowledgements;
- bot-message controls for integration channels.

## Near-term hardening

- Add automated tests for route creation and matching:
  - top-level channel route;
  - bot-created thread route;
  - externally-created thread route;
  - direct-message route;
  - legacy incomplete thread route migration.
- Add automated tests for channel policy resolution:
  - exact channel entry;
  - wildcard channel entry;
  - account/global fallback;
  - disabled channel;
  - mention-only versus always-on triggers.
- Add automated tests for sender authorization:
  - allowlisted human DM;
  - non-allowlisted human DM;
  - ignored self bot;
  - ignored external bot by default;
  - broad bot mode;
  - bot whitelist mode.
- Add a small route-file fixture suite to verify atomic route updates and duplicate prevention.

## Documentation improvements

- Add a Discord Developer Portal setup walkthrough with screenshots or exact setting names.
- Add troubleshooting entries for:
  - missing Discord intents;
  - missing Letta API key for route creation;
  - duplicate listener processes;
  - bot cannot send messages in a channel/thread;
  - DM not received by the bot;
  - route exists but points at an unexpected conversation.
- Document a recommended production process manager setup.

## Feature ideas

- Optional per-channel typing indicator overrides.
- Optional per-channel lifecycle reaction overrides beyond the current account/channel defaults.
- Better voice transcription integration when transcription support is exposed cleanly to custom-channel plugins.
- Route inspection/repair commands for Discordian-specific route shapes.
- Safer cleanup tooling for stale routes.
- Multi-account deployment examples.

## Compatibility notes

Discordian intentionally avoids importing private Letta Code internals. Custom-channel plugins should rely on documented plugin behavior, the public Letta API, and channel-local runtime dependencies.

If Letta Code later exposes first-party route creation helpers to custom channels, Discordian's public-API route creation shim can be simplified.
