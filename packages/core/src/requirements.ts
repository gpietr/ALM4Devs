import { type TenantTx, schema } from "@galm/db";
import { and, eq } from "drizzle-orm";
import { writeAuditLog } from "./audit";
import { type CustomFieldValueInput, setCustomFieldValues } from "./custom-fields";
import { DomainError } from "./errors";
import {
  type ExternalSource,
  findEntityIdBySource,
  type ImportUpsertAction,
  recordExternalLink,
} from "./external-links";
import { formatItemId } from "./item-id";
import { decrementSequenceCounterIfTip, nextSequenceNumber } from "./level-sequences";
import { getLevel } from "./requirement-levels";
import {
  categoryCanGateApproval,
  DEFAULT_REQUIREMENT_STATUSES,
  isFrozen,
  nextAllowedCategories,
  type RequirementStatusCategory,
} from "./requirement-status";
import { sanitizeRichText } from "./rich-text";
import { getTenantSettings } from "./tenant-settings";
import { getCoveringTestCases } from "./test-cases";

export type SafetyClassification = "A" | "B" | "C";

/** Called once, right after a tenant is created (see apps/web/src/app/api/register). */
export async function seedDefaultStatuses(db: TenantTx, tenantId: string) {
  return db
    .insert(schema.requirementStatuses)
    .values(DEFAULT_REQUIREMENT_STATUSES.map((s) => ({ tenantId, ...s })))
    .returning();
}

export async function listEnabledStatuses(db: TenantTx, tenantId: string) {
  return db
    .select()
    .from(schema.requirementStatuses)
    .where(
      and(
        eq(schema.requirementStatuses.tenantId, tenantId),
        eq(schema.requirementStatuses.isEnabled, true),
      ),
    )
    .orderBy(schema.requirementStatuses.sortOrder);
}

async function getStatusById(db: TenantTx, tenantId: string, statusId: string) {
  const [status] = await db
    .select()
    .from(schema.requirementStatuses)
    .where(
      and(
        eq(schema.requirementStatuses.id, statusId),
        eq(schema.requirementStatuses.tenantId, tenantId),
      ),
    );
  if (!status) throw new DomainError(`status ${statusId} not found`);
  return status;
}

async function defaultStatusForCategory(
  db: TenantTx,
  tenantId: string,
  category: RequirementStatusCategory,
) {
  const [status] = await db
    .select()
    .from(schema.requirementStatuses)
    .where(
      and(
        eq(schema.requirementStatuses.tenantId, tenantId),
        eq(schema.requirementStatuses.category, category),
        eq(schema.requirementStatuses.isEnabled, true),
      ),
    )
    .orderBy(schema.requirementStatuses.sortOrder)
    .limit(1);
  if (!status) {
    throw new DomainError(`no enabled status configured for category '${category}'`);
  }
  return status;
}

export async function loadRequirementWithCurrentVersion(db: TenantTx, tenantId: string, requirementId: string) {
  const [requirement] = await db
    .select()
    .from(schema.requirements)
    .where(and(eq(schema.requirements.id, requirementId), eq(schema.requirements.tenantId, tenantId)));
  if (!requirement || !requirement.currentVersionId) {
    throw new DomainError("requirement not found");
  }
  const [currentVersion] = await db
    .select()
    .from(schema.requirementVersions)
    .where(eq(schema.requirementVersions.id, requirement.currentVersionId));
  if (!currentVersion) {
    throw new DomainError("current version not found");
  }
  return { requirement, currentVersion };
}

