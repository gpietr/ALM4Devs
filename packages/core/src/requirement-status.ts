/**
 * The one place the fixed part of the status model lives. Requirement statuses
 * themselves are per-tenant, customizable rows (packages/db schema.ts: requirement_statuses
 * - rename freely, add more within a category, disable a whole category). What's fixed
 * here is the small set of *categories* the workflow engine needs to know the behavior
 * of - a custom status always belongs to exactly one of these.
 */
export const REQUIREMENT_STATUS_CATEGORIES = [
  "draft",
  "in_review",
  "approved",
  "baselined",
] as const;

export type RequirementStatusCategory = (typeof REQUIREMENT_STATUS_CATEGORIES)[number];

/** Seeded for every new tenant. A tenant is free to rename these or disable in_review /
 * baselined afterwards - see requirement_statuses.isEnabled. */
export const DEFAULT_REQUIREMENT_STATUSES: ReadonlyArray<{
  category: RequirementStatusCategory;
  name: string;
  sortOrder: number;
}> = [
  { category: "draft", name: "Draft", sortOrder: 0 },
  { category: "in_review", name: "In Review", sortOrder: 1 },
  { category: "approved", name: "Approved", sortOrder: 2 },
  { category: "baselined", name: "Baselined", sortOrder: 3 },
];

/** 'draft' and 'approved' anchor the minimum meaningful workflow (not-yet-approved vs.
 * approved) and can't be disabled. Not enforced anywhere yet since there's no settings UI
 * to disable a category through - exported so that future admin-settings code (letting a
 * tenant customize their status set) has a ready-made rule to call rather than
 * reinventing it. */
export function assertCategoryCanBeDisabled(category: RequirementStatusCategory): void {
  if (category === "draft" || category === "approved") {
    throw new Error(`the '${category}' status category cannot be disabled`);
  }
}

const CATEGORY_GRAPH: Record<RequirementStatusCategory, RequirementStatusCategory[]> = {
  draft: ["in_review", "approved"],
  in_review: ["approved", "draft"],
  approved: ["baselined", "draft"],
  baselined: [],
};

/**
 * Categories eligible for the approval gate at all - whether it's actually *enforced*
 * (e-signature, independent review) is a per-tenant setting (see tenant-settings.ts),
 * both defaulting to off. This only says which categories the gate could ever apply to.
 */
export function categoryCanGateApproval(toCategory: RequirementStatusCategory): boolean {
  return toCategory === "approved" || toCategory === "baselined";
}

/** A version whose current status is in this category is frozen: no further edits or
 * direct transitions, only creating a new requirement version. */
export function isFrozen(category: RequirementStatusCategory): boolean {
  return category === "baselined";
}

/**
 * Reachable next categories from `from`, given which categories this tenant actually has
 * an enabled status for. A disabled category (e.g. a tenant that turned off "Baselined")
 * is transparently skipped by following its own outgoing edges instead - so disabling
 * in_review collapses draft's options straight to `[approved]` rather than dead-ending.
 */
export function nextAllowedCategories(
  from: RequirementStatusCategory,
  enabledCategories: ReadonlySet<RequirementStatusCategory>,
): RequirementStatusCategory[] {
  const seen = new Set<RequirementStatusCategory>([from]);
  const result: RequirementStatusCategory[] = [];
  const stack = [...CATEGORY_GRAPH[from]];
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (enabledCategories.has(candidate)) {
      result.push(candidate);
    } else {
      stack.push(...CATEGORY_GRAPH[candidate]);
    }
  }
  return result;
}
