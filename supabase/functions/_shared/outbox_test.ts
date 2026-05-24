import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { idempotencyKey } from "./outbox.ts";

Deno.test("idempotencyKey is stable for same parts", () => {
  const a = idempotencyKey("event-1", "user-1", "round_ready");
  const b = idempotencyKey("event-1", "user-1", "round_ready");
  assertEquals(a, b);
});

Deno.test("idempotencyKey differs for different users", () => {
  const a = idempotencyKey("event-1", "user-1", "round_ready");
  const b = idempotencyKey("event-1", "user-2", "round_ready");
  assertEquals(a !== b, true);
});
