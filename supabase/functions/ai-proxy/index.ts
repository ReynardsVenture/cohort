import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { requireInternalAuth } from "../_shared/internal-auth.ts";
import { runFacilitationJob, runMatchingJob, runOnboardingJob } from "../_shared/ai-jobs.ts";

Deno.serve(async (req) => {
  const authErr = requireInternalAuth(req);
  if (authErr) return authErr;
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);

  try {
    const body = await req.json();
    const job = body.job as string;
    const userId = body.user_id as string;
    const supabase = getServiceClient();

    if (job === "onboarding") {
      const result = await runOnboardingJob(supabase, userId, body.message ?? "");
      return jsonResponse(result);
    }
    if (job === "matching") {
      const result = await runMatchingJob(supabase, userId, body);
      return jsonResponse(result);
    }
    if (job === "facilitation") {
      const result = await runFacilitationJob(supabase, body);
      return jsonResponse(result);
    }
    return errorResponse("unknown_job");
  } catch (e) {
    console.error("[ai-proxy] error", e);
    return errorResponse(e instanceof Error ? e.message : "ai_error", 500);
  }
});
