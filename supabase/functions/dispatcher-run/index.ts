import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { sendToChannel } from "../_shared/dispatcher-providers.ts";

const BATCH = 50;
const BACKOFF_MINUTES = [1, 5, 30, 120, 240, 480, 720, 1440];

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("COHORT_CRON_SECRET");
  const auth = req.headers.get("authorization");
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return errorResponse("unauthorized", 401);
  }

  const supabase = getServiceClient();
  const now = new Date().toISOString();

  const { data: pending, error } = await supabase
    .from("outbound_deliveries")
    .select("id, user_id, channel, template_key, payload, attempt_count, idempotency_key")
    .in("status", ["pending", "failed"])
    .lte("next_attempt_at", now)
    .order("created_at", { ascending: true })
    .limit(BATCH);

  if (error) return errorResponse(error.message, 500);

  let delivered = 0;
  let failed = 0;

  for (const row of pending ?? []) {
    const { data: claimed } = await supabase
      .from("outbound_deliveries")
      .update({ status: "sending" })
      .eq("id", row.id)
      .in("status", ["pending", "failed"])
      .select("id")
      .maybeSingle();

    if (!claimed) continue;

    const { data: identity } = await supabase
      .from("channel_identities")
      .select("external_id")
      .eq("user_id", row.user_id)
      .eq("channel", row.channel)
      .order("is_primary", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!identity?.external_id) {
      await markFailed(supabase, row.id, row.attempt_count, "no_channel_identity");
      failed++;
      continue;
    }

    try {
      const { providerMessageId } = await sendToChannel(
        row.channel,
        identity.external_id,
        row.template_key,
        row.payload as Record<string, unknown>,
      );
      await supabase.from("outbound_deliveries").update({
        status: "delivered",
        provider_message_id: providerMessageId,
        delivered_at: new Date().toISOString(),
        last_error: null,
      }).eq("id", row.id);
      delivered++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await markFailed(supabase, row.id, row.attempt_count, msg);
      failed++;
    }
  }

  return jsonResponse({ processed: pending?.length ?? 0, delivered, failed });
});

async function markFailed(
  supabase: ReturnType<typeof getServiceClient>,
  id: string,
  attemptCount: number,
  err: string,
) {
  const next = attemptCount + 1;
  const dead = next >= BACKOFF_MINUTES.length;
  const backoffMin = BACKOFF_MINUTES[Math.min(next, BACKOFF_MINUTES.length - 1)];
  const nextAt = new Date(Date.now() + backoffMin * 60 * 1000).toISOString();
  await supabase.from("outbound_deliveries").update({
    status: dead ? "dead" : "failed",
    attempt_count: next,
    next_attempt_at: nextAt,
    last_error: err.slice(0, 500),
  }).eq("id", id);
}
