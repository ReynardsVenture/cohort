import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { pickLane, matchKey } from "../_shared/lane-matching.ts";
import { enqueueOutbound, emitDomainEvent, idempotencyKey } from "../_shared/outbox.ts";
import { getPreferredChannel } from "../_shared/identity.ts";

function weekStart(d = new Date()): string {
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setUTCDate(diff));
  return monday.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("COHORT_CRON_SECRET");
  if (cronSecret && req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return errorResponse("unauthorized", 401);
  }

  const supabase = getServiceClient();
  const ws = weekStart();
  const we = new Date(ws);
  we.setUTCDate(we.getUTCDate() + 6);
  const weekEnd = we.toISOString().slice(0, 10);

  const { data: profiles } = await supabase.from("profiles")
    .select("user_id, intent, gender, seeking, region_key, last_lane_type, bio_structured")
    .eq("region_key", "berlin")
    .eq("onboarding_status", "complete")
    .eq("is_paused", false)
    .eq("moderation_status", "active");

  const byLane = new Map<string, typeof profiles>();

  for (const p of profiles ?? []) {
    const { data: user } = await supabase.from("users").select("age_verified_at").eq("id", p.user_id).single();
    if (!user?.age_verified_at) continue;

    const lane = pickLane({
      user_id: p.user_id,
      gender: p.gender,
      seeking: p.seeking,
      last_lane_type: p.last_lane_type,
    });
    if (!lane || !p.intent) continue;

    const key = matchKey(p.region_key ?? "berlin", p.intent, lane, ws);
    if (!byLane.has(key)) byLane.set(key, []);
    byLane.get(key)!.push(p);
  }

  let roundsCreated = 0;
  let suggestionsCreated = 0;

  for (const [mkey, members] of byLane) {
    if (members.length < 2) continue;
    const sample = members[0];
    const lane = pickLane({ user_id: sample.user_id, gender: sample.gender, seeking: sample.seeking })!;

    const { data: round } = await supabase.from("weekly_rounds").upsert({
      region_key: "berlin",
      intent_lane: sample.intent,
      lane_type: lane,
      match_key: mkey,
      week_start: ws,
      week_end: weekEnd,
      status: "forming",
    }, { onConflict: "region_key,match_key,week_start" }).select("id").single();

    if (!round) continue;
    roundsCreated++;

    for (const member of members) {
      const others = members.filter((m) => m.user_id !== member.user_id).slice(0, 15);
      const prefiltered = others.map((o) => ({
        user_id: o.user_id,
        bio: o.bio_structured,
        intent: o.intent,
      }));

      const aiRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/ai-proxy`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          job: "matching",
          user_id: member.user_id,
          profile: member.bio_structured,
          candidates: prefiltered,
        }),
      });
      const aiJson = await aiRes.json();
      const suggestions = (aiJson.suggestions ?? []) as { candidate_user_id: string; reason_text: string; confidence?: string }[];

      if (!suggestions.length) {
        const channel = await getPreferredChannel(supabase, member.user_id);
        await enqueueOutbound(supabase, [{
          userId: member.user_id,
          channel,
          templateKey: "no_round_this_week",
          payload: {},
          idempotencyKey: idempotencyKey("no_round", round.id, member.user_id, ws),
        }]);
        continue;
      }

      for (const s of suggestions) {
        if (!s.reason_text || s.reason_text.length < 10) continue;
        await supabase.from("match_suggestions").upsert({
          round_id: round.id,
          for_user_id: member.user_id,
          suggested_user_id: s.candidate_user_id,
          reason_text: s.reason_text,
          confidence: s.confidence === "medium" ? "medium" : "high",
        }, { onConflict: "round_id,for_user_id,suggested_user_id" });
        suggestionsCreated++;
      }

      await supabase.from("round_members").upsert({
        round_id: round.id,
        user_id: member.user_id,
      }, { onConflict: "round_id,user_id" });

      const { data: ent } = await supabase.from("subscriptions").select("tier").eq("user_id", member.user_id).maybeSingle();
      const tier = ent?.tier ?? "free";
      const { data: entRow } = await supabase.from("entitlements").select("sparks_per_week").eq("tier", tier).single();
      await supabase.from("weekly_quotas").upsert({
        user_id: member.user_id,
        round_id: round.id,
        sparks_budget: entRow?.sparks_per_week ?? 5,
        sparks_sent: 0,
      }, { onConflict: "user_id,round_id" });
    }
  }

  return jsonResponse({ roundsCreated, suggestionsCreated, weekStart: ws });
});
