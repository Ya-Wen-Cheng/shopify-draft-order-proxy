/**
 * email-template.js
 * Builds the HTML string for the AIGO Sunshine Fresh order confirmation email.
 * Exported: buildOrderEmailHtml(draftOrder)
 */

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * Escape user-supplied strings before interpolating into HTML to prevent XSS.
 */
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format an ISO timestamp (or any Date-parseable string) to "Jun 26, 2026".
 * Falls back to today's date if the input is null/undefined/invalid.
 */
function formatDate(isoString) {
  const d = isoString ? new Date(isoString) : new Date();
  if (isNaN(d.getTime())) return formatDate(null);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Ensure a numeric string like "87.27" is returned as "$87.27".
 * Handles null/undefined gracefully.
 */
function formatCurrency(str) {
  const n = parseFloat(str);
  if (isNaN(n)) return '$0.00';
  return '$' + n.toFixed(2);
}

/**
 * Parse the order note into its three logical parts:
 *   instructions   — text BEFORE any "Payment method:" or "Promo code:" line
 *   paymentMethod  — text after "Payment method: " (if present)
 *   promoCode      — text after "Promo code: " (if present)
 */
function parseNote(note) {
  if (!note) return { instructions: '', paymentMethod: '', promoCode: '' };

  const lines = note.split('\n');
  const instructionLines = [];
  let paymentMethod = '';
  let promoCode = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^payment method:/i.test(trimmed)) {
      paymentMethod = trimmed.replace(/^payment method:\s*/i, '').trim();
    } else if (/^promo code:/i.test(trimmed)) {
      promoCode = trimmed.replace(/^promo code:\s*/i, '').trim();
    } else {
      instructionLines.push(trimmed);
    }
  }

  return {
    instructions: instructionLines.join('\n').trim(),
    paymentMethod,
    promoCode,
  };
}

/**
 * Given a payment method label (e.g. "Invoice · Net 30") return a short chip
 * string like "NET 30", "ACH", "CHECK", or null if no known chip applies.
 */
function extractPaymentChip(label) {
  if (!label) return null;
  if (/net\s*30/i.test(label)) return 'NET 30';
  if (/ach/i.test(label)) return 'ACH';
  if (/check/i.test(label)) return 'CHECK';
  return null;
}

// ── Public export ────────────────────────────────────────────────────────────

/**
 * Build the complete HTML email string for an order confirmation.
 * @param {Object} draftOrder  Shopify draft order object (REST API shape)
 * @returns {string}           Full HTML document
 */
