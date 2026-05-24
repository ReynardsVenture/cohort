import { getServiceClient, jsonResponse } from "../_shared/supabase.ts";
import { resolveChannelIdentity } from "../_shared/identity.ts";
import { handleCoreAction, persistCoreResult } from "../_shared/core-handler.ts";
import { enqueueOutbound, idempotencyKey } from "../_shared/outbox.ts";
import { internalAuthHeaders } from "../_shared/internal-auth.ts";
import { setUserAgeFromIso } from "../_shared/user-age.ts";
import { triggerDispatcherFlush } from "../_shared/trigger-dispatcher.ts";

console.error("[telegram-webhook] module loaded");

Deno.serve(async (req) => {
  console.error("[telegram-webhook] request", {
    method: req.method,
    hasSecretHeader: Boolean(req.headers.get("X-Telegram-Bot-Api-Secret-Token")),
    secretConfigured: Boolean(Deno.env.get("TELEGRAM_WEBHOOK_SECRET")),
  });

  if (req.method !== "POST") return new Response("ok");

  const secret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  const headerSecret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret && headerSecret !== secret) {
    console.error("[telegram-webhook] webhook secret mismatch", {
      headerPresent: Boolean(headerSecret),
    });
    return new Response("forbidden", { status: 403 });
  }

  try {
    const update = await req.json();
    const message = update.message ?? update.edited_message;
    if (!message?.text || !message.chat?.id) {
      return jsonResponse({ ok: true });
    }

    const chatId = String(message.chat.id);
    const text = message.text.trim();
    const msgKey = message.message_id != null ? `tg:${message.message_id}` : String(Date.now());
    console.error("[telegram-webhook] message", { chatId, textPreview: text.slice(0, 40) });

    const supabase = getServiceClient();

    const resolved = await resolveChannelIdentity(
      supabase,
      "telegram",
      chatId,
      message.from?.username,
    );

    const { data: user } = await supabase.from("users")
      .select("age_verified_at")
      .eq("id", resolved.userId)
      .single();

    if (!user?.age_verified_at) {
      const dobMatch = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (dobMatch) {
        const [, d, m, y] = dobMatch;
        const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
        const ageResult = await setUserAgeFromIso(supabase, resolved.userId, iso);
        if (!ageResult.ok) {
          const templateKey = ageResult.error === "underage" ? "age_underage" : "age_invalid_format";
          await enqueueOutbound(supabase, [{
            userId: resolved.userId,
            channel: "telegram",
            templateKey,
            payload: {},
            idempotencyKey: idempotencyKey("age_fail", resolved.userId, msgKey),
          }]);
          triggerDispatcherFlush();
          console.error("[telegram-webhook] age set failed", ageResult);
          return jsonResponse({ ok: true });
        }
        await enqueueOutbound(supabase, [{
          userId: resolved.userId,
          channel: "telegram",
          templateKey: "welcome_new",
          payload: {},
          idempotencyKey: idempotencyKey("age_ok", resolved.userId, msgKey),
        }]);
        triggerDispatcherFlush();
        console.error("[telegram-webhook] age verified via DOB, welcome enqueued");
        return jsonResponse({ ok: true });
      }
      const looksLikeDateAttempt = /\d/.test(text);
      await enqueueOutbound(supabase, [{
        userId: resolved.userId,
        channel: "telegram",
        templateKey: looksLikeDateAttempt ? "age_invalid_format" : "age_gate_required",
        payload: {},
        idempotencyKey: idempotencyKey("age_gate", resolved.userId, msgKey),
      }]);
      triggerDispatcherFlush();
      console.error("[telegram-webhook] age gate enqueued");
      return jsonResponse({ ok: true });
    }

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
        triggerDispatcherFlush();
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
        triggerDispatcherFlush();
        return jsonResponse({ ok: true, ...result });
      }
    }

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
      triggerDispatcherFlush();
      return jsonResponse({ ok: true, ...result });
    }

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
      triggerDispatcherFlush();
      return jsonResponse({ ok: true, ...result });
    }

    console.error("[telegram-webhook] onboarding path");
    const aiRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/ai-proxy`, {
      method: "POST",
      headers: internalAuthHeaders(),
      body: JSON.stringify({ job: "onboarding", user_id: resolved.userId, message: text }),
    });
    const aiJson = await aiRes.json();
    if (!aiRes.ok) {
      console.error("[telegram-webhook] ai-proxy failed", { status: aiRes.status, body: aiJson });
      await enqueueOutbound(supabase, [{
        userId: resolved.userId,
        channel: "telegram",
        templateKey: "safety_notice",
        payload: {
          message: "Entschuldigung — gerade gibt es ein technisches Problem. Bitte versuch es in einer Minute nochmal.",
        },
        idempotencyKey: idempotencyKey("ai_err", resolved.userId, msgKey),
      }]);
      triggerDispatcherFlush();
      return jsonResponse({ ok: true });
    }
    if (aiJson.reply) {
      await enqueueOutbound(supabase, [{
        userId: resolved.userId,
        channel: "telegram",
        templateKey: "safety_notice",
        payload: { message: aiJson.reply },
        idempotencyKey: idempotencyKey("ai_reply", resolved.userId, msgKey),
      }]);
    }

    const result = await handleCoreAction(supabase, {
      type: "OnboardingMessage",
      userId: resolved.userId,
      text,
    });
    await persistCoreResult(supabase, result);
    triggerDispatcherFlush();

    console.error("[telegram-webhook] done");
    return jsonResponse({ ok: true });
  } catch (e) {
    console.error("[telegram-webhook] error", e instanceof Error ? e.stack ?? e.message : e);
    return jsonResponse({ ok: true });
  }
});
