import { getServiceClient, jsonResponse } from "../_shared/supabase.ts";
import { resolveChannelIdentity } from "../_shared/identity.ts";
import { handleCoreAction, persistCoreResult } from "../_shared/core-handler.ts";

Deno.serve(async (req) => {
  const form = await req.formData();
  const from = String(form.get("From") ?? "").replace("whatsapp:", "");
  const body = String(form.get("Body") ?? "").trim();
  if (!from || !body) return new Response("<Response></Response>", { headers: { "Content-Type": "text/xml" } });

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