export function buildOrderEmailHtml(draftOrder) {
  const order = draftOrder || {};

  // ── Derived values ───────────────────────────────────────────────────────

  const addr = order.shipping_address || {};
  const firstName = addr.first_name || '';
  const lastName  = addr.last_name  || '';
  const email     = order.email     || '';

  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  const totalQty  = lineItems.reduce((sum, item) => sum + (parseInt(item.quantity, 10) || 0), 0);

  const shippingLine = order.shipping_line || null;

  const { instructions, paymentMethod } = parseNote(order.note);
  const resolvedPayment = paymentMethod || 'Invoice';
  const payChip = extractPaymentChip(resolvedPayment);

  const orderDate  = formatDate(order.created_at);
  const currentYear = new Date().getFullYear();

  // Fix 5: pluralization helper used in meta chips, section heading, subtotal row
  const itemsLabel = totalQty === 1 ? '1 item' : `${totalQty} items`;

  // ── Section builders ─────────────────────────────────────────────────────

  // 3. Delivery banner — omit entirely when no shipping_line
  const deliveryBannerHtml = shippingLine ? `
    <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" class="delivery-banner"><tr>
      <td style="width:40px; vertical-align:middle; padding-right:14px;">
        <div class="delivery-banner__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
        </div>
      </td>
      <td class="delivery-banner__text" style="vertical-align:middle;">
        <b>${escHtml(shippingLine.title) || 'Standard Shipping'}</b>
        <span>Delivery in 3–5 business days</span>
      </td>
    </tr></table>` : '';

  // 4. Line items — no .item-thumb, show .item-info + .item-qty + .item-price
  const lineItemsHtml = lineItems.map(item => {
    const qty       = parseInt(item.quantity, 10) || 0;
    const unitPrice = parseFloat(item.price) || 0;
    const lineTotal = (unitPrice * qty).toFixed(2);
    const varHtml   = item.variant_title
      ? `<div class="item-var">${escHtml(item.variant_title)}</div>`
      : '';

    return `
      <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" class="item-row"><tr>
        <td class="item-info" style="vertical-align:middle;">
          <div class="item-name">${escHtml(item.title)}</div>
          ${varHtml}
        </td>
        <td class="item-qty" style="vertical-align:middle; white-space:nowrap; padding-left:14px;">× ${qty}</td>
        <td class="item-price" style="vertical-align:middle; text-align:right; white-space:nowrap; padding-left:14px;">$${lineTotal}<span>est.</span></td>
      </tr></table>`;
  }).join('');

  // 5. Delivery address lines (skip empty fields, escape all user data)
  const address1Html = addr.address1 ? `${escHtml(addr.address1)}<br>` : '';
  const address2Html = addr.address2 ? `${escHtml(addr.address2)}<br>` : '';
  const cityProvZip  = [addr.city, addr.province, addr.zip].filter(Boolean).map(escHtml).join(', ');
  const countryHtml  = addr.country  ? `${escHtml(addr.country)}<br>`  : '';
  const phoneHtml    = addr.phone    ? `${escHtml(addr.phone)}<br>`    : '';

  // Payment method chip
  const payChipHtml = payChip
    ? `<span class="pay-chip">${payChip}</span>`
    : '';

  // 6. Delivery instructions — omit entire section when empty
  const deliveryInstructionsHtml = instructions ? `
    <div class="email-sec">
      <table border="0" cellpadding="0" cellspacing="0" role="presentation" class="sec-head"><tr>
        <td style="width:30px; vertical-align:middle; padding-right:10px;">
          <div class="sec-head__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          </div>
        </td>
        <td style="vertical-align:middle;">
          <h2>Delivery instructions</h2>
        </td>
      </tr></table>
      <div class="instructions-box">
        <strong>From ${escHtml(firstName)} ${escHtml(lastName)}</strong>
        ${escHtml(instructions)}
      </div>
    </div>` : '';

  // 7. Totals — shipping row only when shipping_line exists
  const shippingRowHtml = shippingLine ? `
      <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" class="totals-row"><tr>
        <td style="vertical-align:baseline;">Shipping · ${escHtml(shippingLine.title) || 'Shipping'}</td>
        <td style="vertical-align:baseline; text-align:right;"><b>${formatCurrency(shippingLine.price)}</b></td>
      </tr></table>` : '';

  // ── Full HTML ────────────────────────────────────────────────────────────

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Order Confirmation — AIGO Sunshine Fresh</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;600;700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Hanken Grotesk', Arial, sans-serif;
    background: #EDEAE3;
    -webkit-font-smoothing: antialiased;
    padding: 40px 16px 64px;
  }

  /* ── Outer email shell ── */
  .email-shell {
    max-width: 600px;
    margin: 0 auto;
    background: #ffffff;
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 4px 24px rgba(27,42,36,.10);
  }

  /* ── Header ── */
  .email-header {
    background: #0F5C44;
    padding: 32px 40px 28px;
    text-align: center;
  }
  .email-logo {
    font-family: 'Fredoka', Arial, sans-serif;
    font-weight: 700;
    font-size: 28px;
    color: #ffffff;
    letter-spacing: -0.01em;
    margin-bottom: 24px;
    display: block;
  }
  .email-logo span {
    color: #06D6A0;
  }
  .email-check {
    width: 56px; height: 56px;
    background: #06D6A0;
    border-radius: 50%;
    text-align: center;
    line-height: 0;
    margin: 0 auto 16px;
  }
  .email-check svg { width: 28px; height: 28px; }
  .email-header h1 {
    font-family: 'Fredoka', Arial, sans-serif;
    font-weight: 700;
    font-size: 26px;
    color: #ffffff;
    line-height: 1.2;
    margin-bottom: 8px;
  }
  .email-header p {
    font-size: 14px;
    color: #8DEDCD;
    line-height: 1.6;
  }
  .email-header p b { color: #ffffff; }

  /* ── Meta chips ── */
  .email-meta {
    background: #0A3D2E;
    padding: 16px 40px;
  }
  .email-meta__chip {
    padding: 0 8px;
  }
  .email-meta__label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: #4FE2B4;
  }
  .email-meta__val {
    font-family: 'Fredoka', Arial, sans-serif;
    font-weight: 600;
    font-size: 14px;
    color: #ffffff;
  }
  .email-meta__sep {
    width: 1px;
    background: rgba(255,255,255,.12);
  }

  /* ── Body ── */
  .email-body { padding: 32px 40px; }

  /* ── Section headings ── */
  .sec-head {
    width: 100%;
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1.5px solid #E2E8E4;
  }
  .sec-head__icon {
    width: 30px; height: 30px;
    background: #E6FBF4;
    border-radius: 8px;
    text-align: center;
    line-height: 0;
  }
  .sec-head__icon svg { width: 16px; height: 16px; color: #058C6B; }
  .sec-head h2 {
    font-family: 'Fredoka', Arial, sans-serif;
    font-weight: 700;
    font-size: 16px;
    color: #0A3D2E;
  }

  /* ── Section spacing ── */
  .email-sec { margin-bottom: 28px; }

  /* ── Line items ── */
  .item-row {
    width: 100%;
    padding: 14px 0;
    border-bottom: 1px solid #F4F6F3;
  }
  .item-row:last-child { border-bottom: none; }
  .item-info { width: 100%; }
  .item-name {
    font-weight: 700;
    font-size: 13.5px;
    color: #1B2A24;
    line-height: 1.3;
    margin-bottom: 2px;
  }
  .item-var {
    font-size: 12px;
    color: #7C8B83;
  }
  .item-qty {
    font-size: 12px;
    color: #5E6E66;
    font-weight: 600;
    background: #F4F6F3;
    border-radius: 999px;
    padding: 3px 10px;
    white-space: nowrap;
  }
  .item-price {
    font-family: 'Fredoka', Arial, sans-serif;
    font-weight: 700;
    font-size: 15px;
    color: #1B2A24;
    white-space: nowrap;
    text-align: right;
    min-width: 64px;
  }
  .item-price span {
    display: block;
    font-family: 'Hanken Grotesk', Arial, sans-serif;
    font-weight: 400;
    font-size: 11px;
    color: #9FACA4;
  }

  /* ── Info cards (address, payment) ── */
  .info-card {
    background: #FAFBF8;
    border: 1.5px solid #E2E8E4;
    border-radius: 12px;
    padding: 16px 18px;
  }
  .info-card__col { }
  .info-card__label {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: #9FACA4;
    margin-bottom: 6px;
  }
  .info-card__val {
    font-size: 13.5px;
    color: #2C3A33;
    line-height: 1.6;
  }
  .info-card__val b { color: #1B2A24; font-weight: 700; }
  .info-card__sep {
    width: 1px; background: #E2E8E4;
  }

  /* ── Payment badge ── */
  .pay-chip {
    display: inline-block;
    background: #E2E8E4;
    border-radius: 5px;
    padding: 3px 8px;
    font-size: 10px;
    font-weight: 700;
    color: #45554D;
    margin-top: 4px;
    letter-spacing: .03em;
  }

  /* ── Delivery instructions ── */
  .instructions-box {
    background: #FFF3C9;
    border: 1.5px solid #FFE9A0;
    border-radius: 12px;
    padding: 14px 16px;
    font-size: 13.5px;
    color: #6F4D14;
    line-height: 1.6;
    font-style: italic;
  }
  .instructions-box strong {
    font-style: normal;
    color: #A8731A;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
    display: block;
    margin-bottom: 6px;
  }

  /* ── Totals ── */
  .totals-table { width: 100%; }
  .totals-row {
    width: 100%;
    padding: 7px 0;
    font-size: 13.5px;
    color: #5E6E66;
    border-bottom: 1px solid #F4F6F3;
  }
  .totals-row:last-child { border-bottom: none; }
  .totals-row b { font-family: 'Fredoka', Arial, sans-serif; font-weight: 600; font-size: 14px; color: #1B2A24; }
  .totals-row.disc { color: #058C6B; }
  .totals-row.disc b { color: #058C6B; }
  .totals-divider { height: 1.5px; background: #E2E8E4; margin: 10px 0; }
  .totals-grand {
    width: 100%;
    padding: 12px 16px;
    background: #0F5C44;
    border-radius: 12px;
    margin-top: 14px;
  }
  .totals-grand__label {
    font-family: 'Fredoka', Arial, sans-serif;
    font-weight: 700;
    font-size: 16px;
    color: #ffffff;
  }
  .totals-grand__label span {
    display: block;
    font-family: 'Hanken Grotesk', Arial, sans-serif;
    font-weight: 400;
    font-size: 11.5px;
    color: #8DEDCD;
    margin-top: 2px;
  }
  .totals-grand__amt {
    font-family: 'Fredoka', Arial, sans-serif;
    font-weight: 700;
    font-size: 26px;
    color: #06D6A0;
  }
  /* ── Invoice notice ── */
  .invoice-notice {
    width: 100%;
    background: #FFF3C9;
    border: 1.5px solid #FFE9A0;
    border-left: 4px solid #F5B82E;
    border-radius: 10px;
    padding: 14px 16px;
    margin-top: 14px;
  }
  .invoice-notice svg { width: 18px; height: 18px; color: #D9971A; margin-top: 1px; }
  .invoice-notice__text { font-size: 13px; color: #6F4D14; line-height: 1.6; }
  .invoice-notice__text b { color: #A8731A; display: block; margin-bottom: 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }

  .totals-disclaimer {
    width: 100%;
    margin-top: 12px;
    font-size: 11.5px;
    color: #9FACA4;
    line-height: 1.5;
  }
  .totals-disclaimer svg { width: 14px; height: 14px; margin-top: 1px; }

  /* ── Delivery banner ── */
  .delivery-banner {
    width: 100%;
    background: #E6FBF4;
    border: 1.5px solid #C2F5E4;
    border-radius: 12px;
    padding: 14px 18px;
    margin-bottom: 28px;
  }
  .delivery-banner__icon {
    width: 40px; height: 40px;
    background: #06D6A0;
    border-radius: 50%;
    text-align: center;
    line-height: 0;
  }
  .delivery-banner__icon svg { width: 20px; height: 20px; color: #0A3D2E; }
  .delivery-banner__text b {
    display: block;
    font-family: 'Fredoka', Arial, sans-serif;
    font-weight: 700;
    font-size: 15px;
    color: #0F5C44;
    margin-bottom: 2px;
  }
  .delivery-banner__text span {
    font-size: 12.5px;
    color: #058C6B;
  }

  /* ── Footer ── */
  .email-footer {
    background: #1B2A24;
    padding: 28px 40px;
    text-align: center;
  }
  .email-footer__logo {
    font-family: 'Fredoka', Arial, sans-serif;
    font-weight: 700;
    font-size: 18px;
    color: #ffffff;
    margin-bottom: 8px;
  }
  .email-footer__logo span { color: #06D6A0; }
  .email-footer p {
    font-size: 12px;
    color: #5E6E66;
    line-height: 1.6;
    margin-bottom: 14px;
  }
  .email-footer__links-a {
    font-size: 12px;
    color: #4FE2B4;
    text-decoration: none;
  }
  .email-footer__divider {
    height: 1px;
    background: #2C3A33;
    margin: 20px 0;
  }
  .email-footer__legal {
    font-size: 11px;
    color: #45554D;
    line-height: 1.6;
  }
</style>
</head>
<body>

<div class="email-shell">

  <!-- ── HEADER ── -->
  <div class="email-header">
    <span class="email-logo">AIG<span>O</span> Sunshine Fresh</span>
    <div class="email-check">
      <svg viewBox="0 0 24 24" fill="none" stroke="#0A3D2E" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    </div>
    <h1>Order received, ${escHtml(firstName)}!</h1>
    <p>Thanks for your order. Our team is reviewing it and will confirm your delivery details shortly. A copy of this email has been sent to <b>${escHtml(email)}</b>.</p>
  </div>

  <!-- ── META CHIPS ── -->
  <div class="email-meta">
    <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%"><tr>
      <td class="email-meta__chip" style="text-align:center">
        <span class="email-meta__label">Order</span><br>
        <span class="email-meta__val">${escHtml(order.name) || '#—'}</span>
      </td>
      <td class="email-meta__sep"></td>
      <td class="email-meta__chip" style="text-align:center">
        <span class="email-meta__label">Date</span><br>
        <span class="email-meta__val">${orderDate}</span>
      </td>
      <td class="email-meta__sep"></td>
      <td class="email-meta__chip" style="text-align:center">
        <span class="email-meta__label">Items</span><br>
        <span class="email-meta__val">${itemsLabel}</span>
      </td>
      <td class="email-meta__sep"></td>
      <td class="email-meta__chip" style="text-align:center">
        <span class="email-meta__label">Est. delivery</span><br>
        <span class="email-meta__val">3–5 business days</span>
      </td>
    </tr></table>
  </div>

  <!-- ── BODY ── -->
  <div class="email-body">

    ${deliveryBannerHtml}

    <!-- 1. Items -->
    <div class="email-sec">
      <table border="0" cellpadding="0" cellspacing="0" role="presentation" class="sec-head"><tr>
        <td style="width:30px; vertical-align:middle; padding-right:10px;">
          <div class="sec-head__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
          </div>
        </td>
        <td style="vertical-align:middle;">
          <h2>Your order · ${itemsLabel}</h2>
        </td>
      </tr></table>
      ${lineItemsHtml}
    </div>

    <!-- 2. Delivery address + Payment method -->
    <div class="email-sec">
      <table border="0" cellpadding="0" cellspacing="0" role="presentation" class="sec-head"><tr>
        <td style="width:30px; vertical-align:middle; padding-right:10px;">
          <div class="sec-head__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
          </div>
        </td>
        <td style="vertical-align:middle;">
          <h2>Delivery &amp; Payment</h2>
        </td>
      </tr></table>
      <div class="info-card">
        <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%"><tr>
          <td class="info-card__col" style="vertical-align:top; width:50%;">
            <div class="info-card__label">Delivery address</div>
            <div class="info-card__val">
              <b>${escHtml(firstName)} ${escHtml(lastName)}</b><br>
              ${address1Html}${address2Html}${cityProvZip}<br>
              ${countryHtml}${phoneHtml}
            </div>
          </td>
          <td class="info-card__sep" style="width:1px;"></td>
          <td class="info-card__col" style="vertical-align:top; width:50%; padding-left:16px;">
            <div class="info-card__label">Payment method</div>
            <div class="info-card__val">
              <b>${escHtml(resolvedPayment)}</b><br>
              ${payChipHtml}
            </div>
          </td>
        </tr></table>
      </div>
    </div>

    ${deliveryInstructionsHtml}

    <!-- 4. Order totals -->
    <div class="email-sec">
      <table border="0" cellpadding="0" cellspacing="0" role="presentation" class="sec-head"><tr>
        <td style="width:30px; vertical-align:middle; padding-right:10px;">
          <div class="sec-head__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          </div>
        </td>
        <td style="vertical-align:middle;">
          <h2>Estimated totals</h2>
        </td>
      </tr></table>

      <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" class="totals-row"><tr>
        <td style="vertical-align:baseline;">Subtotal · ${itemsLabel}</td>
        <td style="vertical-align:baseline; text-align:right;"><b>${formatCurrency(order.subtotal_price)}</b></td>
      </tr></table>
      ${shippingRowHtml}

      <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" class="totals-grand"><tr>
        <td style="vertical-align:baseline;">
          <div class="totals-grand__label">
            Est. total
            <span>Prices confirmed on invoice</span>
          </div>
        </td>
        <td style="vertical-align:baseline; text-align:right;">
          <div class="totals-grand__amt">~${formatCurrency(order.total_price)}</div>
        </td>
      </tr></table>

      <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" class="invoice-notice"><tr>
        <td style="width:18px; vertical-align:top; padding-top:1px; padding-right:12px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        </td>
        <td class="invoice-notice__text" style="vertical-align:top;">
          <b>Final amount confirmed on invoice</b>The totals above are estimates. Your formal invoice — with the confirmed final amount — will be sent when your order ships. No payment is taken now.
        </td>
      </tr></table>

      <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" class="totals-disclaimer"><tr>
        <td style="width:14px; vertical-align:top; padding-top:1px; padding-right:8px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        </td>
        <td style="vertical-align:top;">Prices are estimates based on recent supplier costs and may be adjusted slightly on your invoice. No payment is taken at this stage — you'll receive a formal invoice with the final total when your order ships.</td>
      </tr></table>
    </div>

  </div>

  <!-- ── FOOTER ── -->
  <div class="email-footer">
    <div class="email-footer__logo">AIG<span>O</span> Sunshine Fresh</div>
    <p>Wholesale Asian groceries, fresh produce &amp; bubble-tea supplies.<br>Fresh you can see — and taste.</p>
    <table border="0" cellpadding="0" cellspacing="0" role="presentation" align="center"><tr>
      <td style="padding: 0 10px;"><a href="#" class="email-footer__links-a">Track order</a></td>
      <td style="padding: 0 10px;"><a href="#" class="email-footer__links-a">View order online</a></td>
      <td style="padding: 0 10px;"><a href="#" class="email-footer__links-a">Contact support</a></td>
      <td style="padding: 0 10px;"><a href="#" class="email-footer__links-a">Unsubscribe</a></td>
    </tr></table>
    <div class="email-footer__divider"></div>
    <div class="email-footer__legal">
      &copy; ${currentYear} AIGO Sunshine Fresh &middot; 188 S Valley Blvd, San Gabriel, CA 91776<br>
      You received this email because you placed an order on aigosunshinefresh.com
    </div>
  </div>

</div>

</body>
</html>`;
}
