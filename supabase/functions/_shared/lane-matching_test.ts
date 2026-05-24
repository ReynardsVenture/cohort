import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyUser, pickLane } from "./lane-matching.ts";

Deno.test("straight woman seeking men", () => {
  const c = classifyUser({ user_id: "1", gender: "woman", seeking: ["man"] });
  assertEquals(c?.eligible.includes("straight"), true);
});

Deno.test("pickLane returns eligible lane", () => {
  const lane = pickLane({ user_id: "1", gender: "man", seeking: ["woman"] });
  assertEquals(lane, "straight");
});
