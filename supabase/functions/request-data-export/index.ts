import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { requireInternalAuth } from "../_shared/internal-auth.ts";

Deno.serve(async (req) => {
  const authErr = requireInternalAuth(req);
  if (authErr) return authErr;
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
