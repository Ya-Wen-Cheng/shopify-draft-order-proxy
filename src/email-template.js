/**
 * email-template.js
 * Builds the HTML string for the AIGO Sunshine Fresh order confirmation email.
 * Exported: buildOrderEmailHtml(draftOrder)
 */

// ── Private helpers ──────────────────────────────────────────────────────────

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
    if (trimmed.startsWith('Payment method:')) {
      paymentMethod = trimmed.replace(/^Payment method:\s*/i, '').trim();
    } else if (trimmed.startsWith('Promo code:')) {
      promoCode = trimmed.replace(/^Promo code:\s*/i, '').trim();
    } else {
      instructionLines.push(line);
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

  // ── Section builders ─────────────────────────────────────────────────────

  // 3. Delivery banner — omit entirely when no shipping_line
  const deliveryBannerHtml = shippingLine ? `
    <div class="delivery-banner">
      <div class="delivery-banner__icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
      </div>
      <div class="delivery-banner__text">
        <b>${shippingLine.title || 'Standard Shipping'}</b>
        <span>Delivery in 3–5 business days</span>
      </div>
    </div>` : '';

  // 4. Line items — no .item-thumb, show .item-info + .item-qty + .item-price
  const lineItemsHtml = lineItems.map(item => {
    const qty       = parseInt(item.quantity, 10) || 0;
    const unitPrice = parseFloat(item.price) || 0;
    const lineTotal = (unitPrice * qty).toFixed(2);
    const varHtml   = item.variant_title
      ? `<div class="item-var">${item.variant_title}</div>`
      : '';

    return `
      <div class="item-row">
        <div class="item-info">
          <div class="item-name">${item.title || ''}</div>
          ${varHtml}
        </div>
        <div class="item-qty">× ${qty}</div>
        <div class="item-price">$${lineTotal}<span>est.</span></div>
      </div>`;
  }).join('');

  // 5. Delivery address lines (skip empty fields)
  const address2Html = addr.address2
    ? `${addr.address2}<br>`
    : '';
  const cityProvZip  = [addr.city, addr.province, addr.zip].filter(Boolean).join(', ');
  const phoneHtml    = addr.phone
    ? `${addr.phone}<br>`
    : '';

  // Payment method chip
  const payChipHtml = payChip
    ? `<span class="pay-chip">${payChip}</span>`
    : '';

  // 6. Delivery instructions — omit entire section when empty
  const deliveryInstructionsHtml = instructions ? `
    <div class="email-sec">
      <div class="sec-head">
        <div class="sec-head__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        </div>
        <h2>Delivery instructions</h2>
      </div>
      <div class="instructions-box">
        <strong>From ${firstName} ${lastName}</strong>
        ${instructions}
      </div>
    </div>` : '';

  // 7. Totals — shipping row only when shipping_line exists
  const shippingRowHtml = shippingLine ? `
      <div class="totals-row">
        <span>Shipping · ${shippingLine.title || 'Shipping'}</span>
        <b>${formatCurrency(shippingLine.price)}</b>
      </div>` : '';

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
    display: flex;
    align-items: center;
    justify-content: center;
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
    display: flex;
    gap: 0;
    justify-content: space-between;
  }
  .email-meta__chip {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
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
    align-self: stretch;
  }

  /* ── Body ── */
  .email-body { padding: 32px 40px; }

  /* ── Section headings ── */
  .sec-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1.5px solid #E2E8E4;
  }
  .sec-head__icon {
    width: 30px; height: 30px;
    background: #E6FBF4;
    border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
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
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 0;
    border-bottom: 1px solid #F4F6F3;
  }
  .item-row:last-child { border-bottom: none; }
  .item-thumb {
    width: 52px; height: 52px;
    border-radius: 10px;
    flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .item-thumb svg { width: 24px; height: 24px; color: rgba(255,255,255,.9); }
  .item-info { flex: 1; min-width: 0; }
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
    flex-shrink: 0;
  }
  .item-price {
    font-family: 'Fredoka', Arial, sans-serif;
    font-weight: 700;
    font-size: 15px;
    color: #1B2A24;
    white-space: nowrap;
    flex-shrink: 0;
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
  .info-card__row {
    display: flex;
    gap: 16px;
  }
  .info-card__col { flex: 1; }
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
    align-self: stretch; flex-shrink: 0;
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
    display: flex;
    justify-content: space-between;
    align-items: baseline;
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
    display: flex;
    justify-content: space-between;
    align-items: baseline;
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
    display: flex;
    align-items: flex-start;
    gap: 12px;
    background: #FFF3C9;
    border: 1.5px solid #FFE9A0;
    border-left: 4px solid #F5B82E;
    border-radius: 10px;
    padding: 14px 16px;
    margin-top: 14px;
  }
  .invoice-notice svg { width: 18px; height: 18px; color: #D9971A; flex-shrink: 0; margin-top: 1px; }
  .invoice-notice__text { font-size: 13px; color: #6F4D14; line-height: 1.6; }
  .invoice-notice__text b { color: #A8731A; display: block; margin-bottom: 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }

  .totals-disclaimer {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-top: 12px;
    font-size: 11.5px;
    color: #9FACA4;
    line-height: 1.5;
  }
  .totals-disclaimer svg { width: 14px; height: 14px; flex-shrink: 0; margin-top: 1px; }

  /* ── Delivery banner ── */
  .delivery-banner {
    background: #E6FBF4;
    border: 1.5px solid #C2F5E4;
    border-radius: 12px;
    padding: 14px 18px;
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 28px;
  }
  .delivery-banner__icon {
    width: 40px; height: 40px;
    background: #06D6A0;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .delivery-banner__icon svg { width: 20px; height: 20px; color: #0A3D2E; }
  .delivery-banner__text { flex: 1; }
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
  .email-footer__links {
    display: flex;
    justify-content: center;
    gap: 20px;
    flex-wrap: wrap;
  }
  .email-footer__links a {
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
    <h1>Order received, ${firstName}!</h1>
    <p>Thanks for your order. Our team is reviewing it and will confirm your delivery details shortly. A copy of this email has been sent to <b>${email}</b>.</p>
  </div>

  <!-- ── META CHIPS ── -->
  <div class="email-meta">
    <div class="email-meta__chip">
      <span class="email-meta__label">Order</span>
      <span class="email-meta__val">${order.name || '#—'}</span>
    </div>
    <div class="email-meta__sep"></div>
    <div class="email-meta__chip">
      <span class="email-meta__label">Date</span>
      <span class="email-meta__val">${orderDate}</span>
    </div>
    <div class="email-meta__sep"></div>
    <div class="email-meta__chip">
      <span class="email-meta__label">Items</span>
      <span class="email-meta__val">${totalQty} items</span>
    </div>
    <div class="email-meta__sep"></div>
    <div class="email-meta__chip">
      <span class="email-meta__label">Est. delivery</span>
      <span class="email-meta__val">3–5 business days</span>
    </div>
  </div>

  <!-- ── BODY ── -->
  <div class="email-body">

    ${deliveryBannerHtml}

    <!-- 1. Items -->
    <div class="email-sec">
      <div class="sec-head">
        <div class="sec-head__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
        </div>
        <h2>Your order · ${totalQty} items</h2>
      </div>
      ${lineItemsHtml}
    </div>

    <!-- 2. Delivery address + Payment method -->
    <div class="email-sec">
      <div class="sec-head">
        <div class="sec-head__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
        </div>
        <h2>Delivery &amp; Payment</h2>
      </div>
      <div class="info-card">
        <div class="info-card__row">
          <div class="info-card__col">
            <div class="info-card__label">Delivery address</div>
            <div class="info-card__val">
              <b>${firstName} ${lastName}</b><br>
              ${addr.address1 || ''}<br>
              ${address2Html}${cityProvZip}<br>
              ${addr.country || ''}<br>
              ${phoneHtml}
            </div>
          </div>
          <div class="info-card__sep"></div>
          <div class="info-card__col">
            <div class="info-card__label">Payment method</div>
            <div class="info-card__val">
              <b>${resolvedPayment}</b><br>
              ${payChipHtml}
            </div>
          </div>
        </div>
      </div>
    </div>

    ${deliveryInstructionsHtml}

    <!-- 4. Order totals -->
    <div class="email-sec">
      <div class="sec-head">
        <div class="sec-head__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        </div>
        <h2>Estimated totals</h2>
      </div>

      <div class="totals-row">
        <span>Subtotal · ${totalQty} items</span>
        <b>${formatCurrency(order.subtotal_price)}</b>
      </div>
      ${shippingRowHtml}

      <div class="totals-grand">
        <div class="totals-grand__label">
          Est. total
          <span>Prices confirmed on invoice</span>
        </div>
        <div class="totals-grand__amt">~${formatCurrency(order.total_price)}</div>
      </div>

      <div class="invoice-notice">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <div class="invoice-notice__text"><b>Final amount confirmed on invoice</b>The totals above are estimates. Your formal invoice — with the confirmed final amount — will be sent when your order ships. No payment is taken now.</div>
      </div>

      <div class="totals-disclaimer">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        Prices are estimates based on recent supplier costs and may be adjusted slightly on your invoice. No payment is taken at this stage — you'll receive a formal invoice with the final total when your order ships.
      </div>
    </div>

  </div>

  <!-- ── FOOTER ── -->
  <div class="email-footer">
    <div class="email-footer__logo">AIG<span>O</span> Sunshine Fresh</div>
    <p>Wholesale Asian groceries, fresh produce &amp; bubble-tea supplies.<br>Fresh you can see — and taste.</p>
    <div class="email-footer__links">
      <a href="#">Track order</a>
      <a href="#">View order online</a>
      <a href="#">Contact support</a>
      <a href="#">Unsubscribe</a>
    </div>
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
