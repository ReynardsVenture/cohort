import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("COHORT_CRON_SECRET");
  if (cronSecret && req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return errorResponse("unauthorized", 401);
  }

  const supabase = getServiceClient();
  const { data, error } = await supabase.from("sparks")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .eq("status", "pending")
    .lt("expires_at", new Date().toISOString())
    .select("id");

  if (error) return errorResponse(error.message, 500);
  return jsonResponse({ expired: data?.length ?? 0 });
});