export async function createRequirement(
  db: TenantTx,
  params: {
    tenantId: string;
    productId: string;
    levelId: string;
    safetyClassification?: SafetyClassification | null;
    parentRequirementId?: string | null;
    title: string;
    description: string;
    background?: string | null;
    createdBy: string;
    /** Values for whatever custom fields this tenant has defined for requirements (see
     * packages/core/src/custom-fields.ts) - validated (including required-ness) and
     * written in the same transaction as the requirement itself, so a required custom
     * field left unset fails the whole create rather than silently leaving the
     * requirement without one. Safe to omit (equivalent to `[]`) when the tenant has no
     * requirement custom fields defined yet - setCustomFieldValues is then a no-op - but
     * NOT a way to skip a defined required field; every caller that can reach a tenant
     * with custom fields defined must actually collect and pass them. */
    customFieldValues?: CustomFieldValueInput[];
  },
) {
  const draftStatus = await defaultStatusForCategory(db, params.tenantId, "draft");
  const level = await getLevel(db, params.tenantId, params.levelId);

  if (params.parentRequirementId) {
    const [parent] = await db
      .select({ productId: schema.requirements.productId, levelId: schema.requirements.levelId })
      .from(schema.requirements)
      .where(
        and(eq(schema.requirements.id, params.parentRequirementId), eq(schema.requirements.tenantId, params.tenantId)),
      );
    if (!parent) throw new DomainError("parent requirement not found");
    if (parent.productId !== params.productId) {
      throw new DomainError("parent requirement must belong to the same product");
    }
    const parentLevel = await getLevel(db, params.tenantId, parent.levelId);
    if (parentLevel.sortOrder >= level.sortOrder) {
      throw new DomainError(
        `parent must be at a higher level in the hierarchy (parent is '${parentLevel.name}', this is '${level.name}')`,
      );
    }
  }

  const sequenceNumber = await nextSequenceNumber(db, params.tenantId, params.productId, params.levelId);

  const [requirement] = await db
    .insert(schema.requirements)
    .values({
      tenantId: params.tenantId,
      productId: params.productId,
      levelId: params.levelId,
      sequenceNumber,
      safetyClassification: params.safetyClassification ?? null,
      parentRequirementId: params.parentRequirementId ?? null,
      createdBy: params.createdBy,
    })
    .returning();
  if (!requirement) throw new DomainError("failed to create requirement");

  await setCustomFieldValues(db, params.tenantId, "requirement", requirement.id, params.customFieldValues ?? []);

  const [version] = await db
    .insert(schema.requirementVersions)
    .values({
      tenantId: params.tenantId,
      requirementId: requirement.id,
      versionNumber: 1,
      title: params.title,
      description: params.description,
      background: params.background ? sanitizeRichText(params.background) : null,
      statusId: draftStatus.id,
      createdBy: params.createdBy,
    })
    .returning();
  if (!version) throw new DomainError("failed to create initial version");

  await db
    .update(schema.requirements)
    .set({ currentVersionId: version.id })
    .where(eq(schema.requirements.id, requirement.id));

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.createdBy,
    action: "requirement.created",
    entityType: "requirement",
    entityId: requirement.id,
    // displayId is stamped in, not just level/sequenceNumber separately, so this
    // hash-chained record is self-describing even after a later Settings rename of the
    // level's code (see levels.code's schema comment) changes what the same item displays
    // as today - the audit trail should still say what id was actually shown/exported/
    // signed at creation time, not silently start reading as if a different id always
    // applied.
    payload: { level: level.name, title: params.title, displayId: formatItemId(level.code, requirement.sequenceNumber) },
  });

  return { requirement: { ...requirement, currentVersionId: version.id }, version, status: draftStatus };
}

/** Only allowed while the current version's status category is 'draft' - edits after
 * that go through transitionRequirement's rework path (back to draft) instead of
 * silently mutating an in-review/approved version's content in place. */
export async function editDraftVersion(
  db: TenantTx,
  params: {
    tenantId: string;
    requirementId: string;
    title: string;
    description: string;
    background?: string | null;
    editedBy: string;
  },
) {
  const { requirement, currentVersion } = await loadRequirementWithCurrentVersion(
    db,
    params.tenantId,
    params.requirementId,
  );
  const currentStatus = await getStatusById(db, params.tenantId, currentVersion.statusId);
  if (currentStatus.category !== "draft") {
    throw new DomainError("can only edit a requirement while its status is in the draft category");
  }

  const [newVersion] = await db
    .insert(schema.requirementVersions)
    .values({
      tenantId: params.tenantId,
      requirementId: requirement.id,
      versionNumber: currentVersion.versionNumber + 1,
      title: params.title,
      description: params.description,
      background: params.background ? sanitizeRichText(params.background) : null,
      statusId: currentVersion.statusId,
      createdBy: params.editedBy,
    })
    .returning();
  if (!newVersion) throw new DomainError("failed to create new version");

  await db
    .update(schema.requirements)
    .set({ currentVersionId: newVersion.id })
    .where(eq(schema.requirements.id, requirement.id));

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.editedBy,
    action: "requirement.version_edited",
    entityType: "requirement_version",
    entityId: newVersion.id,
    payload: { versionNumber: newVersion.versionNumber },
  });

  return newVersion;
}

