import { createAppDb, schema } from "@galm/db";
import { sendEmail, verificationEmailTemplate } from "@galm/email";
import { registerWorker } from "@galm/jobs";

const db = createAppDb();

async function main() {
  console.log("[worker] starting, registering job handlers...");

  await registerWorker<{ message: string }>("ping", async (data) => {
    console.log("[worker] processing ping job:", data.message);
    await db.insert(schema.jobPings).values({ message: data.message });
  });

  await registerWorker<{ to: string; name: string; url: string }>(
    "send-verification-email",
    async (data) => {
      const { subject, html, text } = verificationEmailTemplate({ name: data.name, url: data.url });
      await sendEmail({ to: data.to, subject, html, text });
    },
  );

  console.log("[worker] ready, waiting for jobs.");
}

main().catch((err) => {
  console.error("[worker] fatal error:", err);
  process.exit(1);
});

// Keep the process alive; pg-boss's worker polling runs on its own internal timer.
process.on("SIGTERM", () => process.exit(0));
