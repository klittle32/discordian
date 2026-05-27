import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CHANNEL_ID = "discordian";
export const DISPLAY_NAME = "Discordian";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function loadDiscordModule() {
  const require = createRequire(import.meta.url);
  const candidates = [
    join(__dirname, "runtime", "package.json"),
    join(__dirname, "package.json"),
  ];

  for (const candidate of candidates) {
    try {
      const resolved = createRequire(candidate).resolve("discord.js");
      return import(pathToFileURL(resolved).href);
    } catch {
      // Try next location.
    }
  }

  try {
    const resolved = require.resolve("discord.js");
    return import(pathToFileURL(resolved).href);
  } catch {
    throw new Error(
      'Discordian support is not installed. Run: letta channels install discordian',
    );
  }
}
