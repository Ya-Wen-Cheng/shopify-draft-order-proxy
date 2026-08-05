/**
 * Printable invoice for a real Shopify Order (G19 — /invoice/{order_id})
 * 8.5x11, signature line, weight-line-item properties rendered.
 */

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function renderInvoiceHtml(order) {
  const tags = (order.tags || '').split(',').map(t => t.trim().toLowerCase());
  const isMember = tags.includes('member');
  const shipping = order.shipping_address || {};
  const shippingLine = (order.shipping_lines || [])[0];
  const deliveryFee = isMember ? '0.00' : (shippingLine ? shippingLine.price : '0.00');

  const lineItemsHtml = (order.line_items || []).map(li => {
    const weightProp = (li.properties || []).find(p => p.name === 'Weight (lb)');
    const breakdownProp = (li.properties || []).find(p => p.name === 'Price Breakdown');
    const lineTotal = (Number(li.price) * Number(li.quantity)).toFixed(2);
    return `
      <tr>
        <td>
          ${escapeHtml(li.title)}${li.variant_title ? ' — ' + escapeHtml(li.variant_title) : ''}
          ${weightProp ? `<div class="weight-note">Weight (lb): ${escapeHtml(weightProp.value)}</div>` : ''}
          ${breakdownProp ? `<div class="weight-note">${escapeHtml(breakdownProp.value)}</div>` : ''}
        </td>
        <td>${li.quantity}</td>
        <td>$${escapeHtml(li.price)}</td>
        <td>$${lineTotal}</td>
      </tr>`;
  }).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Invoice ${escapeHtml(order.name)}</title>
<style>
  @page { size: 8.5in 11in; margin: 0.5in; }
  .page-numbers { display: none; position: fixed; bottom: 0.3in; width: 100%; text-align: center; font-size: 10px; color: #888; }
  @media print { .page-numbers { display: block; } }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .meta { color: #555; font-size: 13px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { border-bottom: 1px solid #ccc; padding: 8px; text-align: left; font-size: 13px; vertical-align: top; }
  .weight-note { font-size: 11px; color: #555; }
  .summary { margin-top: 16px; width: 260px; margin-left: auto; }
  .summary td { border: none; padding: 4px 8px; }
  .signature { margin-top: 60px; }
  .signature-line { border-top: 1px solid #333; width: 300px; margin-top: 40px; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .invoice-footer { page-break-inside: avoid; }
  .print-btn { margin-bottom: 16px; }
  @media print {
    .no-print { display: none; }
  }
</style>
</head>
<body>
  <div class="page-numbers" id="page-numbers"></div>
  <button class="print-btn no-print" onclick="window.print()">Print</button>
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
    <div>
      <h1 style="margin:0 0 4px;">Invoice — ${escapeHtml(order.name)}</h1>
      <div class="meta">Order date: ${escapeHtml(order.created_at)}</div>
    </div>
    <div style="text-align:right;font-size:13px;line-height:1.6;">
      <strong>AIGO L.L.C.</strong><br>
      info@my-aigo.com<br>
      240-602-4225<br>
      <span style="color:#555;">Place order at: www.my-aigo.com</span>
    </div>
  </div>
  <p>
    ${escapeHtml(shipping.first_name)} ${escapeHtml(shipping.last_name)}<br>
    ${escapeHtml(shipping.address1)} ${escapeHtml(shipping.address2)}<br>
    ${escapeHtml(shipping.city)}, ${escapeHtml(shipping.province)} ${escapeHtml(shipping.zip)}<br>
    ${escapeHtml(shipping.phone)}
  </p>

  <table>
    <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Line Total</th></tr></thead>
    <tbody>${lineItemsHtml}</tbody>
  </table>

  <div class="invoice-footer">
    <table class="summary">
      <tr><td>Subtotal</td><td>$${escapeHtml(order.subtotal_price || '0.00')}</td></tr>
      <tr><td>Delivery</td><td>$${deliveryFee}</td></tr>
      <tr><td>Tax</td><td>$${escapeHtml(order.total_tax || '0.00')}</td></tr>
      <tr><td><strong>Total</strong></td><td><strong>$${escapeHtml(order.total_price || '0.00')}</strong></td></tr>
    </table>

    <div class="signature">
      <div class="signature-line"></div>
      <div>Customer Signature</div>
    </div>
  </div>
<script>
  function updatePageNumbers() {
    var body = document.body;
    var html = document.documentElement;
    var pageHeight = 11 * 96 - 2 * 0.5 * 96; // 11in page minus 0.5in top+bottom margins (96dpi)
    var totalHeight = Math.max(body.scrollHeight, body.offsetHeight, html.clientHeight, html.scrollHeight, html.offsetHeight);
    var totalPages = Math.ceil(totalHeight / pageHeight) || 1;
    var el = document.getElementById('page-numbers');
    if (el) el.textContent = 'Page 1 of ' + totalPages;
  }
  window.addEventListener('beforeprint', updatePageNumbers);
</script>
</body>
</html>`;
}
