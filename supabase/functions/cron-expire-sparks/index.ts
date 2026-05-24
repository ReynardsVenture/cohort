import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { requireCronAuth } from "../_shared/internal-auth.ts";

Deno.serve(async (req) => {
  const authErr = requireCronAuth(req);
  if (authErr) return authErr;

  const supabase = getServiceClient();
  const { data, error } = await supabase.from("sparks")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .eq("status", "pending")
    .lt("expires_at", new Date().toISOString())
    .select("id");

  if (error) return errorResponse(error.message, 500);
  return jsonResponse({ expired: data?.length ?? 0 });
});
