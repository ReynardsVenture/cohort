/**
 * Injectable channel send for dispatcher tests.
 * Telegram/WhatsApp/SMS have no native idempotency keys on send.
 * Policy: never re-HTTP if provider_message_id or a completed delivery_attempts row exists.
 */
import { sendToChannel as defaultSend } from "./dispatcher-providers.ts";
import type { ChannelType } from "./types.ts";

export type SendToChannelFn = (
  channel: ChannelType,
  externalId: string,
  templateKey: string,
  payload: Record<string, unknown>,
) => Promise<{ providerMessageId: string }>;

let sendImpl: SendToChannelFn = defaultSend;

export function setSendToChannelForTests(fn: SendToChannelFn | null): void {
  sendImpl = fn ?? defaultSend;
}

export function getSendToChannel(): SendToChannelFn {
  return sendImpl;
}
