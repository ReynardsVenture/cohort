import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha1Base64(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** Meta WhatsApp Cloud API — X-Hub-Signature-256 */
export async function verifyWhatsAppSignature(
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  const secret = Deno.env.get("WHATSAPP_APP_SECRET");
  if (!secret || !signatureHeader?.startsWith("sha256=")) return false;
  const expected = signatureHeader.slice("sha256=".length);
  const computed = await hmacSha256Hex(secret, rawBody);
  if (expected.length !== computed.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ computed.charCodeAt(i);
  }
  return diff === 0;
}

/** Twilio inbound webhook — X-Twilio-Signature */
export async function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signatureHeader: string | null,
): Promise<boolean> {
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!authToken || !signatureHeader) return false;

  const sorted = Object.keys(params).sort();
  let data = url;
  for (const k of sorted) {
    data += k + params[k];
  }
  const computed = await hmacSha1Base64(authToken, data);
  if (computed.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

/** Stripe webhook — Stripe-Signature header */
export async function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string | null,
): Promise<{ ok: true; event: Stripe.Event } | { ok: false; error: string }> {
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!webhookSecret) {
    return { ok: false, error: "stripe_webhook_not_configured" };
  }
  if (!signatureHeader) {
    return { ok: false, error: "missing_stripe_signature" };
  }
  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "sk_placeholder";
    const stripe = new Stripe(stripeKey, { apiVersion: "2024-11-20.acacia" });
    const event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signatureHeader,
      webhookSecret,
    );
    return { ok: true, event };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invalid_signature" };
  }
}
