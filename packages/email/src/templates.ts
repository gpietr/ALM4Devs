export interface VerificationEmailContent {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** `url` is a better-auth-generated link (server-controlled); `name` is the user-supplied
 * display name from registration, so it's escaped before going into the HTML body. */
export function verificationEmailTemplate({ name, url }: { name: string; url: string }): VerificationEmailContent {
  const safeName = escapeHtml(name);
  const subject = "Verify your email address";
  const text = `Hi ${name},\n\nConfirm your email address to finish setting up your ALM4Devs account:\n${url}\n\nIf you didn't create this account, you can ignore this email.`;
  const html = `
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; color: #1e293b;">
  <p>Hi ${safeName},</p>
  <p>Confirm your email address to finish setting up your ALM4Devs account.</p>
  <p>
    <a href="${url}" style="display:inline-block;padding:10px 16px;background:#1e293b;color:#ffffff;text-decoration:none;border-radius:4px;">
      Verify email
    </a>
  </p>
  <p>Or paste this link into your browser:<br><a href="${url}">${url}</a></p>
  <p style="color:#64748b;font-size:13px;">If you didn't create this account, you can ignore this email.</p>
</div>
`.trim();
  return { subject, html, text };
}
