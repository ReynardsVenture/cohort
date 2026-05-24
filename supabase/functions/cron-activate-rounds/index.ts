import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { enqueueOutbound, emitDomainEvent, idempotencyKey } from "../_shared/outbox.ts";
import { getPreferredChannel } from "../_shared/identity.ts";
import { requireCronAuth } from "../_shared/internal-auth.ts";

Deno.serve(async (req) => {
  const authErr = requireCronAuth(req);
  if (authErr) return authErr;

  const supabase = getServiceClient();
  const { data: forming } = await supabase.from("weekly_rounds").select("id, min_size").eq("status", "forming");

  let activated = 0;
  for (const round of forming ?? []) {
    const { count } = await supabase.from("round_members").select("id", { count: "exact", head: true }).eq("round_id", round.id);
    if ((count ?? 0) < round.min_size) continue;

    await supabase.from("weekly_rounds").update({
      status: "active",
      activated_at: new Date().toISOString(),
    }).eq("id", round.id);

    const eventId = await emitDomainEvent(supabase, "weekly_round", round.id, "round.activated", {});

    const { data: members } = await supabase.from("round_members").select("user_id").eq("round_id", round.id);
    for (const m of members ?? []) {
      const { count: sugCount } = await supabase.from("match_suggestions")
        .select("id", { count: "exact", head: true })
        .eq("round_id", round.id)
        .eq("for_user_id", m.user_id);

      const channel = await getPreferredChannel(supabase, m.user_id);
      await enqueueOutbound(supabase, [{
        userId: m.user_id,
        channel,
        templateKey: (sugCount ?? 0) > 0 ? "round_ready" : "no_round_this_week",
        payload: { suggestion_count: sugCount ?? 0, round_id: round.id },
        idempotencyKey: idempotencyKey(eventId, m.user_id, "round_ready"),
      }]);
    }
    activated++;
  }

  return jsonResponse({ activated });
});
