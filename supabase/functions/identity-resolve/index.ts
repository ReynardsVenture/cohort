import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { resolveChannelIdentity } from "../_shared/identity.ts";
import { enqueueOutbound, idempotencyKey } from "../_shared/outbox.ts";
import type { ChannelType } from "../_shared/types.ts";
import { requireInternalAuth } from "../_shared/internal-auth.ts";

Deno.serve(async (req) => {
  const authErr = requireInternalAuth(req);
  if (authErr) return authErr;
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);
  const body = await req.json();
  const channel = body.channel as ChannelType;
  const externalId = String(body.external_id ?? "");
  const username = body.external_username as string | undefined;

  if (!channel || !externalId) return errorResponse("missing_params");

  const supabase = getServiceClient();
  const resolved = await resolveChannelIdentity(supabase, channel, externalId, username);

  if (resolved.isNew) {
    await enqueueOutbound(supabase, [{
      userId: resolved.userId,
      channel,
      templateKey: "welcome_new",
      payload: {},
      idempotencyKey: idempotencyKey("welcome", resolved.userId),
    }, {
      userId: resolved.userId,
      channel,
      templateKey: "ai_disclosure",
      payload: {},
      idempotencyKey: idempotencyKey("disclosure", resolved.userId),
    }]);
  }

  return jsonResponse({
    user_id: resolved.userId,
    channel_identity_id: resolved.channelIdentityId,
    is_new: resolved.isNew,
  });
});
