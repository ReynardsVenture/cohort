import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getConfigInt } from "./config.ts";
import { assertUserEligible, getPreferredChannel } from "./identity.ts";
import { emitDomainEvent, enqueueOutbound, idempotencyKey } from "./outbox.ts";
import type { CoreAction, CoreResult, OutboundIntent } from "./types.ts";

export async function handleCoreAction(
  supabase: SupabaseClient,
  action: CoreAction,
): Promise<CoreResult> {
  switch (action.type) {
    case "OnboardingMessage":
      return handleOnboardingMessage(supabase, action.userId, action.text);
    case "SendSpark":
      return handleSendSpark(supabase, action);
    case "RespondSpark":
      return handleRespondSpark(supabase, action);
    case "SubmitThreadTurn":
      return handleSubmitThreadTurn(supabase, action);
    case "SubmitContract":
      return handleSubmitContract(supabase, action);
    case "SendRelayMessage":
      return handleSendRelayMessage(supabase, action);
    case "BlockUser":
      return handleBlockUser(supabase, action);
    case "ReportUser":
      return handleReportUser(supabase, action);
    default:
      return { success: false, message: "unknown_action" };
  }
}

async function handleOnboardingMessage(
  supabase: SupabaseClient,
  userId: string,
  text: string,
): Promise<CoreResult> {
  const { data: session } = await supabase
    .from("ai_interview_sessions")
    .select("id, messages, running_summary")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  const messages = session?.messages ?? [];
  messages.push({ role: "user", content: text, at: new Date().toISOString() });

  if (session) {
    await supabase.from("ai_interview_sessions").update({ messages, updated_at: new Date().toISOString() }).eq("id", session.id);
  } else {
    await supabase.from("ai_interview_sessions").insert({
      user_id: userId,
      status: "active",
      prompt_version: "onboarding-v1",
      messages,
    });
  }

  // AI response delegated to ai-proxy via separate call; return placeholder intent
  const channel = await getPreferredChannel(supabase, userId);
  return {
    success: true,
    message: "onboarding_continue",
    outboundIntents: [{
      userId,
      channel,
      templateKey: "ai_disclosure",
      payload: {},
      idempotencyKey: idempotencyKey("onboarding", userId, "disclosure", String(messages.length)),
    }],
  };
}

async function handleSendSpark(supabase: SupabaseClient, action: Extract<CoreAction, { type: "SendSpark" }>): Promise<CoreResult> {
  const eligible = await assertUserEligible(supabase, action.userId);
  if (!eligible.ok) return { success: false, message: eligible.reason };

  const minChars = await getConfigInt(supabase, "spark_message_min_chars", 20);
  const maxChars = await getConfigInt(supabase, "spark_message_max_chars", 280);
  if (action.message.length < minChars || action.message.length > maxChars) {
    return { success: false, message: "invalid_message_length" };
  }

  const { data: blocked } = await supabase.rpc("is_blocked", { _a: action.userId, _b: action.toUserId });
  if (blocked) return { success: false, message: "blocked" };

  const budget = await getConfigInt(supabase, "sparks_per_week_free", 5);
  const { data: quota } = await supabase.from("weekly_quotas").select("sparks_sent, sparks_budget")
    .eq("user_id", action.userId).eq("round_id", action.roundId).maybeSingle();
  const sent = quota?.sparks_sent ?? 0;
  const limit = quota?.sparks_budget ?? budget;
  if (sent >= limit) return { success: false, message: "spark_budget_exceeded" };

  const expiryHours = await getConfigInt(supabase, "spark_expiry_hours", 48);
  const expiresAt = new Date(Date.now() + expiryHours * 3600 * 1000).toISOString();

  const { data: spark, error } = await supabase.from("sparks").insert({
    round_id: action.roundId,
    from_user_id: action.userId,
    to_user_id: action.toUserId,
    style: action.style,
    message: action.message,
    intent_level: action.intentLevel,
    expires_at: expiresAt,
  }).select("id").single();
  if (error) return { success: false, message: error.message };

  await supabase.from("weekly_quotas").upsert({
    user_id: action.userId,
    round_id: action.roundId,
    sparks_sent: sent + 1,
    sparks_budget: limit,
  }, { onConflict: "user_id,round_id" });

  const eventId = await emitDomainEvent(supabase, "spark", spark.id, "spark.sent", { sparkId: spark.id });
  const recipientChannel = await getPreferredChannel(supabase, action.toUserId);
  const intents: OutboundIntent[] = [{
    userId: action.toUserId,
    channel: recipientChannel,
    templateKey: "spark_received",
    payload: { preview: action.message.slice(0, 80), sparkId: spark.id },
    idempotencyKey: idempotencyKey(eventId, action.toUserId, "spark_received"),
  }];

  return { success: true, outboundIntents: intents };
}

