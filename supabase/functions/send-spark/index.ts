import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { handleCoreAction } from "../_shared/core-handler.ts";
import { requireInternalAuth } from "../_shared/internal-auth.ts";

Deno.serve(async (req) => {
  const authErr = requireInternalAuth(req);
  if (authErr) return authErr;
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);
  const body = await req.json();
  const supabase = getServiceClient();
  const result = await handleCoreAction(supabase, {
    type: "SendSpark",
    userId: body.user_id,
    toUserId: body.to_user_id,
    roundId: body.round_id,
    style: body.style ?? "curious",
    message: body.message,
    intentLevel: body.intent_level ?? "explore",
  });
  return jsonResponse(result);
});
