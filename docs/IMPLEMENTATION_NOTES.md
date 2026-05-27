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

## Known parity gaps to test

- Native Discord-specific routing special cases may only apply to `channel === "discord"`.
- Native transcription is stubbed and should be revisited after basic parity works.
- `prepareInboundMessage` and lifecycle reactions exist in the adapter, but custom-channel runtime support still needs verification.
