import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { handleCoreAction } from "../_shared/core-handler.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);
  const body = await req.json();
  const supabase = getServiceClient();
  const result = await handleCoreAction(supabase, {
    type: "RespondSpark",
    userId: body.user_id,
    sparkId: body.spark_id,
    accept: Boolean(body.accept),
  });
  return jsonResponse(result);
});
