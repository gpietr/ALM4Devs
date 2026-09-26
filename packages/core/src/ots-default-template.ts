import { type TenantTx, schema } from "@galm/db";

/**
 * The default `ots_list` template, seeded per tenant; an ordinary editable template after
 * that. Sections follow the FDA OTS guidance's section III order and are wrapped in
 * {{#if}} so empty fields are left out. Only Handlebars built-ins are available. The
 * documentation level is an optional template parameter, not stored in the app.
 */
const OTS_DEFAULT_TEMPLATE_NAME = "OTS Software Documentation";

const FIELD = (label: string, path: string) =>
  `{{#if ${path}}}<div class="field"><div class="label">${label}</div><div class="text">{{${path}}}</div></div>{{/if}}`;

const OTS_DEFAULT_TEMPLATE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt; color: #111; line-height: 1.4; }
  h1 { font-size: 18pt; margin: 0 0 4px; }
  h2 { font-size: 13.5pt; margin: 22px 0 6px; border-bottom: 1px solid #999; padding-bottom: 2px; page-break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 14px 0 4px; page-break-after: avoid; }
  .meta { color: #555; font-size: 9.5pt; margin-bottom: 14px; }
  .component { page-break-before: always; }
  .field { margin: 4px 0 8px; page-break-inside: avoid; }
  .label { font-weight: bold; font-size: 9.5pt; color: #333; }
  .text { white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 12px; font-size: 9.5pt; }
  th, td { border: 1px solid #999; padding: 3px 5px; text-align: left; vertical-align: top; }
  th { background: #eee; }
  tr { page-break-inside: avoid; }
  .muted { color: #666; }
</style>
</head>
<body>
<h1>Off-The-Shelf (OTS) Software Documentation</h1>
<div class="meta">{{productName}} &middot; generated {{generatedAt}}</div>

{{#if params.documentationLevel}}
<h2>Documentation Level</h2>
<p>Documentation Level: <strong>{{params.documentationLevel}}</strong></p>
{{#if params.documentationLevelRationale}}<div class="text">{{params.documentationLevelRationale}}</div>{{/if}}
{{/if}}

<h2>OTS Software Summary</h2>
{{#if components}}
<table>
  <tr><th>ID</th><th>OTS software</th><th>Manufacturer</th><th>Category</th><th>Version</th><th>Patch / upgrade</th><th>Allowed versions</th><th>End of support</th></tr>
  {{#each components}}
  <tr>
    <td>{{displayId}}</td>
    <td>{{title}}</td>
    <td>{{supplier}}</td>
    <td>{{category}}</td>
    <td>{{#with currentVersion}}{{version}}{{#if releaseDate}} <span class="muted">({{releaseDate}})</span>{{/if}}{{/with}}</td>
    <td>{{#with currentVersion}}{{patchLevel}}{{#if upgradeDesignation}} / {{upgradeDesignation}}{{/if}}{{/with}}</td>
    <td>{{#each allowedVersions}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}</td>
    <td>{{endOfSupportDate}}</td>
  </tr>
  {{/each}}
</table>
{{else}}
<p>The product does not use OTS software.</p>
{{/if}}

{{#each components}}
<div class="component">
<h2>{{displayId}} {{title}}{{#if supplier}} <span class="muted">&mdash; {{supplier}}</span>{{/if}}</h2>

<h3>What is it?</h3>
<table>
  <tr><th>Title</th><td>{{title}}</td><th>Manufacturer</th><td>{{supplier}}</td></tr>
  {{#with currentVersion}}
  <tr><th>Version level</th><td>{{version}}</td><th>Release date</th><td>{{releaseDate}}</td></tr>
  <tr><th>Patch number</th><td>{{patchLevel}}</td><th>Upgrade designation</th><td>{{upgradeDesignation}}</td></tr>
  {{/with}}
  <tr><th>Category</th><td colspan="3">{{category}}</td></tr>
</table>
${FIELD("OTS documentation provided to the end user", "endUserDocumentation")}
${FIELD("Why this OTS software is appropriate for this product", "appropriatenessRationale")}
${FIELD("Expected design limitations", "designLimitations")}

{{#if hardwareRequirements}}<h3>Computer system specifications</h3>{{else}}{{#if softwareRequirements}}<h3>Computer system specifications</h3>{{else}}{{#if platforms}}<h3>Computer system specifications</h3>{{/if}}{{/if}}{{/if}}
${FIELD("Hardware specifications", "hardwareRequirements")}
{{#if platforms}}
<div class="label">Software platform (operating system, drivers, utilities)</div>
<table>
  <tr><th>ID</th><th>Name</th><th>Manufacturer</th><th>Version</th><th>Patches</th></tr>
  {{#each platforms}}<tr><td>{{displayId}}</td><td>{{title}}</td><td>{{supplier}}</td><td>{{version}}</td><td>{{patchLevel}}{{#if upgradeDesignation}} / {{upgradeDesignation}}{{/if}}</td></tr>{{/each}}
</table>
{{/if}}
${FIELD("Software specifications", "softwareRequirements")}
${FIELD("Hosting environment", "hostingEnvironment")}

<h3>Appropriate actions by the end user</h3>
${FIELD("What can / must be installed or configured, and how", "installationConfiguration")}
${FIELD("How often the configuration will need to be changed", "configurationChangeFrequency")}
${FIELD("Education and training for the user", "userTraining")}
${FIELD("Measures preventing operation of non-specified OTS software", "nonSpecifiedSoftwarePrevention")}

<h3>What does the OTS software do?</h3>
${FIELD("Intended function in this product", "intendedFunction")}
${FIELD("Involvement in error control and messaging", "errorControlInvolvement")}
${FIELD("Links with other software, including software outside the product", "externalInterfaces")}

<h3>How do you know it works?</h3>
{{#if testCases}}
<div class="label">Verification and validation test cases</div>
<table>
  <tr><th>ID</th><th>Test case</th></tr>
  {{#each testCases}}<tr><td>{{displayId}}</td><td>{{title}}</td></tr>{{/each}}
</table>
{{/if}}
{{#each versions}}{{#if assessment}}
<div class="field">
  <div class="label">Version {{version}} &mdash; testing and change-impact assessment{{#if assessment.assessedAt}} ({{assessment.assessedAt}}){{/if}}</div>
  {{#with assessment}}
  {{#if verificationSummary}}<div class="text"><em>Verification:</em> {{verificationSummary}}</div>{{/if}}
  {{#if regressionAnalysis}}<div class="text"><em>Regression analysis:</em> {{regressionAnalysis}}</div>{{/if}}
  <div class="text"><em>Regression testing performed:</em> {{#if regressionTestPerformed}}Yes{{else}}No{{/if}}{{#if testSetName}} (test set: {{testSetName}}){{/if}}</div>
  {{#if safetyImpact}}<div class="text"><em>Safety impact:</em> {{safetyImpact}}</div>{{/if}}
  {{#if designImpact}}<div class="text"><em>Design impact:</em> {{designImpact}}</div>{{/if}}
  {{#if installationImpact}}<div class="text"><em>Installation / field impact:</em> {{installationImpact}}</div>{{/if}}
  {{#if obsolescenceImpact}}<div class="text"><em>Obsolescence:</em> {{obsolescenceImpact}}</div>{{/if}}
  {{/with}}
</div>
{{/if}}{{/each}}
${FIELD("Known-issue list source", "anomalyListUrl")}
${FIELD("Access to updates", "updatesSourceUrl")}
<div class="field"><div class="label">Known issues</div>
{{#if anomaliesReviewedAt}}<div class="muted">List last reviewed {{anomaliesReviewedAt}}{{#if anomaliesReviewedBy}} by {{anomaliesReviewedBy}}{{/if}}.</div>{{/if}}
{{#if anomalies}}
<table>
  <tr><th>Issue</th><th>Affected versions</th><th>Impact on safety and effectiveness</th><th>Outcome and rationale</th><th>Mitigation / user communication</th></tr>
  {{#each anomalies}}
  <tr>
    <td>{{#if externalId}}{{externalId}}: {{/if}}{{title}}{{#if description}}<div class="text muted">{{description}}</div>{{/if}}</td>
    <td>{{#each affectedVersions}}{{this}}{{#unless @last}}, {{/unless}}{{else}}all{{/each}}{{#if resolvedInVersion}}<div class="muted">fixed in {{resolvedInVersion}}</div>{{/if}}</td>
    <td class="text">{{impactEvaluation}}</td>
    <td>{{outcome}}{{#if rationale}}<div class="text">{{rationale}}</div>{{/if}}</td>
    <td class="text">{{mitigation}}{{#if endUserCommunication}}
{{endUserCommunication}}{{/if}}</td>
  </tr>
  {{/each}}
</table>
{{else}}<div class="muted">No known issues recorded.</div>{{/if}}
</div>

<h3>How will you keep track of (control) the OTS software?</h3>
${FIELD("Measures preventing the introduction of incorrect versions", "versionControlMeasures")}
${FIELD("Maintaining the OTS software configuration", "configurationManagement")}
${FIELD("Where and how the OTS software is stored", "storageLocation")}
${FIELD("Ensuring proper installation", "installationVerification")}
${FIELD("Maintenance and life cycle support", "maintenancePlan")}

{{#if riskAssessment}}<h3>Risk assessment</h3>{{else}}{{#if requirements}}<h3>Risk assessment</h3>{{/if}}{{/if}}
${FIELD("Risks related to the use of this OTS software", "riskAssessment")}
{{#if requirements}}
<div class="label">Related requirements / risk control measures</div>
<table>
  <tr><th>ID</th><th>Requirement</th></tr>
  {{#each requirements}}<tr><td>{{displayId}}</td><td>{{title}}</td></tr>{{/each}}
</table>
{{/if}}

{{#if developmentAssurance}}<h3>Assurance of development methodologies and continued maintenance</h3>{{else}}{{#if supportMechanism}}<h3>Assurance of development methodologies and continued maintenance</h3>{{else}}{{#if masterFileNumber}}<h3>Assurance of development methodologies and continued maintenance</h3>{{/if}}{{/if}}{{/if}}
${FIELD("Assurance that the developer's methodologies are appropriate and sufficient", "developmentAssurance")}
${FIELD("Device master file (MAF)", "masterFileNumber")}
${FIELD("Mechanisms for continued performance, maintenance and support", "supportMechanism")}

{{#if endOfSupportDate}}<h3>Maintenance and obsolescence</h3>{{else}}{{#if retirementPlan}}<h3>Maintenance and obsolescence</h3>{{/if}}{{/if}}
{{#if endOfSupportDate}}<div class="field"><div class="label">End of vendor support</div><div class="text">{{endOfSupportDate}}</div></div>{{/if}}
${FIELD("Retirement / replacement plan", "retirementPlan")}
</div>
{{/each}}

{{#if releaseChanges}}
<h2 class="component">OTS Software Version History</h2>
<table>
  <tr><th>Release</th><th>Date</th><th>OTS changes relative to the previous release</th></tr>
  {{#each releaseChanges}}
  <tr>
    <td>{{versionNumber}}</td>
    <td>{{releaseDate}}</td>
    <td>
      {{#if hasChanges}}
      {{#each added}}<div>Added {{displayId}} {{title}} {{version}}</div>{{/each}}
      {{#each changed}}<div>Changed {{displayId}} {{title}}: {{from}} &rarr; {{to}}{{#each assessments}}{{#if regressionTestPerformed}} <span class="muted">(regression tested)</span>{{/if}}{{/each}}</div>{{/each}}
      {{#each removed}}<div>Removed {{displayId}} {{title}} {{version}}</div>{{/each}}
      {{else}}<span class="muted">No OTS changes</span>{{/if}}
    </td>
  </tr>
  {{/each}}
</table>
{{/if}}

{{#if unresolvedAnomaliesByRelease}}
<h2>Unresolved Known Issues</h2>
{{#each unresolvedAnomaliesByRelease}}
<h3>Release {{versionNumber}}{{#if releaseDate}} ({{releaseDate}}){{/if}}</h3>
{{#if anomalies}}
<table>
  <tr><th>Component</th><th>Issue</th><th>How discovered / root cause</th><th>Impact on safety and effectiveness</th><th>Outcome</th><th>Risk-based rationale</th><th>Classification</th><th>User communication</th></tr>
  {{#each anomalies}}
  <tr>
    <td>{{component.displayId}} {{component.title}} {{component.version}}</td>
    <td>{{#if externalId}}{{externalId}}: {{/if}}{{title}}</td>
    <td class="text">{{discoveryMethod}}{{#if rootCause}}
{{rootCause}}{{/if}}</td>
    <td class="text">{{impactEvaluation}}</td>
    <td>{{outcome}}</td>
    <td class="text">{{rationale}}</td>
    <td>{{defectClassification}}</td>
    <td class="text">{{endUserCommunication}}</td>
  </tr>
  {{/each}}
</table>
{{else}}<p class="muted">No known issues affect the OTS versions shipped in this release.</p>{{/if}}
{{/each}}
{{/if}}
</body>
</html>
`;

const OTS_DEFAULT_TEMPLATE_FILENAME = "{{productName}} - OTS Software Documentation";

/** Idempotent: inserts the template (and its two optional parameters) only if this tenant
 * has none by that name, so a tenant's edits are never overwritten. */
export async function seedDefaultDocumentTemplates(db: TenantTx, tenantId: string) {
  const [template] = await db
    .insert(schema.documentTemplates)
    .values({
      tenantId,
      scope: "ots_list",
      name: OTS_DEFAULT_TEMPLATE_NAME,
      htmlTemplate: OTS_DEFAULT_TEMPLATE_HTML,
      filenameTemplate: OTS_DEFAULT_TEMPLATE_FILENAME,
    })
    .onConflictDoNothing()
    .returning({ id: schema.documentTemplates.id });
  if (!template) return;
  await db.insert(schema.documentTemplateParameters).values([
    {
      tenantId,
      templateId: template.id,
      key: "documentationLevel",
      label: "Documentation Level (Basic / Enhanced)",
      type: "text",
      isRequired: false,
      sortOrder: 0,
    },
    {
      tenantId,
      templateId: template.id,
      key: "documentationLevelRationale",
      label: "Documentation Level rationale",
      type: "text",
      isRequired: false,
      sortOrder: 1,
    },
  ]);
}
