/**
 * Server-rendered mobile UI for the Pickup Assistant Draft Orders tab (G19).
 * All state (weights, resolved items, cost/price edits, completed orders) lives
 * client-side in memory for the duration of the session — no background polling,
 * no auth. Changes are batched and sent in a single PUT /pickup/complete call.
 */

export function renderPickupPage() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pickup Assistant</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; margin: 0; padding: 16px; background: #f5f5f5; }
  h1 { font-size: 18px; }
  .card { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.15); }
  .card h2 { margin: 0 0 4px; font-size: 16px; }
  .order-time { font-size: 12px; color: #888; margin-bottom: 8px; }
  .line-item { border-top: 1px solid #eee; padding: 12px 0; }
  .line-item:first-child { border-top: none; }
  .line-item.resolved { opacity: 0.6; }
  .li-title { font-size: 15px; font-weight: 500; }
  .li-stat { font-size: 13px; color: #555; margin-top: 2px; }
  .confirmed { color: #16a34a; font-weight: 600; }
  .btn { padding: 8px 14px; border-radius: 6px; border: none; margin-right: 6px; margin-top: 6px; font-size: 14px; cursor: pointer; }
  .btn-found { background: #22c55e; color: #fff; }
  .btn-partial { background: #eab308; color: #fff; }
  .btn-remove { background: #ef4444; color: #fff; }
  .btn-complete { background: #2563eb; color: #fff; width: 100%; padding: 14px; font-size: 16px; margin-top: 12px; border: none; border-radius: 6px; cursor: pointer; }
  .btn-complete:disabled { background: #ccc; cursor: default; }
  .btn-print { background: #6b21a8; color: #fff; width: 100%; padding: 14px; font-size: 16px; margin-top: 8px; border: none; border-radius: 6px; cursor: pointer; }
  .btn-update-cp { background: #7c3aed; color: #fff; }
  .btn-update-w { background: #0284c7; color: #fff; }
  input[type=number] { width: 70px; padding: 6px; font-size: 14px; margin-right: 6px; }
  .toggle label { margin-right: 12px; font-size: 13px; }
  .weight-row { margin-top: 6px; }
  .panel { background: #f9f9f9; border: 1px solid #e5e5e5; border-radius: 6px; padding: 12px; margin-top: 8px; }
  .panel label { font-size: 13px; display: block; margin-bottom: 4px; margin-top: 8px; }
  .panel label:first-child { margin-top: 0; }
  .suggestions { font-size: 12px; color: #888; margin: 6px 0; line-height: 1.6; }
  .margin-result { font-size: 13px; color: #16a34a; margin-left: 8px; font-weight: 600; }
  .order-summary { border-top: 2px solid #e5e5e5; padding-top: 10px; margin-top: 10px; font-size: 14px; }
  .order-summary div { margin-top: 4px; }
  .progress { padding: 12px; background: #fffbeb; border-radius: 6px; margin-top: 8px; font-size: 14px; }
  .result-success { color: #16a34a; margin-top: 8px; font-weight: 600; }
  .result-mixed { color: #16a34a; margin-top: 8px; font-weight: 600; }
  .result-failed { color: #dc2626; margin-top: 4px; font-weight: 600; }
  .result-contact { color: #dc2626; font-size: 13px; margin-top: 4px; }
</style>
</head>
<body>
  <h1>Pickup Assistant — Draft Orders</h1>
  <div id="orders">Loading…</div>

<script>
var state = {};

// ─── helpers ───────────────────────────────────────────────────────────────

function el(tag, className, html) {
  var e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function fmt(val) {
  var n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function fmtMoney(n) {
  return '$' + n.toFixed(2);
}

function calcMarginPct(price, cost) {
  var p = fmt(price), c = fmt(cost);
  if (p === null || c === null || p === 0) return null;
  return ((p - c) / p * 100);
}

function suggestedPrice(cost, pct) {
  var c = fmt(cost);
  if (c === null) return null;
  return c / (1 - pct / 100);
}

function formatTimestamp(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d)) return iso;
  var year = d.getFullYear();
  var month = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  var hours = d.getHours();
  var mins = String(d.getMinutes()).padStart(2, '0');
  var ampm = hours >= 12 ? 'PM' : 'AM';
  var h12 = hours % 12 || 12;
  return year + '-' + month + '-' + day + ' ' + h12 + ':' + mins + ' ' + ampm;
}

// ─── state management ──────────────────────────────────────────────────────

function getItemState(orderId, li) {
  var order = state[orderId];
  if (!order.items[li.id]) {
    order.items[li.id] = {
      // existing fields
      resolved: false,
      resolvedType: null,
      hasWeight: !!li.has_weight_tag,
      bulk: false,
      weightCount: li.quantity,
      weights: [''],
      quantity: li.quantity,
      unitPrice: li.price,
      resolvedQuantity: null,
      weightExpanded: false,
      confirmedWeights: null,
      // new fields
      costPriceExpanded: false,
      costPriceConfirmed: false,
      newCost: null,
      newPrice: null,
      currentCost: li.cost !== undefined ? li.cost : null,
      currentPrice: li.price,
      inventoryItemId: li.inventory_item_id || null,
      productId: li.product_id || null,
      variantId: li.variant_id || null,
    };
  }
  return order.items[li.id];
}

function allResolved(orderId) {
  var items = state[orderId].items;
  for (var id in items) {
    if (!items[id].resolved) return false;
  }
  return true;
}

// ─── data loading ──────────────────────────────────────────────────────────

async function loadData() {
  var res = await fetch('/pickup/data');
  var data = await res.json();
  var orders = data.draft_orders || [];
  orders.forEach(function (order) {
    if (!state[order.id]) {
      state[order.id] = {
        items: {},
        completed: false,
        completing: false,
        realOrderId: null,
        results: [],
        progress: null,
        order: order,
      };
    } else {
      state[order.id].order = order;
    }
    order.line_items.forEach(function (li) { getItemState(order.id, li); });
  });
  render(orders);
}

// ─── client-side actions (no fetch) ────────────────────────────────────────

function saveWeight(orderId, li, itemState) {
  var weights;
  if (itemState.bulk) {
    var w = parseFloat(itemState.weights[0]);
    if (isNaN(w) || w <= 0) return;
    weights = [w];
  } else {
    weights = itemState.weights
      .slice(0, itemState.quantity)
      .filter(function (w) { return w !== '' && !isNaN(Number(w)); })
      .map(Number);
    if (weights.length === 0) return;
  }
  itemState.resolved = true;
  itemState.resolvedType = 'weight';
  itemState.confirmedWeights = weights;
  itemState.weightExpanded = false;
  rerender();
}

function markResolved(orderId, li, itemState, type, quantity) {
  itemState.resolved = true;
  itemState.resolvedType = type;
  if (type === 'partial') itemState.resolvedQuantity = quantity;
  rerender();
}

function confirmCostPrice(orderId, li, itemState, newCost, newPrice) {
  itemState.newCost = (newCost !== '' && newCost !== null && !isNaN(parseFloat(newCost))) ? parseFloat(newCost) : null;
  itemState.newPrice = (newPrice !== '' && newPrice !== null && !isNaN(parseFloat(newPrice))) ? parseFloat(newPrice) : null;
  itemState.costPriceConfirmed = true;
  itemState.costPriceExpanded = false;
  rerender();
}

function rerender() {
  var orders = Object.keys(state).map(function (id) { return state[id].order; });
  render(orders);
}

// ─── complete order (batched) ───────────────────────────────────────────────

async function completeOrder(order) {
  var changes = [];
  var items = state[order.id].items;

  for (var id in items) {
    var item = items[id];
    var li = order.line_items.find(function (l) { return String(l.id) === String(id); });
    if (!li) continue;

    // cost/price changes
    if (item.costPriceConfirmed && (item.newCost !== null || item.newPrice !== null)) {
      changes.push({
        line_item_id: Number(id),
        title: li.title,
        type: 'cost_price',
        cost: item.newCost,
        price: item.newPrice,
        product_id: item.productId,
        inventory_item_id: item.inventoryItemId,
        current_cost: item.currentCost,
        current_price: item.currentPrice,
      });
    }

    // weight / found / partial / remove
    if (item.resolved && item.resolvedType) {
      var change = { line_item_id: Number(id), title: li.title, type: item.resolvedType };
      if (item.resolvedType === 'weight') {
        change.weights = item.confirmedWeights;
        change.unit_price = item.currentPrice;
      }
      if (item.resolvedType === 'partial') {
        change.quantity = item.resolvedQuantity;
      }
      changes.push(change);
    }
  }

  // show progress while request is in flight
  state[order.id].completing = true;
  state[order.id].progress = { current: 0, total: changes.length };
  rerender();

  try {
    var res = await fetch('/pickup/complete', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_order_id: order.id, changes: changes }),
    });
    var data = await res.json();
    state[order.id].completing = false;
    state[order.id].completed = data.all_succeeded;
    state[order.id].realOrderId = data.order_id || null;
    state[order.id].results = data.results || [];
  } catch (err) {
    state[order.id].completing = false;
    state[order.id].results = [{ success: false, title: 'Network error: ' + err.message }];
    state[order.id].completed = false;
  }
  rerender();
}

// ─── weight panel ──────────────────────────────────────────────────────────

function buildWeightPanel(orderId, li, itemState) {
  var panel = el('div', 'panel');

  var toggle = el('div', 'toggle');
  toggle.innerHTML =
    '<label><input type="radio" name="mode-' + li.id + '"' + (!itemState.bulk ? ' checked' : '') + '> Per-Item</label>' +
    '<label><input type="radio" name="mode-' + li.id + '"' + (itemState.bulk ? ' checked' : '') + '> Bulk</label>';
  var radios = toggle.querySelectorAll('input');
  radios[0].addEventListener('change', function () {
    itemState.bulk = false;
    itemState.weights = new Array(itemState.quantity).fill('');
    rerender();
  });
  radios[1].addEventListener('change', function () {
    itemState.bulk = true;
    itemState.weights = [''];
    rerender();
  });
  panel.appendChild(toggle);

  var row = el('div', 'weight-row');
  if (itemState.bulk) {
    var input = document.createElement('input');
    input.type = 'number'; input.step = '0.01'; input.placeholder = 'Total lbs';
    input.value = itemState.weights[0] || '';
    input.addEventListener('input', function (e) { itemState.weights[0] = e.target.value; });
    row.appendChild(input);
  } else {
    for (var i = 0; i < itemState.quantity; i++) {
      (function (idx) {
        var input = document.createElement('input');
        input.type = 'number'; input.step = '0.01'; input.placeholder = 'lb #' + (idx + 1);
        input.value = itemState.weights[idx] || '';
        input.addEventListener('input', function (e) { itemState.weights[idx] = e.target.value; });
        row.appendChild(input);
      })(i);
    }
  }
  panel.appendChild(row);

  var confirmBtn = el('button', 'btn btn-found', 'Confirm Weight');
  confirmBtn.addEventListener('click', function () { saveWeight(orderId, li, itemState); });
  panel.appendChild(confirmBtn);

  return panel;
}

// ─── cost/price panel ──────────────────────────────────────────────────────

function buildCostPricePanel(orderId, li, itemState) {
  var panel = el('div', 'panel');

  // cost input
  var costLabel = el('label', null, 'Cost:');
  var costInput = document.createElement('input');
  costInput.type = 'number'; costInput.step = '0.01';
  costInput.value = itemState.newCost !== null ? itemState.newCost : (itemState.currentCost !== null ? itemState.currentCost : '');
  costInput.placeholder = '0.00';
  costLabel.appendChild(costInput);
  panel.appendChild(costLabel);

  // suggested prices
  var sugg = el('div', 'suggestions', 'Suggested prices:');
  var suggLines = el('div');
  function updateSuggestions() {
    var c = costInput.value;
    var lines = [25, 20, 15].map(function (pct) {
      var sp = suggestedPrice(c, pct);
      return pct + '% margin: ' + (sp !== null ? fmtMoney(sp) : 'N/A');
    });
    suggLines.innerHTML = lines.join('<br>');
  }
  costInput.addEventListener('input', updateSuggestions);
  updateSuggestions();
  sugg.appendChild(suggLines);
  panel.appendChild(sugg);

  // price input
  var priceLabel = el('label', null, 'Price:');
  var priceInput = document.createElement('input');
  priceInput.type = 'number'; priceInput.step = '0.01';
  priceInput.value = itemState.newPrice !== null ? itemState.newPrice : (itemState.currentPrice || '');
  priceInput.placeholder = '0.00';
  priceLabel.appendChild(priceInput);
  panel.appendChild(priceLabel);

  // calculate margin row
  var calcRow = el('div');
  calcRow.style.marginTop = '8px';
  var calcBtn = el('button', 'btn', 'Calculate Margin');
  var marginSpan = el('span', 'margin-result');
  calcBtn.addEventListener('click', function () {
    var m = calcMarginPct(priceInput.value, costInput.value);
    marginSpan.textContent = m !== null ? 'Margin: ' + m.toFixed(1) + '%' : 'N/A';
  });
  calcRow.appendChild(calcBtn);
  calcRow.appendChild(marginSpan);
  panel.appendChild(calcRow);

  // confirm button
  var confirmBtn = el('button', 'btn btn-update-cp', 'Confirm');
  confirmBtn.style.marginTop = '8px';
  confirmBtn.addEventListener('click', function () {
    confirmCostPrice(orderId, li, itemState, costInput.value, priceInput.value);
  });
  panel.appendChild(confirmBtn);

  return panel;
}

// ─── order summary ─────────────────────────────────────────────────────────

function buildOrderSummary(order, orderState) {
  var summary = el('div', 'order-summary');
  var anyNullCost = false;
  var totalCost = 0;
  var totalPrice = 0;

  order.line_items.forEach(function (li) {
    var item = orderState.items[li.id];
    var qty = (item && item.resolvedType === 'partial' && item.resolvedQuantity !== null)
      ? item.resolvedQuantity
      : li.quantity;

    var effectivePrice = (item && item.newPrice !== null) ? item.newPrice : parseFloat(li.price || 0);
    totalPrice += effectivePrice * qty;

    if (item && item.newCost !== null) {
      totalCost += item.newCost * qty;
    } else if (li.cost !== null && li.cost !== undefined) {
      var c = parseFloat(li.cost);
      if (!isNaN(c)) {
        totalCost += c * qty;
      } else {
        anyNullCost = true;
      }
    } else {
      anyNullCost = true;
    }
  });

  var costStr = anyNullCost ? 'N/A' : fmtMoney(totalCost);
  var marginStr = anyNullCost || totalPrice === 0
    ? 'N/A'
    : fmtMoney(totalPrice - totalCost) + ' (' + ((totalPrice - totalCost) / totalPrice * 100).toFixed(1) + '%)';

  summary.appendChild(el('div', null, 'Order Cost:   ' + costStr));
  summary.appendChild(el('div', null, 'Order Total:  ' + fmtMoney(totalPrice)));
  summary.appendChild(el('div', null, 'Order Margin: ' + marginStr));
  return summary;
}

// ─── main render ────────────────────────────────────────────────────────────

function render(orders) {
  var root = document.getElementById('orders');
  root.innerHTML = '';

  if (orders.length === 0) {
    root.appendChild(el('div', 'card', 'No open draft orders tagged draft-order-tab.'));
    return;
  }

  orders.forEach(function (order) {
    var orderState = state[order.id];
    var card = el('div', 'card');

    // ── card header ──
    card.appendChild(el('h2', null, order.name + (order.customer_name ? ' — ' + order.customer_name : '')));
    if (order.created_at) {
      card.appendChild(el('div', 'order-time', formatTimestamp(order.created_at)));
    }

    // ── line items ──
    order.line_items.forEach(function (li) {
      var itemState = getItemState(order.id, li);
      var row = el('div', 'line-item' + (itemState.resolved ? ' resolved' : ''));

      // title
      row.appendChild(el('div', 'li-title',
        li.title + (li.variant_title ? ' (' + li.variant_title + ')' : '') + ' — qty: ' + li.quantity));

      // confirmed weights (green)
      if (itemState.confirmedWeights) {
        row.appendChild(el('div', 'li-stat confirmed',
          'Weight: ' + itemState.confirmedWeights.join(', ') + ' lb'));
      }

      // price / cost / margin display
      var effectivePrice = itemState.newPrice !== null ? itemState.newPrice : parseFloat(li.price || 0);
      var effectiveCost = itemState.newCost !== null ? itemState.newCost : (li.cost !== null && li.cost !== undefined ? parseFloat(li.cost) : null);
      var priceClass = itemState.costPriceConfirmed ? 'li-stat confirmed' : 'li-stat';
      var costClass = priceClass;
      var marginClass = priceClass;

      row.appendChild(el('div', priceClass, 'Price:  ' + fmtMoney(effectivePrice)));

      if (effectiveCost !== null && !isNaN(effectiveCost)) {
        row.appendChild(el('div', costClass, 'Cost:   ' + fmtMoney(effectiveCost)));
        var m = calcMarginPct(effectivePrice, effectiveCost);
        if (m !== null) {
          row.appendChild(el('div', marginClass, 'Margin: ' + m.toFixed(1) + '%'));
        }
      } else {
        row.appendChild(el('div', 'li-stat', 'Cost:   N/A'));
      }

      // ── action buttons ──
      var btnRow = el('div');

      // "Update Cost & Price" toggle button
      var cpBtn = el('button', 'btn btn-update-cp', 'Update Cost & Price');
      cpBtn.addEventListener('click', function () {
        itemState.costPriceExpanded = !itemState.costPriceExpanded;
        rerender();
      });
      btnRow.appendChild(cpBtn);

      // "Update Weight" toggle button (weight items only, and only if not yet resolved as weight)
      if (itemState.hasWeight && !itemState.resolved) {
        var wBtn = el('button', 'btn btn-update-w', 'Update Weight');
        wBtn.addEventListener('click', function () {
          itemState.weightExpanded = !itemState.weightExpanded;
          rerender();
        });
        btnRow.appendChild(wBtn);
      } else if (itemState.hasWeight && itemState.resolved) {
        // keep button visible so user can re-expand if needed
        var wBtnDone = el('button', 'btn btn-update-w', 'Update Weight');
        wBtnDone.addEventListener('click', function () {
          itemState.weightExpanded = !itemState.weightExpanded;
          rerender();
        });
        btnRow.appendChild(wBtnDone);
      }

      row.appendChild(btnRow);

      // non-weight items: Found / Partial / Removed (if not yet resolved)
      if (!itemState.hasWeight) {
        var actionRow = el('div');
        if (!itemState.resolved) {
          var foundBtn = el('button', 'btn btn-found', 'Found It');
          foundBtn.addEventListener('click', function () { markResolved(order.id, li, itemState, 'found'); });
          var partialBtn = el('button', 'btn btn-partial', 'Partial');
          partialBtn.addEventListener('click', function () {
            var qty = prompt('Quantity found:', li.quantity);
            if (qty === null) return;
            markResolved(order.id, li, itemState, 'partial', Number(qty));
          });
          var removeBtn = el('button', 'btn btn-remove', 'Removed');
          removeBtn.addEventListener('click', function () { markResolved(order.id, li, itemState, 'remove'); });
          actionRow.appendChild(foundBtn);
          actionRow.appendChild(partialBtn);
          actionRow.appendChild(removeBtn);
        } else {
          actionRow.appendChild(el('span', 'li-stat', '✓ ' + (itemState.resolvedType || 'resolved')));
        }
        row.appendChild(actionRow);
      }

      // ── expanded panels ──
      if (itemState.costPriceExpanded) {
        row.appendChild(buildCostPricePanel(order.id, li, itemState));
      }
      if (itemState.weightExpanded) {
        row.appendChild(buildWeightPanel(order.id, li, itemState));
      }

      card.appendChild(row);
    });

    // ── order summary ──
    card.appendChild(buildOrderSummary(order, orderState));

    // ── complete / progress / results ──
    if (orderState.completing) {
      card.appendChild(el('div', 'progress', '⏳ Updating… please wait'));
    } else if (orderState.completed !== false && orderState.results.length > 0) {
      var allOk = orderState.results.every(function (r) { return r.success; });
      if (allOk) {
        card.appendChild(el('div', 'result-success', '✅ All ' + orderState.results.length + ' items updated successfully.'));
        var printBtn = el('button', 'btn-print', 'Print Invoice');
        printBtn.addEventListener('click', function () {
          if (orderState.realOrderId) window.open('/invoice/' + orderState.realOrderId, '_blank');
        });
        card.appendChild(printBtn);
      } else {
        var succeeded = orderState.results.filter(function (r) { return r.success; }).length;
        var failed = orderState.results.filter(function (r) { return !r.success; });
        card.appendChild(el('div', 'result-mixed', '✅ ' + succeeded + '/' + orderState.results.length + ' items updated'));
        card.appendChild(el('div', 'result-failed', '❌ Failed: ' + failed.map(function (r) { return r.title; }).join(', ')));
        card.appendChild(el('div', 'result-contact', 'Please contact Technical Staff.'));
      }
    } else {
      var completeBtn = el('button', 'btn-complete',
        orderState.completed ? 'Completed ✓' : 'Complete Order');
      completeBtn.disabled = !!orderState.completed || !allResolved(order.id);
      completeBtn.addEventListener('click', function () { completeOrder(order); });
      card.appendChild(completeBtn);
    }

    root.appendChild(card);
  });
}

loadData();
</script>
</body>
</html>`;
}
