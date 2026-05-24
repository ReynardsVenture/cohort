import { getServiceClient, jsonResponse } from "../_shared/supabase.ts";
import { resolveChannelIdentity } from "../_shared/identity.ts";
import { handleCoreAction, persistCoreResult } from "../_shared/core-handler.ts";
import { enqueueOutbound, idempotencyKey } from "../_shared/outbox.ts";
import { internalAuthHeaders } from "../_shared/internal-auth.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");

  const secret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  if (secret && req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await req.json();
  const message = update.message ?? update.edited_message;
  if (!message?.text || !message.chat?.id) return jsonResponse({ ok: true });

  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const supabase = getServiceClient();

  const resolved = await resolveChannelIdentity(
    supabase,
    "telegram",
    chatId,
    message.from?.username,
  );

  const { data: user } = await supabase.from("users").select("age_verified_at, primary_phone").eq("id", resolved.userId).single();

  if (!user?.age_verified_at) {
    const dobMatch = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (dobMatch) {
      const [, d, m, y] = dobMatch;
      const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/identity-set-age`, {
        method: "POST",
        headers: internalAuthHeaders(),
        body: JSON.stringify({ user_id: resolved.userId, date_of_birth: iso }),
      });
      await enqueueOutbound(supabase, [{
        userId: resolved.userId,
        channel: "telegram",
        templateKey: "welcome_new",
        payload: {},
        idempotencyKey: idempotencyKey("age_ok", resolved.userId),
      }]);
      return jsonResponse({ ok: true });
    }
    await enqueueOutbound(supabase, [{
      userId: resolved.userId,
      channel: "telegram",
      templateKey: "age_gate_required",
      payload: {},
      idempotencyKey: idempotencyKey("age_gate", resolved.userId),
    }]);
    return jsonResponse({ ok: true });
  }

  // Spark responses
  if (/^(ja|yes)$/i.test(text)) {
    const { data: pendingSpark } = await supabase.from("sparks")
      .select("id").eq("to_user_id", resolved.userId).eq("status", "pending").limit(1).maybeSingle();
    if (pendingSpark) {
      const result = await handleCoreAction(supabase, {
        type: "RespondSpark",
        userId: resolved.userId,
        sparkId: pendingSpark.id,
        accept: true,
      });
      return jsonResponse({ ok: true, ...result });
    }
  }
  if (/^(nein|no)$/i.test(text)) {
    const { data: pendingSpark } = await supabase.from("sparks")
      .select("id").eq("to_user_id", resolved.userId).eq("status", "pending").limit(1).maybeSingle();
    if (pendingSpark) {
      const result = await handleCoreAction(supabase, {
        type: "RespondSpark",
        userId: resolved.userId,
        sparkId: pendingSpark.id,
        accept: false,
      });
      return jsonResponse({ ok: true, ...result });
    }
  }

  // Active thread turn
  const { data: thread } = await supabase.from("threads")
    .select("id, status")
    .or(`user_a.eq.${resolved.userId},user_b.eq.${resolved.userId}`)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (thread) {
    const result = await handleCoreAction(supabase, {
      type: "SubmitThreadTurn",
      userId: resolved.userId,
      threadId: thread.id,
      response: text,
    });
    return jsonResponse({ ok: true, ...result });
  }

  // Revealed relay
  const { data: revealed } = await supabase.from("threads")
    .select("id, status")
    .or(`user_a.eq.${resolved.userId},user_b.eq.${resolved.userId}`)
    .in("status", ["revealed", "date_alignment"])
    .limit(1)
    .maybeSingle();

  if (revealed) {
    const result = await handleCoreAction(supabase, {
      type: "SendRelayMessage",
      userId: resolved.userId,
      threadId: revealed.id,
      body: text,
      clientMessageId: message.message_id != null ? `tg:${message.message_id}` : undefined,
    });
    // Outbox enqueued inside send_relay_message_tx RPC
    return jsonResponse({ ok: true, ...result });
  }

  // Onboarding / AI interview
  const aiRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/ai-proxy`, {
    method: "POST",
    headers: internalAuthHeaders(),
    body: JSON.stringify({ job: "onboarding", user_id: resolved.userId, message: text }),
  });
  const aiJson = await aiRes.json();
  if (aiJson.reply) {
    await enqueueOutbound(supabase, [{
      userId: resolved.userId,
      channel: "telegram",
      templateKey: "safety_notice",
      payload: { message: aiJson.reply },
      idempotencyKey: idempotencyKey("ai_reply", resolved.userId, `tg:${message.message_id}`),
    }]);
  }

  const result = await handleCoreAction(supabase, {
    type: "OnboardingMessage",
    userId: resolved.userId,
    text,
  });
  await persistCoreResult(supabase, result);

  return jsonResponse({ ok: true });
});
