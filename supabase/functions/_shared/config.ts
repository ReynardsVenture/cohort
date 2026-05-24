import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export async function getConfig(supabase: SupabaseClient, key: string): Promise<string | number | null> {
  const { data } = await supabase.from("cohort_config").select("value").eq("key", key).single();
  if (!data?.value) return null;
  const v = data.value;
  if (typeof v === "string") return v.replace(/^"|"$/g, "");
  if (typeof v === "number") return v;
  return String(v);
}

export async function getConfigInt(supabase: SupabaseClient, key: string, fallback: number): Promise<number> {
  const v = await getConfig(supabase, key);
  if (v === null) return fallback;
  return typeof v === "number" ? v : parseInt(String(v), 10);
}

export async function getConfigText(supabase: SupabaseClient, key: string, fallback: string): Promise<string> {
  const v = await getConfig(supabase, key);
  return v === null ? fallback : String(v);
}