async function handleRespondSpark(supabase: SupabaseClient, action: Extract<CoreAction, { type: "RespondSpark" }>): Promise<CoreResult> {
  const { data: spark } = await supabase.from("sparks").select("*").eq("id", action.sparkId).single();
  if (!spark || spark.to_user_id !== action.userId) return { success: false, message: "not_found" };
  if (spark.status !== "pending") return { success: false, message: "invalid_status" };

  if (!action.accept) {
    await supabase.from("sparks").update({ status: "declined", updated_at: new Date().toISOString() }).eq("id", action.sparkId);
    const channel = await getPreferredChannel(supabase, spark.from_user_id);
    return {
      success: true,
      outboundIntents: [{
        userId: spark.from_user_id,
        channel,
        templateKey: "spark_declined",
        payload: {},
        idempotencyKey: idempotencyKey(action.sparkId, "declined"),
      }],
    };
  }

  await supabase.from("sparks").update({ status: "accepted", updated_at: new Date().toISOString() }).eq("id", action.sparkId);

  const turnHours = await getConfigInt(supabase, "thread_turn_hours", 72);
  const deadline = new Date(Date.now() + turnHours * 3600 * 1000).toISOString();

  const { data: thread } = await supabase.from("threads").insert({
    spark_id: action.sparkId,
    user_a: spark.from_user_id,
    user_b: spark.to_user_id,
    turn_deadline: deadline,
    facilitator_state: { turn: 1 },
  }).select("id").single();

  await supabase.from("contracts").insert({
    thread_id: thread!.id,
    user_a: spark.from_user_id,
    user_b: spark.to_user_id,
  });

  const firstPrompt = "Was hat euch in den letzten Tagen am meisten beschäftigt — und warum?";
  await supabase.from("thread_turns").insert({
    thread_id: thread!.id,
    turn_number: 1,
    facilitator_prompt: firstPrompt,
  });

  const intents: OutboundIntent[] = [];
  for (const uid of [spark.from_user_id, spark.to_user_id]) {
    intents.push({
      userId: uid,
      channel: await getPreferredChannel(supabase, uid),
      templateKey: "spark_accepted",
      payload: { threadId: thread!.id },
      idempotencyKey: idempotencyKey(action.sparkId, uid, "accepted"),
    });
    intents.push({
      userId: uid,
      channel: await getPreferredChannel(supabase, uid),
      templateKey: "thread_prompt",
      payload: { prompt: firstPrompt },
      idempotencyKey: idempotencyKey(thread!.id, uid, "turn1"),
    });
  }

  return { success: true, outboundIntents: intents };
}

async function handleSubmitThreadTurn(
  supabase: SupabaseClient,
  action: Extract<CoreAction, { type: "SubmitThreadTurn" }>,
): Promise<CoreResult> {
  const { data: thread } = await supabase.from("threads").select("*").eq("id", action.threadId).single();
  if (!thread || thread.status !== "active") return { success: false, message: "invalid_thread" };
  if (action.userId !== thread.user_a && action.userId !== thread.user_b) {
    return { success: false, message: "not_participant" };
  }

  const { data: turn } = await supabase.from("thread_turns")
    .select("*").eq("thread_id", action.threadId).eq("turn_number", thread.current_turn).single();
  if (!turn) return { success: false, message: "no_active_turn" };

  const isA = action.userId === thread.user_a;
  const patch = isA
    ? { user_a_response: action.response, submitted_at_a: new Date().toISOString() }
    : { user_b_response: action.response, submitted_at_b: new Date().toISOString() };
  await supabase.from("thread_turns").update(patch).eq("id", turn.id);

  const { data: updated } = await supabase.from("thread_turns").select("*").eq("id", turn.id).single();
  if (!updated?.user_a_response || !updated?.user_b_response) {
    return { success: true, message: "waiting_for_partner" };
  }

  if (thread.current_turn >= 4) {
    await supabase.from("threads").update({ status: "ready_for_contract", updated_at: new Date().toISOString() }).eq("id", thread.id);
    const intents: OutboundIntent[] = [];
    for (const uid of [thread.user_a, thread.user_b]) {
      intents.push({
        userId: uid,
        channel: await getPreferredChannel(supabase, uid),
        templateKey: "contract_request",
        payload: {},
        idempotencyKey: idempotencyKey(thread.id, uid, "contract"),
      });
    }
    return { success: true, outboundIntents: intents };
  }

  const nextTurn = thread.current_turn + 1;
  const nextPrompt = "Was würdet ihr beim ersten Treffen gerne herausfinden?";
  const turnHours = await getConfigInt(supabase, "thread_turn_hours", 72);
  await supabase.from("threads").update({
    current_turn: nextTurn,
    turn_deadline: new Date(Date.now() + turnHours * 3600 * 1000).toISOString(),
  }).eq("id", thread.id);
  await supabase.from("thread_turns").insert({
    thread_id: thread.id,
    turn_number: nextTurn,
    facilitator_prompt: nextPrompt,
  });

  const intents: OutboundIntent[] = [];
  for (const uid of [thread.user_a, thread.user_b]) {
    intents.push({
      userId: uid,
      channel: await getPreferredChannel(supabase, uid),
      templateKey: "thread_prompt",
      payload: { prompt: nextPrompt },
      idempotencyKey: idempotencyKey(thread.id, uid, `turn${nextTurn}`),
    });
  }
  return { success: true, outboundIntents: intents };
}

