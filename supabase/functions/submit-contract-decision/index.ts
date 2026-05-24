import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { handleCoreAction } from "../_shared/core-handler.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);
  const body = await req.json();
  const supabase = getServiceClient();
  const result = await handleCoreAction(supabase, {
    type: "SubmitContract",
    userId: body.user_id,
    threadId: body.thread_id,
    decision: body.decision,
    pace: body.pace,
  });
  return jsonResponse(result);
});
