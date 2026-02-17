/**
 * send-whatsapp-message tool — allows KarnEvil9 agents to send messages via WhatsApp.
 */
import { numberToJid } from "./access-control.js";

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const sendWhatsAppMessageManifest = {
  name: "send-whatsapp-message",
  version: "1.0.0",
  description: "Send a message to a WhatsApp recipient",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      recipient: { type: "string", description: "Recipient phone number (E.164 format, e.g. +1234567890) or WhatsApp JID" },
      message: { type: "string", description: "Message text" },
    },
    required: ["recipient", "message"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      recipient: { type: "string" },
    },
  },
  permissions: ["whatsapp:send:messages"],
  timeout_ms: 10000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, recipient: "+1234567890" }],
};

/**
 * Create a tool handler for send-whatsapp-message.
 * @param {import("./whatsapp-client.js").WhatsAppClient} whatsappClient
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createSendWhatsAppMessageHandler(whatsappClient) {
  return async (input, mode, _policy) => {
    if (mode === "mock") {
      return { ok: true, recipient: input.recipient ?? "+0000000000" };
    }
    if (mode === "dry_run") {
      return { ok: true, recipient: input.recipient, dry_run: true };
    }

    // Convert E.164 phone number to JID if needed
    const jid = input.recipient.includes("@")
      ? input.recipient
      : numberToJid(input.recipient);

    await whatsappClient.sendLongMessage({
      jid,
      message: input.message,
    });

    return {
      ok: true,
      recipient: input.recipient,
    };
  };
}
