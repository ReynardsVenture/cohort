import { errorResponse } from "./supabase.ts";

/** Local `supabase functions serve` only — never set in production. */
export function isDevOpenMode(): boolean {
  return Deno.env.get("COHORT_ALLOW_OPEN_INTERNAL") === "true";
}

/** Gate internal HTTP functions that trust caller-supplied user_id. */
export function requireInternalAuth(req: Request): Response | null {
  const secret = Deno.env.get("COHORT_INTERNAL_SECRET");
  if (!secret) {
    if (isDevOpenMode()) return null;
    return errorResponse("internal_auth_not_configured", 503);
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return errorResponse("unauthorized", 401);
  }
  return null;
}

/** Headers for server-to-server calls between edge functions. */
export function internalAuthHeaders(): Record<string, string> {
  const secret = Deno.env.get("COHORT_INTERNAL_SECRET");
  if (!secret) {
    throw new Error("COHORT_INTERNAL_SECRET not configured");
  }
  return {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  };
}

/** Gate dispatcher-run and cron-* endpoints. */
export function requireCronAuth(req: Request): Response | null {
  const secret = Deno.env.get("COHORT_CRON_SECRET");
  if (!secret) {
    if (isDevOpenMode()) return null;
    return errorResponse("cron_auth_not_configured", 503);
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return errorResponse("unauthorized", 401);
  }
  return null;
}
