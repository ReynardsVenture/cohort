/** Best-effort flush so users get replies without waiting for external cron. */
export function triggerDispatcherFlush(): void {
  const url = Deno.env.get("SUPABASE_URL");
  const cronSecret = Deno.env.get("COHORT_CRON_SECRET");
  if (!url || !cronSecret) return;

  fetch(`${url}/functions/v1/dispatcher-run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cronSecret}` },
  }).catch((e) => console.error("[trigger-dispatcher] failed", e));
}
