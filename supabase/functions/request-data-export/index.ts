import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);
  const { user_id } = await req.json();
  const supabase = getServiceClient();
  const { data, error } = await supabase.from("data_export_jobs").insert({
    user_id,
    status: "pending",
  }).select("id").single();
  if (error) return errorResponse(error.message, 500);
  return jsonResponse({ job_id: data.id, status: "pending" });
});