async function handleSubmitContract(
  supabase: SupabaseClient,
  action: Extract<CoreAction, { type: "SubmitContract" }>,
): Promise<CoreResult> {
  const pace = (action.pace ?? "this_week") as "today" | "this_week" | "slow";
  const { data, error } = await supabase.rpc("submit_contract_decision", {
    _thread_id: action.threadId,
    _user_id: action.userId,
    _decision: action.decision,
    _pace: pace,
  });
  if (error) return { success: false, message: error.message };

  const outcome = data?.outcome;
  if (outcome !== "revealed") return { success: true, message: outcome };

  const { data: thread } = await supabase.from("threads").select("user_a, user_b").eq("id", action.threadId).single();
  await supabase.from("relay_threads").insert({
    match_thread_id: action.threadId,
    alias_a: "Dein Match",
    alias_b: "Dein Match",
  });

  const intents: OutboundIntent[] = [];
  for (const uid of [thread!.user_a, thread!.user_b]) {
    intents.push({
      userId: uid,
      channel: await getPreferredChannel(supabase, uid),
      templateKey: "reveal_unlocked",
      payload: {},
      idempotencyKey: idempotencyKey(action.threadId, uid, "reveal"),
    });
  }
  return { success: true, outboundIntents: intents };
}

async function handleSendRelayMessage(
  supabase: SupabaseClient,
  action: Extract<CoreAction, { type: "SendRelayMessage" }>,
): Promise<CoreResult> {
  const { data: thread } = await supabase.from("threads").select("*").eq("id", action.threadId).single();
  if (!thread || !["revealed", "date_alignment", "match_closed"].includes(thread.status)) {
    return { success: false, message: "not_revealed" };
  }

  const recipientId = action.userId === thread.user_a ? thread.user_b : thread.user_a;
  const { data: relay } = await supabase.from("relay_threads").select("id, alias_a, alias_b").eq("match_thread_id", action.threadId).single();
  if (!relay) return { success: false, message: "no_relay" };

  await supabase.from("relay_messages").insert({
    relay_thread_id: relay.id,
    sender_user_id: action.userId,
    body: action.body,
  });
  await supabase.from("messages").insert({
    thread_id: action.threadId,
    sender_user_id: action.userId,
    body: action.body,
  });

  const alias = action.userId === thread.user_a ? relay.alias_a : relay.alias_b;
  return {
    success: true,
    outboundIntents: [{
      userId: recipientId,
      channel: await getPreferredChannel(supabase, recipientId),
      templateKey: "relay_message",
      payload: { alias, body: action.body },
      idempotencyKey: idempotencyKey("relay", action.threadId, String(Date.now()), recipientId),
    }],
  };
}

async function handleBlockUser(supabase: SupabaseClient, action: Extract<CoreAction, { type: "BlockUser" }>): Promise<CoreResult> {
  await supabase.from("blocks").insert({ blocker_id: action.userId, blocked_id: action.blockedId });
  return { success: true };
}

async function handleReportUser(supabase: SupabaseClient, action: Extract<CoreAction, { type: "ReportUser" }>): Promise<CoreResult> {
  await supabase.from("reports").insert({
    reporter_id: action.userId,
    reported_user_id: action.reportedId,
    reason: action.reason,
    thread_id: action.threadId ?? null,
  });
  return { success: true };
}

export async function persistCoreResult(supabase: SupabaseClient, result: CoreResult): Promise<void> {
  if (result.outboundIntents?.length) {
    await enqueueOutbound(supabase, result.outboundIntents);
  }
}
