import { getServiceClient, jsonResponse } from "../_shared/supabase.ts";
import { resolveChannelIdentity } from "../_shared/identity.ts";
import { handleCoreAction, persistCoreResult } from "../_shared/core-handler.ts";
import { enqueueOutbound, idempotencyKey } from "../_shared/outbox.ts";
import { internalAuthHeaders, isDevOpenMode } from "../_shared/internal-auth.ts";
import { verifyWhatsAppSignature } from "../_shared/provider-auth.ts";

Deno.serve(async (req) => {
  if (req.method === "GET") {
    const mode = new URL(req.url).searchParams.get("hub.mode");
    const token = new URL(req.url).searchParams.get("hub.verify_token");
    const challenge = new URL(req.url).searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === Deno.env.get("WHATSAPP_VERIFY_TOKEN")) {
      return new Response(challenge ?? "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }

  const rawBody = await req.text();
  const appSecret = Deno.env.get("WHATSAPP_APP_SECRET");
  if (appSecret) {
    const valid = await verifyWhatsAppSignature(rawBody, req.headers.get("x-hub-signature-256"));
    if (!valid) return new Response("forbidden", { status: 403 });
  } else if (!isDevOpenMode()) {
    return new Response("webhook_not_configured", { status: 503 });
  }

  const body = JSON.parse(rawBody);
  const entry = body.entry?.[0]?.changes?.[0]?.value;
  const msg = entry?.messages?.[0];
  if (!msg?.text?.body || !msg.from) return jsonResponse({ ok: true });

  const supabase = getServiceClient();
  const resolved = await resolveChannelIdentity(supabase, "whatsapp", msg.from);

  await supabase.from("users").update({
    whatsapp_contact_consent_at: new Date().toISOString(),
    preferred_outbound_channel: "whatsapp",
  }).eq("id", resolved.userId).is("whatsapp_contact_consent_at", null);

  await supabase.from("consent_records").insert({
    user_id: resolved.userId,
    consent_type: "whatsapp_contact",
    version: "v1",
  });

  const text = msg.text.body.trim();
  const { data: user } = await supabase.from("users").select("age_verified_at").eq("id", resolved.userId).single();

  if (!user?.age_verified_at) {
    const dobMatch = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (dobMatch) {
      const [, d, m, y] = dobMatch;
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/identity-set-age`, {
        method: "POST",
        headers: internalAuthHeaders(),
        body: JSON.stringify({ user_id: resolved.userId, date_of_birth: `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}` }),
      });
    } else {
      await enqueueOutbound(supabase, [{
        userId: resolved.userId,
        channel: "whatsapp",
        templateKey: "age_gate_required",
        payload: {},
        idempotencyKey: idempotencyKey("wa_age", resolved.userId),
      }]);
    }
    return jsonResponse({ ok: true });
  }

  const result = await handleCoreAction(supabase, {
    type: "OnboardingMessage",
    userId: resolved.userId,
    text,
  });
  await persistCoreResult(supabase, result);

  const aiRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/ai-proxy`, {
    method: "POST",
    headers: internalAuthHeaders(),
    body: JSON.stringify({ job: "onboarding", user_id: resolved.userId, message: text }),
  });
  const aiJson = await aiRes.json();
  if (aiJson.reply) {
    await enqueueOutbound(supabase, [{
      userId: resolved.userId,
      channel: "whatsapp",
      templateKey: "safety_notice",
      payload: { message: aiJson.reply },
      idempotencyKey: idempotencyKey("wa_ai", resolved.userId, `wa:${msg.id}`),
    }]);
  }

  return jsonResponse({ ok: true });
});
