import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { enqueueOutbound, idempotencyKey } from "../_shared/outbox.ts";
import { getPreferredChannel } from "../_shared/identity.ts";

async function hashCode(phone: string, code: string): Promise<string> {
  const salt = Deno.env.get("COHORT_PHONE_OTP_SALT") ?? "cohort-dev-salt";
  const data = new TextEncoder().encode(`${salt}:${phone}:${code}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);
  const body = await req.json();
  const supabase = getServiceClient();

  if (body.action === "send") {
    const { user_id, phone } = body;
    if (!user_id || !phone) return errorResponse("missing_params");
    const code = generateCode();
    const codeHash = await hashCode(phone, code);
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await supabase.from("phone_verifications").insert({
      user_id,
      phone,
      code_hash: codeHash,
      expires_at: expires,
    });
    const channel = await getPreferredChannel(supabase, user_id);
    await enqueueOutbound(supabase, [{
      userId: user_id,
      channel,
      templateKey: "otp_code",
      payload: { code },
      idempotencyKey: idempotencyKey("otp", user_id, phone, expires),
    }]);
    return jsonResponse({ sent: true });
  }

  if (body.action === "verify") {
    const { user_id, phone, code } = body;
    const codeHash = await hashCode(phone, code);
    const { data: pv } = await supabase.from("phone_verifications")
      .select("id")
      .eq("user_id", user_id)
      .eq("phone", phone)
      .eq("code_hash", codeHash)
      .is("verified_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!pv) return errorResponse("invalid_code", 403);
    await supabase.from("phone_verifications").update({ verified_at: new Date().toISOString() }).eq("id", pv.id);
    await supabase.from("users").update({ primary_phone: phone, updated_at: new Date().toISOString() }).eq("id", user_id);
    return jsonResponse({ verified: true });
  }

  return errorResponse("unknown_action");
});
