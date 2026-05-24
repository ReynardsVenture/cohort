/** Flush outbound queue before returning — fire-and-forget is killed on EarlyDrop shutdown. */
export async function triggerDispatcherFlush(): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL");
  const cronSecret = Deno.env.get("COHORT_CRON_SECRET");
  if (!url || !cronSecret) {
    console.error("[trigger-dispatcher] skipped — missing SUPABASE_URL or COHORT_CRON_SECRET");
    return;
  }

  try {
    const res = await fetch(`${url}/functions/v1/dispatcher-run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cronSecret}` },
    });
    const body = await res.text();
    console.error("[trigger-dispatcher]", { status: res.status, body: body.slice(0, 300) });
  } catch (e) {
    console.error("[trigger-dispatcher] failed", e);
  }
}
