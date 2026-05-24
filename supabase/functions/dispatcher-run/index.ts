import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { getSendToChannel } from "../_shared/dispatcher-send.ts";
import { requireCronAuth } from "../_shared/internal-auth.ts";

const BATCH = 50;
const LEASE_MINUTES = 5;

export interface OutboundRow {
  id: string;
  user_id: string;
  channel: string;
  template_key: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  idempotency_key: string;
  provider_message_id: string | null;
}

export async function processDeliveryBatch(
  supabase: ReturnType<typeof getServiceClient>,
  rows: OutboundRow[],
): Promise<{ delivered: number; failed: number; repaired: number }> {
  const sendToChannel = getSendToChannel();
  let delivered = 0;
  let failed = 0;
  let repaired = 0;

  for (const row of rows) {
    // Repair: provider_message_id already on row (stranded after partial write)
    if (row.provider_message_id) {
      await supabase.rpc("repair_outbound_delivered", { _delivery_id: row.id });
      repaired++;
      delivered++;
      continue;
    }

    // Repair: completed attempt exists but row not marked delivered (crash after HTTP, before complete RPC)
    const { data: synced } = await supabase.rpc("sync_outbound_from_completed_attempt", {
      _delivery_id: row.id,
    });
    if (synced) {
      repaired++;
      delivered++;
      continue;
    }

    const { data: hasCompleted } = await supabase.rpc("outbound_has_completed_attempt", {
      _delivery_id: row.id,
    });
    if (hasCompleted) {
      await supabase.rpc("sync_outbound_from_completed_attempt", { _delivery_id: row.id });
      repaired++;
      delivered++;
      continue;
    }

    const { data: identity } = await supabase
      .from("channel_identities")
      .select("external_id")
      .eq("user_id", row.user_id)
      .eq("channel", row.channel)
      .order("is_primary", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!identity?.external_id) {
      await supabase.rpc("fail_outbound_delivery", {
        _delivery_id: row.id,
        _attempt_number: row.attempt_count + 1,
        _error: "no_channel_identity",
      });
      failed++;
      continue;
    }

    const { data: attemptNum, error: startErr } = await supabase.rpc("start_delivery_attempt", {
      _delivery_id: row.id,
    });
    if (startErr) {
      failed++;
      continue;
    }

    const attempt = attemptNum as number;

    try {
      const { providerMessageId } = await sendToChannel(
        row.channel as "telegram" | "whatsapp" | "sms" | "web",
        identity.external_id,
        row.template_key,
        row.payload ?? {},
      );

      await supabase.rpc("complete_outbound_delivery", {
        _delivery_id: row.id,
        _attempt_number: attempt,
        _provider_message_id: providerMessageId,
      });
      delivered++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supabase.rpc("fail_outbound_delivery", {
        _delivery_id: row.id,
        _attempt_number: attempt,
        _error: msg,
      });
      failed++;
    }
  }

  return { delivered, failed, repaired };
}

Deno.serve(async (req) => {
  const authErr = requireCronAuth(req);
  if (authErr) return authErr;

  const supabase = getServiceClient();

  const { data: claimed, error } = await supabase.rpc("claim_outbound_deliveries", {
    _batch: BATCH,
    _lease_minutes: LEASE_MINUTES,
  });

  if (error) return errorResponse(error.message, 500);

  const rows = (claimed ?? []) as OutboundRow[];
  const result = await processDeliveryBatch(supabase, rows);

  return jsonResponse({
    claimed: rows.length,
    ...result,
  });
});
