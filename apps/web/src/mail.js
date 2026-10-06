import { config } from './config.js';

/**
 * Email through Resend over plain fetch. With no key (local, tests) the message
 * is logged instead, so sign-in still works on a dev box.
 */
export async function send({ to, subject, text }) {
  if (!config.mail.enabled) {
    console.log(`[mail] (not sent, RESEND_API_KEY unset) to=${to} subject=${subject}\n${text}`);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.mail.resendKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: config.mail.from, to, subject, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

export const sendLoginLink = ({ email, url }) =>
  send({
    to: email,
    subject: 'Your wx93 sign-in link',
    text: `Tap to sign in to wx93:\n\n${url}\n\nThe link works once and expires in 20 minutes.\nIf you did not ask for it, ignore this email.`,
  });

export const sendReceipt = ({ email, plan, term, endsAt, amountCents }) =>
  send({
    to: email,
    subject: `wx93 ${plan} is on`,
    text: [
      `Your payment of $${(amountCents / 100).toFixed(2)} settled. ${plan} is paid through ${new Date(endsAt).toISOString().slice(0, 10)} (one ${term}).`,
      '',
      'Payment is prepaid crypto, so nothing renews by itself. Renew any time from your account.',
      '',
      `${config.siteUrl}/account`,
    ].join('\n'),
  });

export const sendAbuseNotice = ({ to, link, count }) =>
  send({
    to,
    subject: `wx93: ${link.code} pulled after ${count} reports`,
    text: `${config.siteUrl}/${link.code} -> ${link.url}\n\nThe link was disabled pending review. Restore it from ${config.siteUrl}/admin if the reports were wrong.`,
  });