/**
 * Idempotent create-or-update for an importer (e.g. Spira, `packages/integrations/spira`):
 * looks up whether `externalId` was already imported (via `external_links`), and if so,
 * updates that requirement's content instead of creating a duplicate. Three things this
 * deliberately respects rather than overrides:
 * - **No-op if nothing changed** ("unchanged") - a re-import of identical source content
 *   doesn't create a pointless new version every time. "Nothing changed" means title,
 *   description, background, *and* every mapped custom field value - a re-import that
 *   only changed a custom field (the common case right after mapping one for the first
 *   time against rows already imported before) reports "updated", not "unchanged", even
 *   though it never touches the version history.
 * - **Draft-only editing** ("skipped") - exactly the same rule manual edits follow
 *   (`editDraftVersion`): a requirement that has moved past Draft isn't silently rewritten
 *   by a re-import just because the source changed. The row is left alone and the caller
 *   is told why, rather than the import failing outright or bypassing the workflow.
 * - **Safety classification is only set on first import** - the app has no metadata-only
 *   update path for it outside creation yet (a real gap, not a deliberate cut), so
 *   re-imports never touch it.
 */
export async function createOrUpdateRequirementFromImport(
  db: TenantTx,
  params: {
    tenantId: string;
    productId: string;
    levelId: string;
    safetyClassification?: SafetyClassification | null;
    title: string;
    description: string;
    background?: string | null;
    createdBy: string;
    source: ExternalSource;
    externalId: string;
    customFieldValues?: CustomFieldValueInput[];
  },
): Promise<{ action: ImportUpsertAction; requirementId: string; note?: string; sequenceNumber?: number }> {
  const existingId = await findEntityIdBySource(db, {
    tenantId: params.tenantId,
    entityType: "requirement",
    source: params.source,
    externalId: params.externalId,
  });

  if (!existingId) {
    const { requirement } = await createRequirement(db, params);
    await recordExternalLink(db, {
      tenantId: params.tenantId,
      entityType: "requirement",
      entityId: requirement.id,
      source: params.source,
      externalId: params.externalId,
    });
    // sequenceNumber is only returned here (not on the update/unchanged branches below) -
    // it's what let's a caller doing a legacy-id-preserving import (see
    // runSpiraImport in packages/integrations/spira) notice when its requested number
    // didn't actually land, e.g. two source rows claiming the same legacy id.
    return { action: "created", requirementId: requirement.id, sequenceNumber: requirement.sequenceNumber };
  }

  // Custom field values aren't versioned or gated by status (see custom-fields.ts), so a
  // re-import always reconciles them - unlike title/description/background below, there's
  // no "moved past Draft, leave it alone" concern for them, and no cost to calling this
  // even when nothing actually changed (it's a no-op reconciliation either way). Its
  // result still has to feed into the action below, though - a re-import that only
  // changed a custom field (the common case when a field is mapped for the first time
  // against rows already imported before) is a real update, not "unchanged", even though
  // it never touches title/description/background and so never creates a new version.
  const customFieldsResult = await setCustomFieldValues(
    db,
    params.tenantId,
    "requirement",
    existingId,
    params.customFieldValues ?? [],
  );

  const { currentVersion } = await loadRequirementWithCurrentVersion(db, params.tenantId, existingId);
  const normalizedBackground = params.background ? sanitizeRichText(params.background) : null;
  const contentUnchanged =
    currentVersion.title === params.title &&
    currentVersion.description === params.description &&
    (currentVersion.background ?? null) === normalizedBackground;
  if (contentUnchanged) {
    return { action: customFieldsResult.changed ? "updated" : "unchanged", requirementId: existingId };
  }

  try {
    await editDraftVersion(db, {
      tenantId: params.tenantId,
      requirementId: existingId,
      title: params.title,
      description: params.description,
      background: params.background,
      editedBy: params.createdBy,
    });
    return { action: "updated", requirementId: existingId };
  } catch (err) {
    if (err instanceof DomainError) {
      return { action: "skipped", requirementId: existingId, note: err.message };
    }
    throw err;
  }
}

