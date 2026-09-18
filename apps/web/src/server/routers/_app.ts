import { protectedProcedure, router } from "../trpc";
import { documentTemplatesRouter } from "./document-templates";
import { llmRouter } from "./llm";
import { architectureRouter } from "./architecture";
import { productsRouter } from "./products";
import { requirementsRouter } from "./requirements";
import { settingsRouter } from "./settings";
import { softwareVersionsRouter } from "./software-versions";
import { spiraImportRouter } from "./spira-import";
import { testCasesRouter } from "./test-cases";
import { traceabilityRouter } from "./traceability";
import { vulnerabilitiesRouter } from "./vulnerabilities";

export const appRouter = router({
  me: protectedProcedure.query(({ ctx }) => {
    const user = ctx.session.user as { id: string; email: string; tenantId?: string };
    return {
      userId: user.id,
      email: user.email,
      tenantId: user.tenantId ?? null,
    };
  }),
  architecture: architectureRouter,
  documentTemplates: documentTemplatesRouter,
  llm: llmRouter,
  products: productsRouter,
  requirements: requirementsRouter,
  settings: settingsRouter,
  softwareVersions: softwareVersionsRouter,
  testCases: testCasesRouter,
  spiraImport: spiraImportRouter,
  traceability: traceabilityRouter,
  vulnerabilities: vulnerabilitiesRouter,
});

export type AppRouter = typeof appRouter;
