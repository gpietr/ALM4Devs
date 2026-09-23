import nodemailer, { type Transporter } from "nodemailer";

/**
 * Email abstraction (mirrors @galm/storage's driver split): SMTP is the only transport,
 * chosen because it's the one thing every self-hosted deployment can already point at
 * (their own relay, a hosted provider's SMTP endpoint, or Mailpit in dev) without a
 * provider-specific SDK/API-key dependency. See TECH_STACK.md section 6.
 */
export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
}

let transporterPromise: Promise<Transporter> | null = null;

function getTransporter(): Promise<Transporter> {
  if (!transporterPromise) {
    const host = process.env.SMTP_HOST;
    if (!host) {
      throw new Error("SMTP_HOST is not set");
    }
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    transporterPromise = Promise.resolve(
      nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === "true",
        auth: user ? { user, pass } : undefined,
      }),
    );
  }
  return transporterPromise;
}

export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  const transporter = await getTransporter();
  await transporter.sendMail({
    from: process.env.EMAIL_FROM ?? "no-reply@localhost",
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  });
}

export { verificationEmailTemplate } from "./templates";
export type { VerificationEmailContent } from "./templates";
