import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getConfigText } from "./config.ts";

const PROMPT_VERSION = "v1";

async function loadPrompt(job: string): Promise<string> {
  const paths: Record<string, string> = {
    onboarding: "onboarding/system.md",
    matching: "matching/system.md",
    facilitation: "thread-facilitation/system.md",
  };
  try {
    const path = paths[job];
    if (!path) return "";
    return await Deno.readTextFile(new URL(`../../../prompts/${path}`, import.meta.url));
  } catch {
    return "You are the Cohort AI matchmaker. Be helpful, concise, and never pretend to be human.";
  }
}

function sanitizeModelId(model: string): string {
  return model.replace(/^["']+|["']+$/g, "").trim();
}

const FALLBACK_MODEL = "claude-sonnet-4-5-20250929";

async function callClaude(
  model: string,
  system: string,
  messages: { role: string; content: string }[],
): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY missing");

  const modelId = sanitizeModelId(model);
  const body = {
    model: modelId,
    max_tokens: 1024,
    system,
    messages: messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
  };

  const call = async (useModel: string) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, model: useModel }),
    });
    const raw = await res.text();
    let json: { error?: { message?: string; type?: string }; content?: { type: string; text?: string }[] };
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`anthropic_non_json:${res.status}:${raw.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = json.error?.message ?? raw.slice(0, 300);
      const err = new Error(`anthropic_${res.status}:${msg}`);
      (err as Error & { status?: number; type?: string }).status = res.status;
      (err as Error & { type?: string }).type = json.error?.type;
      throw err;
    }
    const block = json.content?.[0];
    return block?.type === "text" ? block.text ?? "" : "";
  };

  try {
    return await call(modelId);
  } catch (e) {
    const typed = e as Error & { status?: number; type?: string };
    if (typed.status === 404 || typed.type === "not_found_error") {
      console.error("[ai-jobs] model not found, retrying", { model: modelId, fallback: FALLBACK_MODEL });
      return await call(FALLBACK_MODEL);
    }
    throw e;
  }
}

export async function runOnboardingJob(
  supabase: SupabaseClient,
  userId: string,
  message: string,
): Promise<{ reply: string; prompt_version: string }> {
  const model = await getConfigText(supabase, "ai.model.onboarding", "claude-sonnet-4-6");
  const system = await loadPrompt("onboarding");

  const { data: session } = await supabase.from("ai_interview_sessions")
    .select("id, messages, running_summary")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  const history = (session?.messages ?? []) as { role: string; content: string }[];
  const summary = session?.running_summary
    ? `Summary so far: ${JSON.stringify(session.running_summary)}\n\n`
    : "";

  const reply = await callClaude(model, system, [
    { role: "user", content: summary + "Continue the onboarding interview." },
    ...history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message },
  ]);

  const updated = [...history, { role: "user", content: message }, { role: "assistant", content: reply }];

  if (session) {
    await supabase.from("ai_interview_sessions").update({
      messages: updated,
      updated_at: new Date().toISOString(),
    }).eq("id", session.id);
  } else {
    await supabase.from("ai_interview_sessions").insert({
      user_id: userId,
      status: "active",
      prompt_version: "onboarding-v1",
      messages: updated,
    });
  }

  if (reply.includes("[PROFILE_READY]")) {
    await supabase.from("profiles").update({
      onboarding_status: "complete",
      bio_structured: { raw: reply },
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);
    await supabase.from("ai_interview_sessions").update({
      status: "completed",
      completed_at: new Date().toISOString(),
    }).eq("user_id", userId).eq("status", "active");
  }

  return {
    reply: reply.replace("[PROFILE_READY]", "").trim(),
    prompt_version: PROMPT_VERSION,
  };
}

export async function runMatchingJob(
  supabase: SupabaseClient,
  userId: string,
  body: Record<string, unknown>,
): Promise<{ suggestions: unknown[]; prompt_version: string; incident?: boolean }> {
  const model = await getConfigText(supabase, "ai.model.matching", "claude-opus-4-7");
  const system = await loadPrompt("matching");
  const candidates = (body.candidates ?? []) as unknown[];
  const reply = await callClaude(model, system, [{
    role: "user",
    content: `User profile:\n${JSON.stringify(body.profile)}\n\nCandidates:\n${JSON.stringify(candidates)}`,
  }]);
  try {
    const parsed = JSON.parse(reply.replace(/```json\n?|\n?```/g, "").trim());
    return { suggestions: parsed.suggestions ?? [], prompt_version: PROMPT_VERSION };
  } catch {
    await supabase.from("domain_events").insert({
      aggregate_type: "matching",
      aggregate_id: userId,
      event_type: "matching_incident",
      payload: { error: "parse_failed", raw: reply.slice(0, 500) },
    });
    return { suggestions: [], prompt_version: PROMPT_VERSION, incident: true };
  }
}

export async function runFacilitationJob(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const model = await getConfigText(supabase, "ai.model.facilitation", "claude-sonnet-4-6");
  const system = await loadPrompt("facilitation");
  const reply = await callClaude(model, system, [{
    role: "user",
    content: JSON.stringify(body.thread_context ?? {}),
  }]);
  try {
    return JSON.parse(reply.replace(/```json\n?|\n?```/g, "").trim());
  } catch {
    return { prompt: "Was bedeutet euch Vertrauen in einer Beziehung?", ready_for_contract: false };
  }
}
