// SPDX-License-Identifier: MIT
import type { EmailMessage } from "../../service/src/email_sender.ts";
export {
  createEmailSender,
  EMAIL_ENDPOINTS,
  type EmailConfig,
  type EmailMessage,
  type EmailSender,
} from "../../service/src/email_sender.ts";

/** The kinds of email Quaso sends, and the website page each links to. */
export const EMAIL_PAGES = {
  verify: "/verify-email",
  reset: "/reset-password",
  signin: "/signin/link",
} as const;

export type EmailKind = keyof typeof EMAIL_PAGES;

/** The link in an email: the website's page, with the token. */
export function emailLink(publicUrl: string, kind: EmailKind, token: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${EMAIL_PAGES[kind]}?token=${encodeURIComponent(token)}`;
}

const TEXTS: Record<EmailKind, { subject: string; intro: string; action: string; outro: string }> =
  {
    verify: {
      subject: "Confirm your email address",
      intro: "Confirm that this is your email address for {project}:",
      action: "Confirm my email address",
      outro: "The link works for 7 days. If you didn't sign up, ignore this email.",
    },
    reset: {
      subject: "Reset your password",
      intro: "Someone asked to reset the password of your {project} account. To choose a new one:",
      action: "Choose a new password",
      outro:
        "The link works for an hour, once. If you didn't ask, ignore this email: " +
        "your password stays as it is.",
    },
    signin: {
      subject: "Your sign-in link",
      intro: "Sign in to {project} with this link:",
      action: "Sign in",
      outro: "The link works for an hour, once. If you didn't ask for it, ignore this email.",
    },
  };

/** An email with a link: plain text, and simple HTML with the text escaped. */
export function linkEmail(
  kind: EmailKind,
  options: { to: string; publicUrl: string; token: string; projectName: string },
): EmailMessage {
  const texts = TEXTS[kind];
  const link = emailLink(options.publicUrl, kind, options.token);
  const project = options.projectName.trim() || "Quaso";
  const intro = texts.intro.replace("{project}", project);
  const subject = `${texts.subject} (${project})`;
  const text = `${intro}\n\n${link}\n\n${texts.outro}\n`;
  const html = [
    "<!doctype html>",
    '<html><body style="font-family: sans-serif; line-height: 1.5">',
    `<p>${escapeHtml(intro)}</p>`,
    `<p><a href="${escapeHtml(link)}">${escapeHtml(texts.action)}</a></p>`,
    `<p style="color: #555">${escapeHtml(texts.outro)}</p>`,
    `<p style="color: #555; font-size: 0.9em">${escapeHtml(link)}</p>`,
    "</body></html>",
  ].join("\n");
  return { to: options.to, subject, text, html };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
