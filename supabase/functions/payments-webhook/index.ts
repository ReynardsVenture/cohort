import { getServiceClient, jsonResponse, errorResponse } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);
  const stripeSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

  // In production: verify with Stripe SDK. Stub accepts event for dev.
  let event: { id: string; type: string; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse(body);
  } catch {
    return errorResponse("invalid_json", 400);
  }

  const supabase = getServiceClient();
  const { error: dup } = await supabase.from("stripe_webhook_events").insert({ event_id: event.id });
  if (dup?.code === "23505") return jsonResponse({ received: true, duplicate: true });

  if (event.type === "customer.subscription.updated" || event.type === "checkout.session.completed") {
    const obj = event.data.object;
    const userId = (obj.metadata as Record<string, string>)?.user_id;
    if (userId) {
      await supabase.from("subscriptions").upsert({
        user_id: userId,
        stripe_customer_id: obj.customer as string,
        stripe_subscription_id: obj.subscription as string ?? obj.id as string,
        status: "active",
        tier: "paid",
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    }
  }

  return jsonResponse({ received: true });
});
