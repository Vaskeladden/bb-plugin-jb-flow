// Lanes are sections with a role (number key, auto-fill for Waiting). Each is
// matched to a section by name once, then pinned by id, so renaming a lane's
// section keeps its role. A pinned section that's gone is matched again.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type LaneId = "priority" | "waiting" | "later" | "low";
export type LaneSections = Partial<Record<LaneId, string>>;

// Whole names only (a leading emoji is fine), so "Priority customers" or
// "Waiting on legal" stay ordinary sections.
export const LANE_PATTERNS: Record<LaneId, RegExp> = {
  priority: /^\W*priority\W*$/i,
  waiting: /^\W*waiting(?: for| on)?(?: others| someone)?\W*$/i,
  later: /^\W*pick up later\W*$/i,
  low: /^\W*low priority\W*$/i,
};

/** Section names "Create lanes" uses; each matches its pattern above. */
export const LANE_NAMES: Record<LaneId, string> = {
  priority: "Priority",
  waiting: "Waiting for others",
  later: "Pick up later",
  low: "Low priority",
};

/** Pins stay while their section exists; missing lanes match by name, skipping sections another lane holds. */
export function matchLanes(sections: readonly { id: string; name: string }[], pinned: LaneSections): LaneSections {
  const ids = new Set(sections.map((section) => section.id));
  const result: LaneSections = {};
  for (const lane of Object.keys(LANE_PATTERNS) as LaneId[]) {
    const id = pinned[lane];
    if (id && ids.has(id)) result[lane] = id;
  }
  const taken = new Set(Object.values(result));
  for (const lane of Object.keys(LANE_PATTERNS) as LaneId[]) {
    if (result[lane]) continue;
    const match = sections.find((section) => !taken.has(section.id) && LANE_PATTERNS[lane].test(section.name));
    if (match) {
      result[lane] = match.id;
      taken.add(match.id);
    }
  }
  return result;
}

/** A lane as the client lists it. */
export type Lane = {
  id: LaneId | "active";
  title: string;
  sectionId: string | null;
  key: string;
};

/** Lane titles copy section names; key memos on them so a rename shows at once. */
export const sectionNames = (sections: readonly { id: string; name: string }[]) => sections.map((section) => `${section.id}:${section.name}`).join("\n");

/**
 * Lanes on top of your sections. The server pins each lane to a section id
 * (matched by name the first time), so a renamed lane keeps its role and shows
 * the section's own name. Before state loads, name matching fills in.
 */
export function resolveLanes(sections: readonly { id: string; name: string }[], pinned: LaneSections = {}): Lane[] {
  const matched = matchLanes(sections, pinned);
  const lane = (id: LaneId, fallback: string, key: string): Lane => {
    const sectionId = matched[id] ?? null;
    const title = sections.find((section) => section.id === sectionId)?.name ?? fallback;
    return { id, title, sectionId, key };
  };
  const lanes: Lane[] = [
    lane("priority", "Priority", "1"),
    { id: "active", title: "Unassigned", sectionId: null, key: "2" },
    lane("waiting", "Waiting for others", "3"),
    lane("later", "Pick up later", "4"),
    lane("low", "Low priority", "5"),
  ];
  // A lane whose section is missing is dropped; Active is the unsectioned bucket.
  return lanes.filter(
    (lane) => lane.id === "active" || lane.sectionId !== null,
  );
}


export async function laneSections(bb: BbPluginApi): Promise<LaneSections> {
  const pinned = (await bb.storage.kv.get<LaneSections>("laneSections")) ?? {};
  const sections = await bb.sdk.threadSections.list().catch(() => null);
  if (sections === null) return pinned;
  const result = matchLanes(sections, pinned);
  if (JSON.stringify(result) !== JSON.stringify(pinned)) await bb.storage.kv.set("laneSections", result);
  return result;
}
