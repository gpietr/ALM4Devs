# Product Definition

## Positioning

An open-source-first requirements and test management tool for early-stage medical device
software teams (Software as a Medical Device / SaMD) — built by developers, for developers,
with a real IEC 62304-shaped traceability model underneath and a straight migration path out
of Spira instead of a rebuild.

**Value proposition:** the requirements and test management tool early medtech software
teams can actually afford and want to use — open source so you can start today without a
sales call.

## Why this, why now

- Spira (Inflectra) is the incumbent "affordable" ALM tool in this space, but user reviews
  consistently cite an outdated/cluttered UI, rigid folder structure, weak reporting, and
  integration friction.
- The modern alternative, Ketryx, has raised $55M+ and is explicitly moving upmarket
  (enterprise motion, customers among the top 5 global medtech companies), leaving very
  early-stage / bootstrapped teams underserved.
- Every credible competitor in this space (Ketryx, Matrix Requirements, Visure, Orcanos,
  Spira) sells through a custom quote / sales call. Nobody offers transparent, self-serve
  pricing the way developer tools like Linear or Qase do.
- Requirements management software is a ~$3.3–3.6B market growing ~9-10%/year, driven by
  regulated industries' need for live traceability — a real, healthy market, not a fad.

## Target customer

- **Company:** pre-seed to Series A medical device / digital health company building SaMD,
  typically 5–50 people, no dedicated large QA/RA department, often using an outside
  regulatory consultant.
- **Buyer:** Head of Engineering or a wearing-many-hats QA/RA lead — someone close to the
  code, not a pure compliance function.
- **User:** software engineers writing requirements and running verification tests
  themselves, not a separate test-authoring team.
- **Trigger:** approaching a first FDA 510(k)/De Novo submission or EU MDR technical file
  and realizing requirements/tests live in a mix of Jira tickets, Google Docs, and a
  hand-maintained traceability spreadsheet — or they inherited Spira and it isn't sticking.

## Scope philosophy

Lightweight layer, not a full eQMS replacement. Own the requirements + test +
traceability loop deeply; do not own company-wide quality management. Requirement and test
*approval* records still need to be defensible (they're part of the Design History File
auditors check under 21 CFR 820.30), so a basic approval/e-signature workflow is core MVP
scope — full 21 CFR Part 11 validation is not.

## MVP data model

- **Product / System** — the SaMD under development (top-level container).
- **Requirement** — typed as User Need, System Requirement, or Software Item Spec, mapped
  to IEC 62304's requirement hierarchy; carries a Software Safety Classification (A/B/C);
  versioned; states Draft → In Review → Approved → Baselined.
- **Test Case** — typed as Verification (traces to a Software Item Spec) or Validation
  (traces to a Requirement/User Need); Steps + Expected Result.
- **Test Execution** — a run of a Test Case against a specific baseline: result
  (Pass/Fail/Blocked), executed-by, timestamp, evidence attachment.
- **Approval / E-signature event** — attached to Requirement and Test Execution state
  changes: typed name, re-authentication, timestamp, immutable.
- **Traceability Matrix** — live, computed view of Requirement ↔ Test Case ↔ Test
  Execution ↔ Defect, exportable as a report for submission/audit use.
- **Defect/Anomaly** — linked to a failing Test Execution; root cause, resolution, re-test
  link.
- **Baseline / Release** — a frozen, exportable snapshot of the full req+test+result set for
  a given software version.
- **Audit Log** — immutable record of every state change, independent of Approval events.

## MVP feature set

1. Requirements authoring with the hierarchy/classification above, versioning, approval
   workflow.
2. Test case authoring + execution tracking, verification vs. validation typing.
3. Auto-maintained traceability matrix with export (PDF/CSV) for submission packets.
4. Jira sync (bidirectional link/status sync, not just a URL field).
5. Spira importer (requirements, test cases, existing traceability links) — the deliberate
   acquisition wedge: Spira's own dissatisfied customers are the first prospects.
6. Self-hostable (Docker Compose) open-source core.
7. Hosted multi-tenant SaaS with self-serve signup and transparent public pricing.

## Explicit non-goals (MVP)

CAPA, complaint handling, supplier/vendor management, company-wide document control/SOP
management, ISO 14971 risk management module, DO-178C/ISO 26262 templates (other
verticals), a polished on-prem installer/support SLA (self-host is best-effort), full
Part 11 validation package for the vendor itself.

## Business model & licensing

- **Core: AGPL-3.0**, self-hostable. Anyone can use, contribute, and fork. The network-use
  clause means anyone who forks and runs a modified version as a hosted service must also
  release that modified source — blocks a competitor from forking this repo to host a
  competing SaaS without contributing back.
- **Monetization: open-core.** Paid features (SSO/SAML, the Part 11 e-signature validation
  package, hosted-with-SLA, audit-log export/retention, later an ISO 14971 module) live in a
  separate proprietary layer that is never published to the AGPL repo.
- **No CLA.** Contributors keep their code under AGPL with no extra rights granted to the
  project.

## Non-competitive set (for reference)

- **Legacy enterprise ALM** (Jama Connect, Siemens Polarion, PTC Codebeamer, OpenText ALM
  Quality Center, IBM DOORS Next) — deep compliance features, custom-quote pricing, long
  sales cycles, dated UX.
- **Modern regulated-focused entrants** — Ketryx (closest direct competitor), Matrix
  Requirements, Visure Solutions, Orcanos, ReqView (requirements-only, no test management).
- **Developer-first test tools** (Qase, Testmo, Tuskr, TestRail, PractiTest) — the UX
  benchmark, but no compliance depth.

## Next step

Technical/MVP build plan: concrete stack choice, the open-source/proprietary repo boundary
(plugin interface vs. separate service), API surface for the Jira/Spira integrations, and
the auth/e-signature implementation approach.
