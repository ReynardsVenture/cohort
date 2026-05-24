import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { getConfigInt } from "../_shared/config.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);
  const { user_id, date_of_birth } = await req.json();
  if (!user_id || !date_of_birth) return errorResponse("missing_params");

  const dob = new Date(date_of_birth);
  if (isNaN(dob.getTime())) return errorResponse("invalid_date");

  const supabase = getServiceClient();
  const minAge = await getConfigInt(supabase, "min_age_years", 18);
  const ageMs = Date.now() - dob.getTime();
  const ageYears = ageMs / (365.25 * 24 * 3600 * 1000);
  if (ageYears < minAge) return errorResponse("underage", 403);

  const { error } = await supabase.from("users").update({
    date_of_birth: date_of_birth,
    age_verified_at: new Date().toISOString(),
    age_verification_method: "self_declared",
    updated_at: new Date().toISOString(),
  }).eq("id", user_id);

  if (error) return errorResponse(error.message, 500);
  return jsonResponse({ ok: true });
});
