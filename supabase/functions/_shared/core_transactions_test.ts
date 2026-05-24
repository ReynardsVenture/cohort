import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { idempotencyKey } from "./outbox.ts";

/**
 * Integration tests for send_spark_tx rollback and concurrent budget require local Supabase:
 *   supabase db reset && supabase test db
 *
 * Run concurrent budget manually:
 *   SELECT send_spark_tx(...) from 10 parallel sessions with budget 5 → expect 5 successes.
 */

Deno.test("spark_received outbox key uses durable event id not timestamp", () => {
  const eventId = "e1111111-1111-1111-1111-111111111111";
  const toUser = "u2222222-2222-2222-2222-222222222222";
  const key = `${eventId}:${toUser}:spark_received`;
  assertEquals(key.includes("Date"), false);
  assertEquals(key, idempotencyKey(eventId, toUser, "spark_received"));
});

Deno.test("relay outbox key matches send_relay_message_tx format", () => {
  const relayId = "r1111111-1111-1111-1111-111111111111";
  const recipient = "u2222222-2222-2222-2222-222222222222";
  const expected = `relay:${relayId}:${recipient}`;
  assertEquals(idempotencyKey("relay", relayId, recipient), expected);
});

Deno.test("telegram ai_reply key uses message id not wall clock", () => {
  const userId = "u1";
  const tgMsgId = "tg:12345";
  const k1 = idempotencyKey("ai_reply", userId, tgMsgId);
  const k2 = idempotencyKey("ai_reply", userId, tgMsgId);
  assertEquals(k1, k2);
});
