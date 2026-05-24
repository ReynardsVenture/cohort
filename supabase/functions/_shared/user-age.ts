import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getConfigInt } from "./config.ts";

export type SetUserAgeResult =
  | { ok: true }
  | { ok: false; error: "invalid_date" | "underage" | "db_error"; message?: string };

/** Set age from ISO date string YYYY-MM-DD */
export async function setUserAgeFromIso(
  supabase: SupabaseClient,
  userId: string,
  dateOfBirthIso: string,
): Promise<SetUserAgeResult> {
  const dob = new Date(dateOfBirthIso);
  if (isNaN(dob.getTime())) {
    return { ok: false, error: "invalid_date" };
  }

  const minAge = await getConfigInt(supabase, "min_age_years", 18);
  const ageYears = (Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000);
  if (ageYears < minAge) {
    return { ok: false, error: "underage" };
  }

  const { error } = await supabase.from("users").update({
    date_of_birth: dateOfBirthIso,
    age_verified_at: new Date().toISOString(),
    age_verification_method: "self_declared",
    updated_at: new Date().toISOString(),
  }).eq("id", userId);

  if (error) return { ok: false, error: "db_error", message: error.message };
  return { ok: true };
}
