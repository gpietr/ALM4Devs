/**
 * Spira REST API client. Spira (Inflectra) has shipped several REST API versions across
 * Cloud and on-premise installs (v3_0 through v7_0+), and the exact base path differs
 * between Cloud (`.../Spira/Services/{version}/RestService.svc`) and self-hosted installs
 * (often without the `/Spira/` segment). Rather than guess and hardcode a path, the whole
 * base URL up to and including `RestService.svc` is user-supplied - copy it from your own
 * Spira instance's REST API documentation/help page. This is the piece most likely to need
 * adjusting once actually tested against a real instance, which is expected.
 */

import { countPagedRows } from "./pagination";

export interface SpiraConnectionConfig {
  baseUrl: string;
  username: string;
  apiKey: string;
  projectId: number;
}

export class SpiraApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
  }
}

function buildUrl(config: SpiraConnectionConfig, path: string, extraParams?: Record<string, string | number>): URL {
  const url = new URL(`${config.baseUrl.replace(/\/$/, "")}${path}`);
  url.searchParams.set("username", config.username);
  url.searchParams.set("api-key", config.apiKey);
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) url.searchParams.set(key, String(value));
  }
  return url;
}

async function spiraFetch<T>(
  config: SpiraConnectionConfig,
  path: string,
  extraParams?: Record<string, string | number>,
): Promise<T> {
  const url = buildUrl(config, path, extraParams);
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new SpiraApiError(
      `could not reach Spira at ${config.baseUrl} - check the base URL: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => undefined);
    throw new SpiraApiError(`Spira API request to ${path} failed: ${res.status} ${res.statusText}`, res.status, body);
  }
  return res.json() as Promise<T>;
}

/** Shape shared by every Spira artifact type this client reads (Requirement, TestCase,
 * TestStep): an id field varying by type, plus a CustomProperties array read by
 * PropertyNumber. `readSpiraField` and the field-discovery helpers below work against
 * this common shape rather than one per artifact type.
 *
 * A custom property's actual value comes back under one of *several* type-specific keys
 * depending on that property's own type in Spira - `StringValue` for a Text custom
 * field, but `IntegerValue` for a Number one, `BooleanValue` for a Yes/No one,
 * `DateTimeValue` for a Date one, `DecimalValue` for a Decimal one - never more than one
 * populated at once. Declaring only `StringValue` here (an earlier version of this type
 * did exactly that) meant `readSpiraField` silently read `null` for every custom field
 * that wasn't plain text: a real bug, only caught once a user actually mapped a non-text
 * Spira custom field and got "nothing updated" with no error at all. `IntegerListValue`
 * (a Spira "List" custom property's selected item, stored as that list item's own
 * numeric id) is deliberately NOT read here: resolving it to human-readable text needs a
 * separate Spira API call this client doesn't make (the id alone isn't something our
 * own list-type custom fields could sensibly match against) - a List-type Spira custom
 * field can't be mapped usefully yet. */
export interface SpiraArtifact {
  CustomProperties?: Array<{
    PropertyNumber: number;
    Name?: string;
    StringValue?: string | null;
    IntegerValue?: number | null;
    BooleanValue?: boolean | null;
    DateTimeValue?: string | null;
    DecimalValue?: number | null;
  }>;
  [key: string]: unknown;
}

export interface SpiraRequirement extends SpiraArtifact {
  RequirementId: number;
  Name: string;
  Description?: string | null;
  RequirementTypeName?: string;
  ImportanceName?: string;
  StatusName?: string;
}

export interface SpiraTestCase extends SpiraArtifact {
  TestCaseId: number;
  Name: string;
  Description?: string | null;
  TestCaseTypeName?: string;
  TestCaseStatusName?: string;
}

export interface SpiraTestStep extends SpiraArtifact {
  TestStepId: number;
  Position: number;
  Description?: string | null;
  ExpectedResult?: string | null;
}

export interface SpiraFieldDefinition {
  /** Standard fields use the Spira property name directly (e.g. "Name"); custom fields
   * use "custom_<PropertyNumber>", read back out of CustomProperties at import time. */
  key: string;
  label: string;
  isCustom: boolean;
}

export interface SpiraFieldDiscoveryResult {
  fields: SpiraFieldDefinition[];
  /** Set (never thrown) if custom-property discovery failed - standard fields are still
   * usable, but this is surfaced to the caller rather than silently swallowed, which is
   * exactly what hid a real bug here before: the endpoint this used to guess was wrong,
   * and nothing told the user why their custom fields weren't showing up. */
  customFieldsWarning?: string;
}

const STANDARD_REQUIREMENT_FIELDS: SpiraFieldDefinition[] = [
  { key: "Name", label: "Name", isCustom: false },
  { key: "Description", label: "Description", isCustom: false },
  { key: "RequirementTypeName", label: "Requirement Type", isCustom: false },
  { key: "ImportanceName", label: "Importance", isCustom: false },
  { key: "StatusName", label: "Status", isCustom: false },
  // Spira's own built-in numeric id - always present, no custom field setup needed. The
  // obvious, no-configuration choice for the "Legacy ID" mapping (see import.ts's
  // RequirementFieldMapping.legacyId) when a team just wants their existing Spira
  // requirement numbers preserved, as opposed to some separate custom field they
  // maintained themselves.
  { key: "RequirementId", label: "Requirement ID (Spira's own)", isCustom: false },
];

/** Our test case model has no case-level description field (only steps carry rich text),
 * so Spira's own test case Description is deliberately left off this list (see
 * TestCaseFieldMapping's docstring). TestCaseTypeName and TestCaseStatusName are Spira
 * *standard* fields, not custom ones, but are included here anyway for the same reason
 * Requirement's RequirementTypeName/ImportanceName/StatusName are in
 * STANDARD_REQUIREMENT_FIELDS above: our own "Test Type" (a seeded custom field - see
 * packages/core/src/custom-fields.ts - with just Verification/Validation as its default
 * options) doesn't line up 1:1 with Spira's own test case type taxonomy (see
 * MappedTestCase's `spiraTestCaseType`, shown in the preview but never written
 * automatically for exactly that reason), so a team maps whichever of Spira's Type/Status
 * they actually want onto a custom field of their own - "Test Type" included - via the
 * generic custom-field mapping, same as requirement type/importance/status. Originally
 * missing here - a real gap a user found after already relying on the equivalent
 * requirement-level mapping. */
const STANDARD_TEST_CASE_FIELDS: SpiraFieldDefinition[] = [
  { key: "Name", label: "Name", isCustom: false },
  { key: "TestCaseTypeName", label: "Test Case Type", isCustom: false },
  { key: "TestCaseStatusName", label: "Test Case Status", isCustom: false },
  { key: "TestCaseId", label: "Test Case ID (Spira's own)", isCustom: false },
];

/** Description and Expected Result are always read directly off every Spira test step
 * (they're the two fields the wizard is fundamentally importing) rather than offered as
 * mapping choices - only the optional "purpose" mapping is user-chosen, from whichever
 * TestStep field (standard or custom) the operator picks. This list exists to populate
 * that one dropdown. */
const STANDARD_TEST_STEP_FIELDS: SpiraFieldDefinition[] = [
  { key: "Description", label: "Description", isCustom: false },
  { key: "ExpectedResult", label: "Expected Result", isCustom: false },
];

export class SpiraClient {
  constructor(private readonly config: SpiraConnectionConfig) {}

  /** Verifies the connection and credentials by fetching the project's own details. */
  async testConnection(): Promise<{ projectName: string }> {
    const project = await spiraFetch<{ Name: string }>(this.config, `/projects/${this.config.projectId}`);
    return { projectName: project.Name };
  }

  /**
   * Standard fields for `artifactTypeName` plus whatever custom properties this Spira
   * project's *template* has configured for that artifact type - custom properties are
   * defined per project template in Spira, not per project directly, so this first looks
   * up the project's ProjectTemplateId, then lists that template's custom properties for
   * the given type (confirmed against Inflectra's own REST API documentation and directly
   * against a real Spira instance: `GET /project-templates/{project_template_id}/
   * custom-properties/{artifact_type_name}`, with `artifact_type_name` one of
   * "Requirement", "TestCase", "TestStep"). Falls back to standard fields alone if either
   * call fails, rather than blocking the whole import wizard - but the failure is returned
   * (`customFieldsWarning`), not swallowed, so it's visible instead of just quietly
   * missing fields (see the "missing custom field background" bug this replaced).
   */
  private async discoverFields(
    artifactTypeName: string,
    standardFields: SpiraFieldDefinition[],
  ): Promise<SpiraFieldDiscoveryResult> {
    const fields = [...standardFields];
    try {
      const project = await spiraFetch<{ ProjectTemplateId: number }>(this.config, `/projects/${this.config.projectId}`);
      const customProperties = await spiraFetch<
        Array<{ PropertyNumber?: number; CustomPropertyId?: number; Name: string }>
      >(this.config, `/project-templates/${project.ProjectTemplateId}/custom-properties/${artifactTypeName}`);
      for (const prop of customProperties) {
        const propertyNumber = prop.PropertyNumber ?? prop.CustomPropertyId;
        if (propertyNumber == null) continue;
        fields.push({ key: `custom_${propertyNumber}`, label: `${prop.Name} (custom)`, isCustom: true });
      }
      return { fields };
    } catch (err) {
      const detail =
        err instanceof SpiraApiError
          ? `${err.message}${err.body ? ` — ${err.body}` : ""}`
          : err instanceof Error
            ? err.message
            : String(err);
      return { fields, customFieldsWarning: `Couldn't load custom fields: ${detail}` };
    }
  }

  async listRequirementFields(): Promise<SpiraFieldDiscoveryResult> {
    return this.discoverFields("Requirement", STANDARD_REQUIREMENT_FIELDS);
  }

  async listTestCaseFields(): Promise<SpiraFieldDiscoveryResult> {
    return this.discoverFields("TestCase", STANDARD_TEST_CASE_FIELDS);
  }

  /** Fields available for the one optional per-step mapping ("purpose") - a real Spira
   * project observed during development had a custom "Purpose" text field on TestStep,
   * which is exactly the concept our own step-level `purpose` field carries. */
  async listTestStepFields(): Promise<SpiraFieldDiscoveryResult> {
    return this.discoverFields("TestStep", STANDARD_TEST_STEP_FIELDS);
  }

  async listRequirements(params: { startRow?: number; numberOfRows?: number } = {}): Promise<SpiraRequirement[]> {
    return spiraFetch<SpiraRequirement[]>(this.config, `/projects/${this.config.projectId}/requirements`, {
      starting_row: params.startRow ?? 1,
      number_of_rows: params.numberOfRows ?? 25,
    });
  }

  async listTestCases(params: { startRow?: number; numberOfRows?: number } = {}): Promise<SpiraTestCase[]> {
    return spiraFetch<SpiraTestCase[]>(this.config, `/projects/${this.config.projectId}/test-cases`, {
      starting_row: params.startRow ?? 1,
      number_of_rows: params.numberOfRows ?? 25,
    });
  }

  /** One call per test case - Spira doesn't offer a bulk "all steps for all cases in a
   * project" endpoint, so importing test cases is inherently N+1 in requests to Spira
   * (not to our own database). Fine at the dataset sizes this product targets. */
  async listTestSteps(testCaseId: number): Promise<SpiraTestStep[]> {
    return spiraFetch<SpiraTestStep[]>(
      this.config,
      `/projects/${this.config.projectId}/test-cases/${testCaseId}/test-steps`,
    );
  }

  /** Spira's own requirement-coverage trace: which requirements a given test case is
   * linked to. Confirmed directly against a real Spira v7_0 instance (no public docs
   * consulted for this one - `/test-cases/{id}/requirements` was found by probing several
   * candidate paths against real data, see backlog item 9.26): returns an array of
   * `{ RequirementId, TestCaseId, RequirementGuid, TestCaseGuid }` rows, one per linked
   * requirement, `[]` when the test case has no linked requirements (not an error - a
   * genuinely uncovered test case is normal, not a failure). Same "one call per test
   * case" N+1 shape as listTestSteps, same reasoning for why that's fine here. */
  async listTestCaseRequirementLinks(testCaseId: number): Promise<number[]> {
    const links = await spiraFetch<Array<{ RequirementId: number }>>(
      this.config,
      `/projects/${this.config.projectId}/test-cases/${testCaseId}/requirements`,
    );
    return links.map((l) => l.RequirementId);
  }

  /** How many requirements/test cases this project actually has, capped at `maxRows` -
   * used to show an honest "x/n" progress denominator before a real import run starts
   * (backlog item 9.26). Paginated the same way the real import would page, so the count
   * always matches what a run capped at the same `maxRows` will actually process. */
  async countRequirements(maxRows: number): Promise<number> {
    return countPagedRows((p) => this.listRequirements(p), maxRows);
  }

  async countTestCases(maxRows: number): Promise<number> {
    return countPagedRows((p) => this.listTestCases(p), maxRows);
  }
}