export interface TransitionInput {
  tenantId: string;
  requirementId: string;
  toCategory: RequirementStatusCategory;
  actorUserId: string;
  /** Required exactly when the tenant's settings require e-signature for this category
   * (see evaluateApprovalGate) - the caller (tRPC router) is responsible for having
   * verified the re-auth token before calling. */
  approval?: { typedName: string; reauthAt: Date };
}

export interface ApprovalGate {
  requiresEsignature: boolean;
  requiresIndependentReview: boolean;
}

/** Both requirements default to off at the tenant level (see tenant-settings.ts) and only
 * ever apply to categories categoryCanGateApproval says are eligible at all. */
export async function evaluateApprovalGate(
  db: TenantTx,
  tenantId: string,
  toCategory: RequirementStatusCategory,
): Promise<ApprovalGate> {
  if (!categoryCanGateApproval(toCategory)) {
    return { requiresEsignature: false, requiresIndependentReview: false };
  }
  const settings = await getTenantSettings(db, tenantId);
  return {
    requiresEsignature: settings.requireEsignature,
    requiresIndependentReview: settings.requireIndependentReview,
  };
}

export async function transitionRequirement(db: TenantTx, input: TransitionInput) {
  const { currentVersion } = await loadRequirementWithCurrentVersion(db, input.tenantId, input.requirementId);
  const fromStatus = await getStatusById(db, input.tenantId, currentVersion.statusId);

  if (isFrozen(fromStatus.category as RequirementStatusCategory)) {
    throw new DomainError("this version is baselined and frozen; create a new requirement to continue");
  }

  const enabled = new Set(
    (await listEnabledStatuses(db, input.tenantId)).map((s) => s.category as RequirementStatusCategory),
  );
  const allowedNext = nextAllowedCategories(fromStatus.category as RequirementStatusCategory, enabled);
  if (!allowedNext.includes(input.toCategory)) {
    throw new DomainError(
      `cannot transition from '${fromStatus.category}' to '${input.toCategory}' (allowed: ${
        allowedNext.join(", ") || "none"
      })`,
    );
  }

  const toStatus = await defaultStatusForCategory(db, input.tenantId, input.toCategory);
  const gate = await evaluateApprovalGate(db, input.tenantId, input.toCategory);

  if (gate.requiresIndependentReview && currentVersion.createdBy === input.actorUserId) {
    throw new DomainError(
      "independent review is required: you cannot approve a requirement version you authored yourself",
    );
  }

  if (gate.requiresEsignature) {
    if (!input.approval) {
      throw new DomainError(
        `transitioning to '${input.toCategory}' requires e-signature (typed name + re-authentication)`,
      );
    }
    await db.insert(schema.approvalEvents).values({
      tenantId: input.tenantId,
      entityType: "requirement_version",
      entityId: currentVersion.id,
      fromStatusId: fromStatus.id,
      toStatusId: toStatus.id,
      actorUserId: input.actorUserId,
      typedName: input.approval.typedName,
      reauthAt: input.approval.reauthAt,
    });
  }

  await db
    .update(schema.requirementVersions)
    .set({ statusId: toStatus.id })
    .where(eq(schema.requirementVersions.id, currentVersion.id));

  // Independent of approval_events (PRODUCT.md: "Audit Log ... independent of Approval
  // events") - every transition is logged here, not just the ones requiring e-signature.
  await writeAuditLog(db, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    action: "requirement.status_changed",
    entityType: "requirement_version",
    entityId: currentVersion.id,
    payload: { fromStatus: fromStatus.name, toStatus: toStatus.name },
  });

  return { fromStatus, toStatus };
}

