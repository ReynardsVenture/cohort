import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { requireInternalAuth } from "../_shared/internal-auth.ts";
import { setUserAgeFromIso } from "../_shared/user-age.ts";

Deno.serve(async (req) => {
  const authErr = requireInternalAuth(req);
  if (authErr) return authErr;
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);
  const { user_id, date_of_birth } = await req.json();
  if (!user_id || !date_of_birth) return errorResponse("missing_params");

  const supabase = getServiceClient();
  const result = await setUserAgeFromIso(supabase, user_id, date_of_birth);
  if (!result.ok) {
    const status = result.error === "underage" ? 403 : 400;
    return errorResponse(result.error, status);
  }
  return jsonResponse({ ok: true });
});
