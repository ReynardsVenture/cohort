import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";

async function hash(val: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${val}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);
  const { user_id, device_hash } = await req.json();
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown";
  const salt = Deno.env.get("COHORT_PHONE_OTP_SALT") ?? "cohort";
  const ipHash = await hash(ip, salt);

  const supabase = getServiceClient();
  const { data: banned } = await supabase.from("abuse_fingerprints")
    .select("user_id, users!inner(status)")
    .eq("device_hash", device_hash)
    .limit(1);

  let deviceFlagged = false;
  // Simplified ban overlap check
  const { data: overlap } = await supabase.from("users").select("id").eq("status", "banned").limit(1);
  if (overlap?.length && device_hash) deviceFlagged = true;

  await supabase.from("abuse_fingerprints").insert({
    user_id,
    ip_hash: ipHash,
    device_hash: device_hash ?? null,
    device_flagged: deviceFlagged,
  });

  return jsonResponse({ ok: true, device_flagged: deviceFlagged });
});
