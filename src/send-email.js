import { buildOrderEmailHtml } from './email-template.js';

export async function sendOrderConfirmationEmail(draftOrder, env) {
  // 1. Build HTML
  const firstName = draftOrder.shipping_address?.first_name || 'there';
  const html = buildOrderEmailHtml(draftOrder);

  // 2. POST to Resend
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'AIGO Sunshine Fresh <info@my-aigo.com>',
      to: [draftOrder.email],
      subject: `We received your order, ${firstName}!`,
      html,
    }),
  });

  // 3. Log on failure (non-throwing — caller decides whether to catch)
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[Email] Resend error ${res.status}:`, text);
  }

  return res;
}
