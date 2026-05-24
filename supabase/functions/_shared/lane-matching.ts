// Ported logic from prior product — lane classification for round formation

export type LaneType = "straight" | "lesbian" | "gay_male";
export type Gender = string;

const MEN = new Set(["man", "trans_man"]);
const WOMEN = new Set(["woman", "trans_woman"]);

export interface ProfileLane {
  user_id: string;
  gender: Gender | null;
  seeking: string[] | null;
  last_lane_type?: LaneType | null;
}

export function birthLane(gender: Gender | null): "man" | "woman" | null {
  if (!gender) return null;
  if (MEN.has(gender)) return "man";
  if (WOMEN.has(gender)) return "woman";
  return null;
}

export function classifyUser(p: ProfileLane): { effective: "man" | "woman"; eligible: LaneType[]; isJoker: boolean } | null {
  const seeking = Array.isArray(p.seeking) ? p.seeking : [];
  if (seeking.length === 0 || !p.gender) return null;

  const seeksMen = seeking.some((g) => MEN.has(g));
  const seeksWomen = seeking.some((g) => WOMEN.has(g));
  if (!seeksMen && !seeksWomen) return null;

  let effective = birthLane(p.gender);
  if (effective === null) {
    if (seeksMen && !seeksWomen) effective = "woman";
    else if (seeksWomen && !seeksMen) effective = "man";
    else effective = "woman";
  }

  const eligible: LaneType[] = [];
  if (effective === "man") {
    if (seeksWomen) eligible.push("straight");
    if (seeksMen) eligible.push("gay_male");
  } else {
    if (seeksMen) eligible.push("straight");
    if (seeksWomen) eligible.push("lesbian");
  }
  if (eligible.length === 0) return null;
  return { effective, eligible, isJoker: eligible.length > 1 };
}

export function pickLane(p: ProfileLane): LaneType | null {
  const c = classifyUser(p);
  if (!c) return null;
  if (!c.isJoker) return c.eligible[0];
  const last = p.last_lane_type;
  if (last && c.eligible.includes(last)) {
    const other = c.eligible.find((l) => l !== last);
    return other ?? last;
  }
  return c.eligible[0];
}

export function matchKey(region: string, intent: string, lane: LaneType, weekStart: string): string {
  return `${region}:${intent}:${lane}:${weekStart}`;
}
