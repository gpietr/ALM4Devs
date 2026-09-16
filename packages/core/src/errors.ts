/** Shared across packages/core's domain modules - kept in its own file so requirements.ts,
 * requirement-levels.ts, and status-admin.ts can all import it without creating a
 * circular dependency between each other. */
export class DomainError extends Error {}
