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
  body { font-family: Arial, Helvetica, sans-serif; color: #111; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .meta { color: #555; font-size: 13px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { border-bottom: 1px solid #ccc; padding: 8px; text-align: left; font-size: 13px; vertical-align: top; }
  .weight-note { font-size: 11px; color: #555; }
  .invoice-footer-row { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 24px; }
  .summary { width: 260px; flex-shrink: 0; }
  .summary td { border: none; padding: 4px 8px; }
  .signature { flex: 1; padding-right: 32px; }
  .signature-line { border-top: 1px solid #333; width: 260px; margin-top: 40px; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .invoice-footer { page-break-inside: avoid; }
  .page-block { page-break-after: always; }
  .page-block:last-child { page-break-after: auto; }
  .print-btn { margin-bottom: 16px; }
  @media print {
    .no-print { display: none; }
  }
</style>
</head>
<body>
  <div class="no-print" style="margin-bottom:12px;display:flex;align-items:center;gap:12px;">
    <button class="print-btn" onclick="window.print()" style="margin:0;">Print</button>
    <span style="font-size:12px;color:#888;">Tip: In the print dialog, uncheck <strong>Headers and footers</strong> to hide the browser URL and page numbers.</span>
  </div>
  <div id="invoice-header" style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
    <div>
      <h1 style="margin:0 0 4px;">Invoice — ${escapeHtml(order.name)}</h1>
      <div class="meta">Order date: ${escapeHtml(order.created_at)}</div>
    </div>
    <div style="text-align:right;font-size:13px;line-height:1.6;">
      <strong>AIGO L.L.C.</strong><br>
      info@my-aigo.com<br>
      240-602-4225<br>
      <span style="color:#555;">Place order at: www.my-aigo.com</span><br>
      <span id="page-label"></span>
    </div>
  </div>
  <p id="customer-block">
    ${escapeHtml(shipping.first_name)} ${escapeHtml(shipping.last_name)}<br>
    ${escapeHtml(shipping.address1)} ${escapeHtml(shipping.address2)}<br>
    ${escapeHtml(shipping.city)}, ${escapeHtml(shipping.province)} ${escapeHtml(shipping.zip)}<br>
    ${escapeHtml(shipping.phone)}
  </p>

  <table>
    <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Line Total</th></tr></thead>
    <tbody id="line-items-body">${lineItemsHtml}</tbody>
  </table>

  <div class="invoice-footer">
    <div class="invoice-footer-row">
      <div class="signature">
        <div class="signature-line"></div>
        <div>Customer Signature</div>
      </div>
      <table class="summary">
        <tr><td>Subtotal</td><td>$${escapeHtml(order.subtotal_price || '0.00')}</td></tr>
        <tr><td>Delivery</td><td>$${escapeHtml(deliveryFee)}</td></tr>
        <tr><td>Tax</td><td>$${escapeHtml(order.total_tax || '0.00')}</td></tr>
        <tr><td><strong>Total</strong></td><td><strong>$${escapeHtml(order.total_price || '0.00')}</strong></td></tr>
      </table>
    </div>
  </div>

<script>
(function () {
  // Usable page height in CSS px.
  // Full page: 11in × 96dpi = 1056px. Margins: 0.5in × 2 = 96px → content area = 960px.
  // Chrome's default "Headers and footers" consume ~80px, and narrow print width (720px)
  // causes text to wrap more than at screen width, making rows taller than measured.
  // We use 820px (≈85% of 960px) as a conservative threshold to prevent overflow.
  var PAGE_H = 820;
  var THEAD_HTML = '<thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Line Total</th></tr></thead>';

  var savedBodyHTML = null;

  function buildPageHeader(orderName, orderDate, companyHtml, pageNum, totalPages) {
    return '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">'
      + '<div>'
      + '<h1 style="margin:0 0 4px;">' + orderName + '</h1>'
      + '<div class="meta">' + orderDate + '</div>'
      + '</div>'
      + '<div style="text-align:right;font-size:13px;line-height:1.6;">'
      + companyHtml
      + '<strong>Page ' + pageNum + ' of ' + totalPages + '</strong>'
      + '</div>'
      + '</div>';
  }

  function paginate() {
    var rows = Array.from(document.querySelectorAll('#line-items-body tr'));
    if (rows.length === 0) return;

    var headerH = document.getElementById('invoice-header').getBoundingClientRect().height;
    var customerH = document.getElementById('customer-block').getBoundingClientRect().height;
    var theadH = document.querySelector('thead').getBoundingClientRect().height;
    var footerH = document.querySelector('.invoice-footer').getBoundingClientRect().height;
    // Add 20% to each row height to compensate for text wrapping at print width (720px)
    // being tighter than the screen width where we measure.
    var rowHeights = rows.map(function (r) { return r.getBoundingClientRect().height * 1.2; });

    // Check if content fits on one page (account for footer on single page)
    var totalH = headerH + customerH + theadH + footerH;
    for (var i = 0; i < rowHeights.length; i++) totalH += rowHeights[i];
    if (totalH <= PAGE_H) {
      // Single page — just update the page label
      document.getElementById('page-label').textContent = 'Page 1 of 1';
      return;
    }

    // Capture content we'll need to rebuild
    var orderName = document.querySelector('#invoice-header h1').innerHTML;
    var orderDate = document.querySelector('#invoice-header .meta').innerHTML;
    var companyHtml = 'AIGO L.L.C.<br>info@my-aigo.com<br>240-602-4225<br>'
      + '<span style="color:#555;">Place order at: www.my-aigo.com</span><br>';
    var customerHtml = document.getElementById('customer-block').outerHTML;
    var footerHtml = document.querySelector('.invoice-footer').outerHTML;
    var rowHtmls = rows.map(function (r) { return r.outerHTML; });

    // Assign rows to pages
    var pages = []; // array of row-index arrays
    var currentPage = [];
    // Page 1 starts with header + customer + thead already consuming space
    var usedH = headerH + customerH + theadH;

    for (var j = 0; j < rowHeights.length; j++) {
      var rh = rowHeights[j];
      var isLastRow = j === rowHeights.length - 1;
      // Reserve footer space when placing the last row
      var reserve = isLastRow ? footerH : 0;

      if (currentPage.length > 0 && usedH + rh + reserve > PAGE_H) {
        pages.push(currentPage);
        currentPage = [j];
        usedH = theadH + rh;
      } else {
        currentPage.push(j);
        usedH += rh;
      }
    }
    if (currentPage.length > 0) pages.push(currentPage);

    var totalPages = pages.length;

    // Build replacement body HTML.
    // All content below comes from DOM nodes that were already server-side escaped
    // via escapeHtml() before this page was rendered — no raw user input enters here.
    savedBodyHTML = document.body.innerHTML;

    var html = '<button class="print-btn no-print" onclick="window.print()">Print</button>';

    for (var p = 0; p < pages.length; p++) {
      var pageNum = p + 1;
      var isLastPage = pageNum === totalPages;

      html += '<div class="page-block">';
      html += buildPageHeader(orderName, orderDate, companyHtml, pageNum, totalPages);

      // Customer block only on first page
      if (p === 0) html += customerHtml;

      // Line items table for this page
      html += '<table>' + THEAD_HTML + '<tbody>';
      var pageRows = pages[p];
      for (var k = 0; k < pageRows.length; k++) {
        html += rowHtmls[pageRows[k]];
      }
      html += '</tbody></table>';

      // Summary + signature only on last page
      if (isLastPage) html += footerHtml;

      html += '</div>';
    }

    document.body.innerHTML = html;
  }

  function restore() {
    if (savedBodyHTML !== null) {
      document.body.innerHTML = savedBodyHTML;
      savedBodyHTML = null;
    }
  }

  window.addEventListener('beforeprint', paginate);
  window.addEventListener('afterprint', restore);
})();
</script>
</body>
</html>`;
}