/** Reads a mapped field's value off a raw Spira artifact (requirement, test case, or test
 * step - anything shaped like `SpiraArtifact`) - standard fields by direct property
 * access, custom fields by PropertyNumber lookup in CustomProperties.
 *
 * A custom property checks every typed value key Spira might have populated (see
 * `SpiraArtifact`'s docstring for why there are several, not just `StringValue`) and
 * returns whichever one actually isn't null - `!= null`, not truthiness, since a real
 * value can be `false` or `0`, both falsy but not "absent". `DateTimeValue` comes back
 * from Spira as a full ISO datetime ("2024-01-15T00:00:00.000"), not a bare date -
 * returned as-is here; packages/core's date validation is the layer that tolerates the
 * extra time component when the target field is our own 'date' type. */
export function readSpiraField(artifact: SpiraArtifact, fieldKey: string | undefined): string | null {
  if (!fieldKey) return null;
  if (fieldKey.startsWith("custom_")) {
    const propertyNumber = Number(fieldKey.slice("custom_".length));
    const prop = artifact.CustomProperties?.find((p) => p.PropertyNumber === propertyNumber);
    if (!prop) return null;
    if (prop.StringValue != null) return prop.StringValue;
    if (prop.IntegerValue != null) return String(prop.IntegerValue);
    if (prop.BooleanValue != null) return String(prop.BooleanValue);
    if (prop.DateTimeValue != null) return prop.DateTimeValue;
    if (prop.DecimalValue != null) return String(prop.DecimalValue);
    return null;
  }
  const value = artifact[fieldKey];
  return value == null ? null : String(value);
}
