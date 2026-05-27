import { CHANNEL_ID, DISPLAY_NAME } from "./runtime.mjs";

async function sendDiscordMessage(ctx) {
  const { request, route, adapter, formatText } = ctx;
  const text = request.message ?? "";

  if (text.trim().length === 0 && !request.mediaPath) {
    return "Error: Discord send requires message or media.";
  }

  const formatted = formatText(text);
  const result = await adapter.sendMessage({
    channel: CHANNEL_ID,
    accountId: route.accountId,
    chatId: request.chatId,
    text: formatted.text,
    replyToMessageId: request.replyToMessageId,
    threadId: request.threadId ?? route.threadId ?? null,
    mediaPath: request.mediaPath,
    fileName: request.filename,
    title: request.title,
    parseMode: formatted.parseMode,
  });

  return request.mediaPath
    ? `Attachment sent to ${DISPLAY_NAME} (message_id: ${result.messageId})`
    : `Message sent to ${DISPLAY_NAME} (message_id: ${result.messageId})`;
}

async function reactInDiscord(ctx) {
  const { request, route, adapter } = ctx;

  if (!request.emoji?.trim()) {
    return "Error: Discord react requires emoji.";
  }
  if (!request.messageId?.trim()) {
    return "Error: Discord react requires messageId.";
  }

  const result = await adapter.sendMessage({
    channel: CHANNEL_ID,
    accountId: route.accountId,
    chatId: request.chatId,
    text: "",
    targetMessageId: request.messageId,
    reaction: request.emoji,
    removeReaction: request.remove,
    threadId: request.threadId ?? route.threadId ?? null,
  });

  return request.remove
    ? `Reaction removed on ${DISPLAY_NAME} (message_id: ${result.messageId})`
    : `Reaction added on ${DISPLAY_NAME} (message_id: ${result.messageId})`;
}

export const discordianMessageActions = {
  describeMessageTool() {
    return {
      actions: ["send", "react", "upload-file"],
    };
  },

  async handleAction(ctx) {
    switch (ctx.request.action) {
      case "send":
        return await sendDiscordMessage(ctx);
      case "upload-file":
        if (!ctx.request.mediaPath?.trim()) {
          return "Error: Discord upload-file requires media.";
        }
        return await sendDiscordMessage(ctx);
      case "react":
        return await reactInDiscord(ctx);
      default:
        return `Error: Action "${ctx.request.action}" is not supported on ${DISPLAY_NAME}.`;
    }
  },
};
