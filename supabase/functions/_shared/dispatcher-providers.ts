import { renderTemplate } from "./templates.ts";
import type { ChannelType } from "./types.ts";

export async function sendToChannel(
  channel: ChannelType,
  externalId: string,
  templateKey: string,
  payload: Record<string, unknown>,
): Promise<{ providerMessageId: string }> {
  const text = renderTemplate(templateKey, payload);

  switch (channel) {
    case "telegram":
      return sendTelegram(externalId, text);
    case "whatsapp":
      return sendWhatsApp(externalId, text);
    case "sms":
      return sendSms(externalId, text);
    default:
      throw new Error(`unsupported_channel:${channel}`);
  }
}

async function sendTelegram(chatId: string, text: string): Promise<{ providerMessageId: string }> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`telegram_error:${JSON.stringify(json)}`);
  return { providerMessageId: String(json.result.message_id) };
}

async function sendWhatsApp(waId: string, text: string): Promise<{ providerMessageId: string }> {
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneId) throw new Error("WhatsApp not configured");
  const res = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: waId,
      type: "text",
      text: { body: text },
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`whatsapp_error:${JSON.stringify(json)}`);
  return { providerMessageId: json.messages?.[0]?.id ?? "unknown" };
}

async function sendSms(phone: string, text: string): Promise<{ providerMessageId: string }> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const auth = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!sid || !auth || !from) throw new Error("Twilio not configured");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const body = new URLSearchParams({ To: phone, From: from, Body: text });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${sid}:${auth}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`twilio_error:${JSON.stringify(json)}`);
  return { providerMessageId: json.sid };
}
