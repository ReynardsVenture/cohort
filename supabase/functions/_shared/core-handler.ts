import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getConfigInt } from "./config.ts";
import { assertUserEligible, getPreferredChannel } from "./identity.ts";
import { enqueueOutbound, idempotencyKey } from "./outbox.ts";
import type { CoreAction, CoreResult } from "./types.ts";

function rpcResult(data: Record<string, unknown> | null, error: { message: string } | null): CoreResult {
  if (error) return { success: false, message: error.message };
  if (!data) return { success: false, message: "empty_response" };
  if (data.success === false) return { success: false, message: String(data.error ?? "failed") };
  return { success: true, message: data.message as string | undefined, data };
}

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

  const messages = (session?.messages ?? []) as { role: string; content: string }[];
  messages.push({ role: "user", content: text, at: new Date().toISOString() });

  if (session) {
    await supabase.from("ai_interview_sessions").update({
      messages,
      updated_at: new Date().toISOString(),
    }).eq("id", session.id);
  } else {
    await supabase.from("ai_interview_sessions").insert({
      user_id: userId,
      status: "active",
      prompt_version: "onboarding-v1",
      messages,
    });
  }

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

async function handleSendSpark(
  supabase: SupabaseClient,
  action: Extract<CoreAction, { type: "SendSpark" }>,
): Promise<CoreResult> {
  const eligible = await assertUserEligible(supabase, action.userId);
  if (!eligible.ok) return { success: false, message: eligible.reason };

  const minChars = await getConfigInt(supabase, "spark_message_min_chars", 20);
  const maxChars = await getConfigInt(supabase, "spark_message_max_chars", 280);
  if (action.message.length < minChars || action.message.length > maxChars) {
    return { success: false, message: "invalid_message_length" };
  }

  const expiryHours = await getConfigInt(supabase, "spark_expiry_hours", 48);
  const expiresAt = new Date(Date.now() + expiryHours * 3600 * 1000).toISOString();

  const { data, error } = await supabase.rpc("send_spark_tx", {
    _from_user_id: action.userId,
    _to_user_id: action.toUserId,
    _round_id: action.roundId,
    _style: action.style,
    _message: action.message,
    _intent_level: action.intentLevel,
    _expires_at: expiresAt,
  });

  return rpcResult(data as Record<string, unknown>, error);
}

async function handleRespondSpark(
  supabase: SupabaseClient,
  action: Extract<CoreAction, { type: "RespondSpark" }>,
): Promise<CoreResult> {
  if (!action.accept) {
    const { data, error } = await supabase.rpc("respond_spark_decline_tx", {
      _user_id: action.userId,
      _spark_id: action.sparkId,
    });
    return rpcResult(data as Record<string, unknown>, error);
  }

  const turnHours = await getConfigInt(supabase, "thread_turn_hours", 72);
  const deadline = new Date(Date.now() + turnHours * 3600 * 1000).toISOString();

  const { data, error } = await supabase.rpc("respond_spark_accept_tx", {
    _user_id: action.userId,
    _spark_id: action.sparkId,
    _turn_deadline: deadline,
  });

  return rpcResult(data as Record<string, unknown>, error);
}

async function handleSubmitThreadTurn(
  supabase: SupabaseClient,
  action: Extract<CoreAction, { type: "SubmitThreadTurn" }>,
): Promise<CoreResult> {
  const turnHours = await getConfigInt(supabase, "thread_turn_hours", 72);
  const { data, error } = await supabase.rpc("submit_thread_turn_tx", {
    _user_id: action.userId,
    _thread_id: action.threadId,
    _response: action.response,
    _turn_hours: turnHours,
  });
  return rpcResult(data as Record<string, unknown>, error);
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
  const outcome = (data as { outcome?: string })?.outcome;
  return { success: true, message: outcome };
}

async function handleSendRelayMessage(
  supabase: SupabaseClient,
  action: Extract<CoreAction, { type: "SendRelayMessage" }>,
): Promise<CoreResult> {
  const { data, error } = await supabase.rpc("send_relay_message_tx", {
    _sender_user_id: action.userId,
    _thread_id: action.threadId,
    _body: action.body,
    _client_message_id: action.clientMessageId ?? null,
  });
  return rpcResult(data as Record<string, unknown>, error);
}

async function handleBlockUser(
  supabase: SupabaseClient,
  action: Extract<CoreAction, { type: "BlockUser" }>,
): Promise<CoreResult> {
  await supabase.from("blocks").insert({ blocker_id: action.userId, blocked_id: action.blockedId });
  return { success: true };
}

async function handleReportUser(
  supabase: SupabaseClient,
  action: Extract<CoreAction, { type: "ReportUser" }>,
): Promise<CoreResult> {
  await supabase.from("reports").insert({
    reporter_id: action.userId,
    reported_user_id: action.reportedId,
    reason: action.reason,
    thread_id: action.threadId ?? null,
  });
  return { success: true };
}

/** Only for handlers that still return outboundIntents (e.g. onboarding). Transactional RPCs enqueue in-DB. */
export async function persistCoreResult(supabase: SupabaseClient, result: CoreResult): Promise<void> {
  if (result.outboundIntents?.length) {
    await enqueueOutbound(supabase, result.outboundIntents);
  }
}
