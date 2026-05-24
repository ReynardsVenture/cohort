import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { OutboundIntent } from "./types.ts";

export async function enqueueOutbound(
  supabase: SupabaseClient,
  intents: OutboundIntent[],
): Promise<void> {
  if (!intents.length) return;
  const rows = intents.map((i) => ({
    user_id: i.userId,
    channel: i.channel,
    template_key: i.templateKey,
    payload: i.payload,
    idempotency_key: i.idempotencyKey,
    status: "pending",
    next_attempt_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from("outbound_deliveries").upsert(rows, {
    onConflict: "idempotency_key",
    ignoreDuplicates: true,
  });
  if (error) throw error;
}

export async function emitDomainEvent(
  supabase: SupabaseClient,
  aggregateType: string,
  aggregateId: string | null,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await supabase
    .from("domain_events")
    .insert({
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      event_type: eventType,
      payload,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export function idempotencyKey(...parts: string[]): string {
  return parts.join(":");
}
