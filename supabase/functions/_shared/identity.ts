import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { ChannelType } from "./types.ts";

export interface ResolvedIdentity {
  userId: string;
  channelIdentityId: string;
  isNew: boolean;
}

export async function resolveChannelIdentity(
  supabase: SupabaseClient,
  channel: ChannelType,
  externalId: string,
  externalUsername?: string,
): Promise<ResolvedIdentity> {
  const { data: existing } = await supabase
    .from("channel_identities")
    .select("id, user_id")
    .eq("channel", channel)
    .eq("external_id", externalId)
    .maybeSingle();

  if (existing) {
    return { userId: existing.user_id, channelIdentityId: existing.id, isNew: false };
  }

  const { data: user, error: userErr } = await supabase
    .from("users")
    .insert({ preferred_outbound_channel: channel })
    .select("id")
    .single();
  if (userErr) throw userErr;

  const { data: ci, error: ciErr } = await supabase
    .from("channel_identities")
    .insert({
      user_id: user.id,
      channel,
      external_id: externalId,
      external_username: externalUsername ?? null,
      is_primary: true,
      verified_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (ciErr) throw ciErr;

  await supabase.from("profiles").insert({
    user_id: user.id,
    region_key: "berlin",
    onboarding_status: "interviewing",
  });

  return { userId: user.id, channelIdentityId: ci.id, isNew: true };
}

export async function getPreferredChannel(
  supabase: SupabaseClient,
  userId: string,
): Promise<ChannelType> {
  const { data } = await supabase.from("users").select("preferred_outbound_channel").eq("id", userId).single();
  return (data?.preferred_outbound_channel as ChannelType) ?? "telegram";
}

export async function assertUserEligible(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data: user } = await supabase.from("users").select("status, age_verified_at").eq("id", userId).single();
  if (!user) return { ok: false, reason: "user_not_found" };
  if (user.status === "suspended" || user.status === "banned") {
    return { ok: false, reason: "account_restricted" };
  }
  if (!user.age_verified_at) return { ok: false, reason: "age_not_verified" };

  const { data: profile } = await supabase
    .from("profiles")
    .select("moderation_status, onboarding_status, is_paused")
    .eq("user_id", userId)
    .single();
  if (profile?.is_paused) return { ok: false, reason: "paused" };
  if (profile?.moderation_status === "suspended" || profile?.moderation_status === "banned") {
    return { ok: false, reason: "account_restricted" };
  }
  if (profile?.onboarding_status !== "complete") return { ok: false, reason: "onboarding_incomplete" };

  return { ok: true };
}
