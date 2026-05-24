import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { handleCoreAction, persistCoreResult } from "../_shared/core-handler.ts";

Deno.serve(async (req) => {
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
  await persistCoreResult(supabase, result);
  return jsonResponse(result);
});