/**
 * Hard delete (backlog item 9.27) - there's no "archived"/"obsolete" status category to
 * soft-delete into (see requirement-status.ts's fixed category list), so this genuinely
 * removes the row, guarded the same way every other "can I destroy this" decision in this
 * codebase already is (levels, custom field options, test environments - see
 * test-environments.ts's deleteEnvironment for the closest sibling):
 *
 * - **Only a Draft requirement can be deleted.** Once a requirement has been through
 *   review/approval, it represents reviewed content a QMS needs to account for - matches
 *   the Spira importer's existing refusal to touch a requirement that's moved past Draft
 *   (createOrUpdateRequirementFromImport), applied here to outright removal too. The
 *   approval history itself (`approval_events`) is untouched either way - its `entityId`
 *   isn't foreign-keyed to `requirements.id` (deliberately, like `audit_log`), so it
 *   stays resolvable as a historical record even after the requirement it was about is
 *   gone.
 * - **Refused while any test case still covers it** (direct or via a step link) - same
 *   "in use, remove the link first" rule as deleting a level or a custom field option.
 *   Otherwise a covering test case would silently lose its link with no chance to notice.
 *
 * `requirement_versions`, `test_case_requirement_links`, and `test_step_requirement_links`
 * all cascade away with the row (real FKs). `external_links` and `custom_field_values`
 * don't - both are deliberately polymorphic, not foreign-keyed to any one entity table -
 * so they're cleaned up explicitly here; skipping that would leave a dangling
 * `external_links` row that made a future re-import of the same Spira id crash looking up
 * an entity that no longer exists. `audit_log` is the one thing left alone on purpose:
 * its own `entityId` isn't foreign-keyed either, and the "requirement.deleted" entry this
 * writes (with the requirement's own display id and title captured, since neither is
 * looked-up-able after this) is exactly the immutable record PRODUCT.md's "Audit Log -
 * immutable record of every state change" describes.
 */
export async function deleteRequirement(db: TenantTx, tenantId: string, requirementId: string, actorUserId: string) {
  const { requirement, currentVersion } = await loadRequirementWithCurrentVersion(db, tenantId, requirementId);
  const status = await getStatusById(db, tenantId, currentVersion.statusId);
  if (status.category !== "draft") {
    throw new DomainError(
      `cannot delete a requirement that has moved past Draft (currently ${status.name}) - only a Draft requirement can be deleted`,
    );
  }

  const covering = await getCoveringTestCases(db, tenantId, requirementId);
  if (covering.length > 0) {
    throw new DomainError(
      `cannot delete a requirement that has ${covering.length} covering test case${covering.length === 1 ? "" : "s"} - remove the link${covering.length === 1 ? "" : "s"} first`,
    );
  }

  const level = await getLevel(db, tenantId, requirement.levelId);
  const displayId = formatItemId(level.code, requirement.sequenceNumber);

  await db
    .delete(schema.externalLinks)
    .where(
      and(
        eq(schema.externalLinks.tenantId, tenantId),
        eq(schema.externalLinks.entityType, "requirement"),
        eq(schema.externalLinks.entityId, requirementId),
      ),
    );
  await db.delete(schema.customFieldValues).where(eq(schema.customFieldValues.entityId, requirementId));

  await db.delete(schema.requirements).where(and(eq(schema.requirements.id, requirementId), eq(schema.requirements.tenantId, tenantId)));

  // Only ever reclaims the number if this requirement was still the highest one ever
  // handed out for this (product, level) at the moment of deletion - see
  // decrementSequenceCounterIfTip's docstring (level-sequences.ts) for why that's the
  // only case this can safely do without leaving room for two different things to ever
  // read as the same id. Anything else (deleting one in the middle) leaves the usual
  // permanent gap, same as before this existed.
  const reclaimed = await decrementSequenceCounterIfTip(db, tenantId, requirement.productId, requirement.levelId, requirement.sequenceNumber);

  await writeAuditLog(db, {
    tenantId,
    actorUserId,
    action: "requirement.deleted",
    entityType: "requirement",
    entityId: requirementId,
    payload: { displayId, title: currentVersion.title, numberReclaimed: reclaimed },
  });
}
