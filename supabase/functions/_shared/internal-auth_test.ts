import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isDevOpenMode,
  requireCronAuth,
  requireInternalAuth,
} from "./internal-auth.ts";

function req(auth?: string): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("http://localhost/", { headers });
}

Deno.test("requireInternalAuth: rejects when secret set and header missing", () => {
  Deno.env.set("COHORT_INTERNAL_SECRET", "test-secret");
  Deno.env.delete("COHORT_ALLOW_OPEN_INTERNAL");
  const res = requireInternalAuth(req());
  assertEquals(res?.status, 401);
  Deno.env.delete("COHORT_INTERNAL_SECRET");
});

Deno.test("requireInternalAuth: rejects wrong bearer", () => {
  Deno.env.set("COHORT_INTERNAL_SECRET", "test-secret");
  const res = requireInternalAuth(req("Bearer wrong"));
  assertEquals(res?.status, 401);
  Deno.env.delete("COHORT_INTERNAL_SECRET");
});

Deno.test("requireInternalAuth: accepts matching bearer", () => {
  Deno.env.set("COHORT_INTERNAL_SECRET", "test-secret");
  const res = requireInternalAuth(req("Bearer test-secret"));
  assertEquals(res, null);
  Deno.env.delete("COHORT_INTERNAL_SECRET");
});

Deno.test("requireInternalAuth: allows open mode when secret unset and dev flag set", () => {
  Deno.env.delete("COHORT_INTERNAL_SECRET");
  Deno.env.set("COHORT_ALLOW_OPEN_INTERNAL", "true");
  const res = requireInternalAuth(req());
  assertEquals(res, null);
  Deno.env.delete("COHORT_ALLOW_OPEN_INTERNAL");
});

Deno.test("requireInternalAuth: fails closed when secret unset and not dev", () => {
  Deno.env.delete("COHORT_INTERNAL_SECRET");
  Deno.env.delete("COHORT_ALLOW_OPEN_INTERNAL");
  const res = requireInternalAuth(req());
  assertEquals(res?.status, 503);
});

Deno.test("requireCronAuth: fails closed when secret unset", () => {
  Deno.env.delete("COHORT_CRON_SECRET");
  Deno.env.delete("COHORT_ALLOW_OPEN_INTERNAL");
  const res = requireCronAuth(req());
  assertEquals(res?.status, 503);
});

Deno.test("requireCronAuth: accepts matching bearer", () => {
  Deno.env.set("COHORT_CRON_SECRET", "cron-secret");
  const res = requireCronAuth(req("Bearer cron-secret"));
  assertEquals(res, null);
  Deno.env.delete("COHORT_CRON_SECRET");
});

Deno.test("isDevOpenMode reflects env flag", () => {
  Deno.env.set("COHORT_ALLOW_OPEN_INTERNAL", "true");
  assertEquals(isDevOpenMode(), true);
  Deno.env.delete("COHORT_ALLOW_OPEN_INTERNAL");
  assertEquals(isDevOpenMode(), false);
});
