import { protectedProcedure, router } from "../trpc";
import { adminRouter } from "./admin";
import { documentTemplatesRouter } from "./document-templates";
import { llmRouter } from "./llm";
import { architectureRouter } from "./architecture";
import { membersRouter } from "./members";
import { otsRouter } from "./ots";
import { productsRouter } from "./products";
import { requirementsRouter } from "./requirements";
import { settingsRouter } from "./settings";
import { softwareVersionsRouter } from "./software-versions";
import { spiraImportRouter } from "./spira-import";
import { testCasesRouter } from "./test-cases";
import { testSetsRouter } from "./test-sets";
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
  admin: adminRouter,
  architecture: architectureRouter,
  documentTemplates: documentTemplatesRouter,
  llm: llmRouter,
  members: membersRouter,
  ots: otsRouter,
  products: productsRouter,
  requirements: requirementsRouter,
  settings: settingsRouter,
  softwareVersions: softwareVersionsRouter,
  testCases: testCasesRouter,
  testSets: testSetsRouter,
  spiraImport: spiraImportRouter,
  traceability: traceabilityRouter,
  vulnerabilities: vulnerabilitiesRouter,
});

export type AppRouter = typeof appRouter;
