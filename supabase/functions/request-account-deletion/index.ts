import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);
  const { user_id } = await req.json();
  const supabase = getServiceClient();
  const scheduled = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase.from("deletion_jobs").insert({
    user_id,
    status: "pending",
    scheduled_for: scheduled,
  }).select("id").single();
  if (error) return errorResponse(error.message, 500);
  await supabase.from("users").update({ status: "deleted_pending" }).eq("id", user_id);
  return jsonResponse({ job_id: data.id, scheduled_for: scheduled });
});
