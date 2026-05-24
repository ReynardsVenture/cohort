import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { requireInternalAuth } from "./internal-auth.ts";

const BUSINESS_FUNCTIONS = [
  "send-spark",
  "respond-spark",
  "submit-thread-turn",
  "submit-contract-decision",
  "send-relay-message",
] as const;

function unauthorizedRequest(): Request {
  return new Request("http://localhost/", { method: "POST" });
}

for (const name of BUSINESS_FUNCTIONS) {
  Deno.test(`${name}: requireInternalAuth blocks unauthenticated call`, async () => {
    Deno.env.set("COHORT_INTERNAL_SECRET", "edge-test-secret");
    Deno.env.delete("COHORT_ALLOW_OPEN_INTERNAL");
    const res = requireInternalAuth(unauthorizedRequest());
    assertEquals(res?.status, 401);
    const body = res ? await res.json() : {};
    assertEquals(body.error, "unauthorized");
    Deno.env.delete("COHORT_INTERNAL_SECRET");
  });
}
