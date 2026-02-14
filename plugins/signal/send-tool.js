/**
 * send-signal-message tool — allows KarnEvil9 agents to send messages via Signal.
 */

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const sendSignalMessageManifest = {
  name: "send-signal-message",
  version: "1.0.0",
  description: "Send a message to a Signal recipient",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      recipient: { type: "string", description: "Recipient phone number (E.164 format)" },
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
  permissions: ["signal:send:messages"],
  timeout_ms: 10000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, recipient: "+1234567890" }],
};

/**
 * Create a tool handler for send-signal-message.
 * @param {import("./signal-client.js").SignalClient} signalClient
 * @returns {import("@karnevil9/schemas").ToolHandler}
 */
export function createSendSignalMessageHandler(signalClient) {
  return async (input, mode, _policy) => {
    if (mode === "mock") {
      return { ok: true, recipient: input.recipient ?? "+0000000000" };
    }
    if (mode === "dry_run") {
      return { ok: true, recipient: input.recipient, dry_run: true };
    }

    await signalClient.sendLongMessage({
      recipient: input.recipient,
      message: input.message,
    });

    return {
      ok: true,
      recipient: input.recipient,
    };
  };
}
