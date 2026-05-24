import { errorResponse } from "./supabase.ts";

/** Local `supabase functions serve` only — never set in production. */
export function isDevOpenMode(): boolean {
  return Deno.env.get("COHORT_ALLOW_OPEN_INTERNAL") === "true";
}

function internalSecretValid(req: Request, secret: string): boolean {
  if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cohort-internal-secret") === secret) return true;
  return false;
}

/** Gate internal HTTP functions that trust caller-supplied user_id. */
export function requireInternalAuth(req: Request): Response | null {
  const secret = Deno.env.get("COHORT_INTERNAL_SECRET");
  if (!secret) {
    if (isDevOpenMode()) return null;
    return errorResponse("internal_auth_not_configured", 503);
  }
  if (!internalSecretValid(req, secret)) {
    return errorResponse("unauthorized", 401);
  }
  return null;
}

/** Headers for edge-to-edge calls (Supabase gateway needs service role Bearer). */
export function internalAuthHeaders(): Record<string, string> {
  const secret = Deno.env.get("COHORT_INTERNAL_SECRET");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret) throw new Error("COHORT_INTERNAL_SECRET not configured");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured");
  return {
    Authorization: `Bearer ${serviceKey}`,
    "X-Cohort-Internal-Secret": secret,
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
