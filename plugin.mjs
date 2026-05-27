import crypto from "node:crypto";

const CHANNEL_ID = "discordian";

class DiscordianAdapter {
  constructor(account) {
    this.id = `${CHANNEL_ID}:${account.accountId}`;
    this.channelId = CHANNEL_ID;
    this.accountId = account.accountId;
    this.name = account.displayName ?? "Discordian";
    this.account = account;
    this.running = false;
    this.onMessage = undefined;
  }

  async start() {
    // TODO: connect to the target platform and call this.onMessage(...) for each inbound message.
    this.running = true;
  }

  async stop() {
    // TODO: close sockets, polling loops, HTTP servers, or SDK clients here.
    this.running = false;
  }

  isRunning() {
    return this.running;
  }

  async sendMessage(message) {
    // TODO: send message.text to message.chatId through the target platform.
    // Return the platform's message identifier when available.
    return { messageId: crypto.randomUUID() };
  }

  async sendDirectReply(chatId, text) {
    await this.sendMessage({ chatId, text });
  }
}

export const channelPlugin = {
  metadata: {
    id: CHANNEL_ID,
    displayName: "Discordian",
    runtimePackages: [],
    runtimeModules: [],
  },

  async createAdapter(account) {
    return new DiscordianAdapter(account);
  },

  messageActions: {
    describeMessageTool() {
      return { actions: ["send"] };
    },

    async handleAction({ adapter, request, formatText }) {
      const formatted = formatText(request.message ?? "");
      const result = await adapter.sendMessage({
        channel: request.channel,
        chatId: request.chatId,
        text: formatted.text,
        parseMode: formatted.parseMode,
        threadId: request.threadId,
      });

      return `Message sent to ${request.channel} (message_id: ${result.messageId})`;
    },
  },
};

export default channelPlugin;
