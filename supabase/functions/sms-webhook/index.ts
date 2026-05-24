import { getServiceClient, jsonResponse } from "../_shared/supabase.ts";
import { resolveChannelIdentity } from "../_shared/identity.ts";
import { handleCoreAction, persistCoreResult } from "../_shared/core-handler.ts";
import { verifyTwilioSignature } from "../_shared/provider-auth.ts";
import { isDevOpenMode } from "../_shared/internal-auth.ts";

Deno.serve(async (req) => {
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    params[k] = String(v);
  }

  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (authToken) {
    const webhookUrl = Deno.env.get("TWILIO_WEBHOOK_URL") ?? new URL(req.url).toString();
    const valid = await verifyTwilioSignature(
      webhookUrl,
      params,
      req.headers.get("X-Twilio-Signature"),
    );
    if (!valid) return new Response("forbidden", { status: 403 });
  } else if (!isDevOpenMode()) {
    return new Response("webhook_not_configured", { status: 503 });
  }

  const from = String(params.From ?? "").replace("whatsapp:", "");
  const body = String(params.Body ?? "").trim();
  if (!from || !body) {
    return new Response("<Response></Response>", { headers: { "Content-Type": "text/xml" } });
  }

  const supabase = getServiceClient();
  const resolved = await resolveChannelIdentity(supabase, "sms", from);
  await supabase.from("users").update({ preferred_outbound_channel: "sms" }).eq("id", resolved.userId);

  const result = await handleCoreAction(supabase, {
    type: "OnboardingMessage",
    userId: resolved.userId,
    text: body,
  });
  await persistCoreResult(supabase, result);

  return new Response("<Response></Response>", { headers: { "Content-Type": "text/xml" } });
});
