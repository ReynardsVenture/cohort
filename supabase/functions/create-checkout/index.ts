import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";
import { requireInternalAuth } from "../_shared/internal-auth.ts";

Deno.serve(async (req) => {
  const authErr = requireInternalAuth(req);
  if (authErr) return authErr;
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);
  const { user_id, success_url, cancel_url } = await req.json();
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) return errorResponse("stripe_not_configured", 503);

  const priceId = Deno.env.get("STRIPE_PRICE_ID_PAID");
  if (!priceId) return errorResponse("price_not_configured", 503);

  const params = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: success_url ?? "https://meetcohort.co/success",
    cancel_url: cancel_url ?? "https://meetcohort.co/cancel",
    "metadata[user_id]": user_id,
    "subscription_data[metadata][user_id]": user_id,
  });

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const session = await res.json();
  if (!res.ok) return errorResponse(session.error?.message ?? "stripe_error", 500);

  const supabase = getServiceClient();
  await supabase.from("subscriptions").upsert({
    user_id,
    stripe_customer_id: session.customer,
    status: "pending",
    tier: "free",
  }, { onConflict: "user_id" });

  return jsonResponse({ url: session.url });
});
