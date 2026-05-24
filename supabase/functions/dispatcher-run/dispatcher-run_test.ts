import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { processDeliveryBatch, type OutboundRow } from "./index.ts";
import { setSendToChannelForTests } from "../_shared/dispatcher-send.ts";
import { idempotencyKey } from "../_shared/outbox.ts";

const sampleRow: OutboundRow = {
  id: "d1111111-1111-1111-1111-111111111111",
  user_id: "u1111111-1111-1111-1111-111111111111",
  channel: "telegram",
  template_key: "spark_received",
  payload: { preview: "hello" },
  attempt_count: 0,
  idempotency_key: "evt:u1:spark_received",
  provider_message_id: null,
};

function mockSupabase(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      const h = handlers[name];
      if (!h) return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
      return Promise.resolve({ data: h(args), error: null });
    },
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: () =>
                  table === "channel_identities"
                    ? Promise.resolve({ data: { external_id: "12345" }, error: null })
                    : Promise.resolve({ data: null, error: null }),
              }),
            }),
          }),
        }),
      };
    },
  } as ReturnType<typeof import("../_shared/supabase.ts").getServiceClient>;
}

Deno.test("processDeliveryBatch: successful send calls provider once and completes", async () => {
  let sendCalls = 0;
  setSendToChannelForTests(async () => {
    sendCalls++;
    return { providerMessageId: "tg-99" };
  });

  let completed = false;
  const supabase = mockSupabase({
    outbound_has_completed_attempt: () => false,
    sync_outbound_from_completed_attempt: () => false,
    start_delivery_attempt: () => 1,
    complete_outbound_delivery: () => {
      completed = true;
      return null;
    },
  });

  const result = await processDeliveryBatch(supabase, [sampleRow]);
  assertEquals(sendCalls, 1);
  assertEquals(completed, true);
  assertEquals(result.delivered, 1);
  assertEquals(result.failed, 0);
});

Deno.test("processDeliveryBatch: repair when provider_message_id already set — no HTTP", async () => {
  let sendCalls = 0;
  setSendToChannelForTests(async () => {
    sendCalls++;
    return { providerMessageId: "x" };
  });

  let repaired = false;
  const supabase = mockSupabase({
    repair_outbound_delivered: () => {
      repaired = true;
      return null;
    },
  });

  const row = { ...sampleRow, provider_message_id: "tg-existing" };
  const result = await processDeliveryBatch(supabase, [row]);
  assertEquals(sendCalls, 0);
  assertEquals(repaired, true);
  assertEquals(result.repaired, 1);
  assertEquals(result.delivered, 1);
});

Deno.test("processDeliveryBatch: sync from completed attempt — no HTTP (crash recovery)", async () => {
  let sendCalls = 0;
  setSendToChannelForTests(async () => {
    sendCalls++;
    return { providerMessageId: "x" };
  });

  const supabase = mockSupabase({
    outbound_has_completed_attempt: () => true,
    sync_outbound_from_completed_attempt: () => true,
  });

  const result = await processDeliveryBatch(supabase, [sampleRow]);
  assertEquals(sendCalls, 0);
  assertEquals(result.delivered, 1);
  assertEquals(result.repaired, 1);
});

Deno.test("relay idempotency key format is stable (no Date.now)", () => {
  const relayMsgId = "a2222222-2222-2222-2222-222222222222";
  const recipient = "b3333333-3333-3333-3333-333333333333";
  const k1 = idempotencyKey("relay", relayMsgId, recipient);
  const k2 = idempotencyKey("relay", relayMsgId, recipient);
  assertEquals(k1, k2);
  assertEquals(k1, `relay:${relayMsgId}:${recipient}`);
});

Deno.test("processDeliveryBatch: first pass sends once; retry after crash syncs without second HTTP", async () => {
  let sendCalls = 0;
  setSendToChannelForTests(async () => {
    sendCalls++;
    return { providerMessageId: "tg-crash" };
  });

  const supabaseFirst = mockSupabase({
    outbound_has_completed_attempt: () => false,
    sync_outbound_from_completed_attempt: () => false,
    start_delivery_attempt: () => 1,
    complete_outbound_delivery: () => {
      throw new Error("simulated crash after provider send");
    },
    fail_outbound_delivery: () => null,
  });

  const first = await processDeliveryBatch(supabaseFirst, [sampleRow]);
  assertEquals(sendCalls, 1);
  assertEquals(first.failed, 1);

  const supabaseRetry = mockSupabase({
    outbound_has_completed_attempt: () => true,
    sync_outbound_from_completed_attempt: () => true,
  });
  const retry = await processDeliveryBatch(supabaseRetry, [sampleRow]);
  assertEquals(sendCalls, 1);
  assertEquals(retry.delivered, 1);
  assertEquals(retry.repaired, 1);
});

Deno.test("two rows processed independently — one send each", async () => {
  let sendCalls = 0;
  setSendToChannelForTests(async () => {
    sendCalls++;
    return { providerMessageId: `tg-${sendCalls}` };
  });

  const supabase = mockSupabase({
    outbound_has_completed_attempt: () => false,
    sync_outbound_from_completed_attempt: () => false,
    start_delivery_attempt: () => 1,
    complete_outbound_delivery: () => null,
  });

  const row2 = { ...sampleRow, id: "d2222222-2222-2222-2222-222222222222" };
  const result = await processDeliveryBatch(supabase, [sampleRow, row2]);
  assertEquals(sendCalls, 2);
  assertEquals(result.delivered, 2);
});
