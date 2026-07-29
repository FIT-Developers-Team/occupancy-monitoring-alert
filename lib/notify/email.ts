import nodemailer from "nodemailer";

export async function sendEmail(
  to: string,
  subject: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const host = process.env.SMTP_HOST;
  if (!host) return { ok: false, error: "SMTP belum dikonfigurasi" };
  try {
    const transporter = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      connectionTimeout: 12_000,
      greetingTimeout: 12_000,
      socketTimeout: 20_000,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || "WIOM Control Tower <wiom@localhost>",
      to, subject, text,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
