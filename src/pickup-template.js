/**
 * Server-rendered mobile UI for the Pickup Assistant Draft Orders tab (G19).
 * All state (weights, resolved items, cost/price edits, completed orders) lives
 * client-side in memory for the duration of the session — no background polling,
 * no auth. Changes are batched and sent in a single PUT /pickup/complete call.
 *
 * Views:
 *   list   — homepage: date/stats header + one summary card per draft order
 *   detail — full editing UI for a single open order (or read-only for completed)
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
  h1 { font-size: 18px; margin: 0 0 4px; }
  .card { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.15); }
  .card h2 { margin: 0 0 4px; font-size: 16px; }
  .order-time { font-size: 12px; color: #888; margin-bottom: 8px; }
  .line-item { border-top: 1px solid #eee; padding: 12px 0; }
  .line-item:first-child { border-top: none; }
  .btn-reset { background: #9ca3af; color: #fff; }
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
  .result-mixed { color: #d97706; margin-top: 8px; font-weight: 600; }
  .result-failed { color: #dc2626; margin-top: 4px; font-weight: 600; }
  .result-contact { color: #dc2626; font-size: 13px; margin-top: 4px; }
  /* ── list view ── */
  .list-header { margin-bottom: 14px; }
  .list-date { font-size: 13px; color: #555; }
  .list-stats { display: flex; gap: 20px; font-size: 13px; font-weight: 600; margin-top: 4px; }
  .stat-incomplete { color: #d97706; }
  .stat-completed { color: #16a34a; }
  .status-badge { display: inline-block; font-size: 11px; font-weight: 600; border-radius: 4px; padding: 2px 7px; vertical-align: middle; margin-left: 6px; }
  .badge-incomplete { background: #fef3c7; color: #b45309; }
  .badge-completed { background: #dcfce7; color: #15803d; }
  .badge-printed { background: #ede9fe; color: #7c3aed; }
  .list-card { cursor: pointer; }
  .list-card:active { opacity: 0.85; }
  .btn-back { background: #6b7280; color: #fff; margin-bottom: 12px; }
  .btn-print-list { background: #6b21a8; color: #fff; padding: 8px 14px; font-size: 13px; border: none; border-radius: 6px; cursor: pointer; margin-top: 8px; display: block; width: 100%; position: relative; z-index: 2; }
  .progress-bar-wrap { background: #e5e7eb; border-radius: 4px; height: 8px; margin-top: 10px; overflow: hidden; }
  .progress-bar-fill { height: 100%; background: #2563eb; border-radius: 4px; width: 0%; }
  .progress-bar-fill.loading { animation: progress-loading 1.5s ease-in-out forwards; }
  .progress-bar-fill.done { width: 100%; transition: width 0.3s ease-out; }
  @keyframes progress-loading { 0% { width: 0%; } 100% { width: 80%; } }
  /* ── confirm modal ── */
  .modal-backdrop { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.4); z-index: 200; display: flex; align-items: center; justify-content: center; }
  .modal-box { background: #fff; border-radius: 12px; padding: 24px 20px; margin: 16px; max-width: 320px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.2); }
  .modal-msg { font-size: 15px; color: #111; margin-bottom: 20px; line-height: 1.5; }
  .modal-success-icon { font-size: 48px; text-align: center; margin-bottom: 12px; }
  .modal-actions { display: flex; gap: 10px; }
  .btn-modal-confirm { flex: 1; background: #22c55e; color: #fff; border: none; border-radius: 6px; padding: 12px; font-size: 15px; font-weight: 600; cursor: pointer; }
  .btn-modal-cancel { flex: 1; background: #e5e7eb; color: #374151; border: none; border-radius: 6px; padding: 12px; font-size: 15px; cursor: pointer; }
</style>
</head>
<body>
  <div id="app">Loading…</div>

<script>
var state = {};
var currentView = 'list';
var selectedOrderId = null;
var printedOrders = {};
var SESSION_VIEW_KEY = 'pickup_view_order';

// Restore view from sessionStorage on load/refresh
(function () {
  var saved = sessionStorage.getItem(SESSION_VIEW_KEY);
  if (saved) { selectedOrderId = Number(saved); currentView = 'detail'; }
})();

window.addEventListener('popstate', function () {
  var m = location.hash.match(/^#order-(\d+)$/);
  if (m) {
    selectedOrderId = Number(m[1]); currentView = 'detail';
    sessionStorage.setItem(SESSION_VIEW_KEY, m[1]);
  } else {
    selectedOrderId = null; currentView = 'list';
    sessionStorage.removeItem(SESSION_VIEW_KEY);
  }
  rerender();
});

var STORAGE_KEY = 'pickup_state';
var PRINTED_KEY  = 'pickup_printed';

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

function formatDate(d) {
  var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

// ─── order status helpers ──────────────────────────────────────────────────

function isOrderCompleted(order, orderState) {
  return order.status === 'sourced' || !!(orderState && orderState.completed);
}

function getRealOrderId(order, orderState) {
  if (order.status === 'sourced') return order.id; // real order IS this order
  return order.order_id || (orderState && orderState.realOrderId) || null;
}

function getOrderStatus(order, orderState) {
  if (!isOrderCompleted(order, orderState)) return 'incomplete';
  var realId = getRealOrderId(order, orderState);
  if (realId && printedOrders[order.id]) return 'printed';
  return 'completed';
}

// ─── state management ──────────────────────────────────────────────────────

function getItemState(orderId, li) {
  var order = state[orderId];
  if (!order.items[li.id]) {
    order.items[li.id] = {
      resolved: false,
      resolvedType: null,
      hasWeight: !!li.has_weight_tag,
      weightMode: 'bulk', // 'per_item' | 'same_weight' | 'bulk'
      weightCount: li.quantity,
      weights: [''],
      sameWeightValue: '',
      sameWeightQty: li.quantity,
      quantity: li.quantity,
      unitPrice: li.price,
      resolvedQuantity: null,
      partialExpanded: false,
      weightExpanded: false,
      confirmedWeights: null,
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

function isFullyResolved(itemState) {
  if (!itemState.resolved) return false;
  if (itemState.resolvedType === 'remove') return true; // removed items don't need a cost
  return itemState.currentCost !== null || itemState.newCost !== null;
}

function allResolved(orderId) {
  var items = state[orderId].items;
  var ids = Object.keys(items);
  if (ids.length === 0) return false;
  for (var id in items) {
    if (!isFullyResolved(items[id])) return false;
  }
  return true;
}

// ─── localStorage persistence ──────────────────────────────────────────────

function saveStateToStorage() {
  var toSave = {};
  for (var orderId in state) {
    if (state[orderId].completed) continue; // clear in-session completed orders
    if (state[orderId].order && state[orderId].order.status === 'sourced') continue; // read-only
    var savedItems = {};
    for (var itemId in state[orderId].items) {
      var item = state[orderId].items[itemId];
      savedItems[itemId] = {
        resolved: item.resolved,
        resolvedType: item.resolvedType,
        resolvedQuantity: item.resolvedQuantity,
        weightMode: item.weightMode,
        weights: item.weights,
        sameWeightValue: item.sameWeightValue,
        sameWeightQty: item.sameWeightQty,
        confirmedWeights: item.confirmedWeights,
        costPriceConfirmed: item.costPriceConfirmed,
        newCost: item.newCost,
        newPrice: item.newPrice,
      };
    }
    toSave[orderId] = { items: savedItems };
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave)); } catch (e) {}
}

function loadStateFromStorage() {
  try {
    var saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch (e) { return {}; }
}

function savePrintedOrders() {
  try { localStorage.setItem(PRINTED_KEY, JSON.stringify(printedOrders)); } catch (e) {}
}

function loadPrintedOrders() {
  try {
    var saved = localStorage.getItem(PRINTED_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch (e) { return {}; }
}

function printInvoice(draftOrderId, realOrderId) {
  // Key by both IDs: draft order ID for in-session display, real order ID for after page refresh
  printedOrders[draftOrderId] = true;
  if (realOrderId && realOrderId !== draftOrderId) printedOrders[realOrderId] = true;
  savePrintedOrders();
  window.open('/invoice/' + realOrderId, '_blank');
  rerender();
}

// ─── data loading ──────────────────────────────────────────────────────────

async function loadData() {
  printedOrders = loadPrintedOrders();
  var saved = loadStateFromStorage();
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
        realOrderName: null,
        results: [],
        order: order,
      };
    } else {
      state[order.id].order = order;
    }
    if (order.status === 'sourced') return; // read-only, no item state needed
    var savedOrder = saved[order.id] || {};
    order.line_items.forEach(function (li) {
      var itemState = getItemState(order.id, li);
      var savedItem = savedOrder.items && savedOrder.items[li.id];
      if (savedItem) {
        itemState.resolved = savedItem.resolved || false;
        itemState.resolvedType = savedItem.resolvedType || null;
        itemState.resolvedQuantity = savedItem.resolvedQuantity !== undefined ? savedItem.resolvedQuantity : null;
        // weightMode: new field; fall back from legacy 'bulk' boolean
        itemState.weightMode = savedItem.weightMode || (savedItem.bulk ? 'bulk' : 'per_item');
        itemState.weights = savedItem.weights || [''];
        itemState.sameWeightValue = savedItem.sameWeightValue || '';
        itemState.sameWeightQty = savedItem.sameWeightQty !== undefined ? savedItem.sameWeightQty : itemState.quantity;
        itemState.confirmedWeights = savedItem.confirmedWeights || null;
        itemState.costPriceConfirmed = savedItem.costPriceConfirmed || false;
        itemState.newCost = savedItem.newCost !== undefined ? savedItem.newCost : null;
        itemState.newPrice = savedItem.newPrice !== undefined ? savedItem.newPrice : null;
      }
    });
  });
  render(orders);
}

// ─── client-side actions (no fetch) ────────────────────────────────────────

function saveWeight(orderId, li, itemState) {
  var weights;
  if (itemState.weightMode === 'bulk') {
    var w = parseFloat(itemState.weights[0]);
    if (isNaN(w) || w <= 0) return;
    weights = [w];
  } else if (itemState.weightMode === 'same_weight') {
    var wVal = parseFloat(itemState.sameWeightValue);
    var qty = parseInt(itemState.sameWeightQty, 10);
    if (isNaN(wVal) || wVal <= 0 || isNaN(qty) || qty < 1) return;
    qty = Math.min(qty, li.quantity); // cap at original qty
    weights = Array(qty).fill(wVal);
  } else {
    // per_item
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
  rerender(li.id);
}

function markResolved(orderId, li, itemState, type, quantity) {
  itemState.resolved = true;
  itemState.resolvedType = type;
  if (type === 'partial') itemState.resolvedQuantity = quantity;
  rerender(li.id);
}

function confirmCostPrice(orderId, li, itemState, newCost, newPrice) {
  var parsedCost  = (newCost  !== '' && newCost  !== null && !isNaN(parseFloat(newCost)))  ? parseFloat(newCost)  : null;
  var parsedPrice = (newPrice !== '' && newPrice !== null && !isNaN(parseFloat(newPrice))) ? parseFloat(newPrice) : null;
  // Only treat as changed if the value actually differs from the stored original
  itemState.newCost  = (parsedCost  !== null && parsedCost  !== parseFloat(itemState.currentCost))  ? parsedCost  : null;
  itemState.newPrice = (parsedPrice !== null && parsedPrice !== parseFloat(itemState.currentPrice)) ? parsedPrice : null;
  itemState.costPriceConfirmed = itemState.newCost !== null || itemState.newPrice !== null;
  itemState.costPriceExpanded = false;
  rerender(li.id);
}

function rerender(scrollToItemId) {
  var orders = Object.keys(state).map(function (id) { return state[id].order; });
  render(orders);
  saveStateToStorage();
  if (scrollToItemId) {
    var el = document.querySelector('[data-li-id="' + scrollToItemId + '"]');
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
}

// ─── complete order (batched) ───────────────────────────────────────────────

async function completeOrder(order) {
  var changes = [];
  var items = state[order.id].items;

  for (var id in items) {
    var item = items[id];
    var li = order.line_items.find(function (l) { return String(l.id) === String(id); });
    if (!li) continue;

    // cost/price changes — only push if at least one value actually differs from stored originals
    var costActuallyChanged = item.newCost !== null && parseFloat(item.newCost) !== parseFloat(item.currentCost);
    var priceActuallyChanged = item.newPrice !== null && parseFloat(item.newPrice) !== parseFloat(item.currentPrice);
    if (item.costPriceConfirmed && (costActuallyChanged || priceActuallyChanged)) {
      changes.push({
        line_item_id: Number(id),
        title: li.title,
        type: 'cost_price',
        cost: costActuallyChanged ? String(item.newCost) : null,
        price: priceActuallyChanged ? String(item.newPrice) : null,
        product_id: item.productId,
        inventory_item_id: item.inventoryItemId,
        variant_id: item.variantId,
        current_cost: item.currentCost,
        current_price: item.currentPrice,
      });
    }

    // weight / found / partial / remove
    if (item.resolved && item.resolvedType) {
      var change = { line_item_id: Number(id), title: li.title, type: item.resolvedType };
      if (item.resolvedType === 'weight') {
        change.weights = item.confirmedWeights;
        change.unit_price = item.newPrice !== null ? item.newPrice : item.currentPrice;
      }
      if (item.resolvedType === 'partial') {
        change.quantity = item.resolvedQuantity;
      }
      changes.push(change);
    }
  }

  // show progress while request is in flight
  state[order.id].completing = true;
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
    state[order.id].realOrderName = data.order_name || null;
    state[order.id].results = data.results || [];
    if (data.all_succeeded) {
      var orderLabel = data.order_name || ('#' + data.order_id) || 'Order';
      await showSuccess(orderLabel + ' created successfully!', order.id, data.order_id || null);
    }
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

  var unitPrice = itemState.newPrice !== null ? itemState.newPrice : parseFloat(li.price || 0);
  panel.appendChild(el('div', 'suggestions', 'Price per unit: ' + fmtMoney(unitPrice) + ' — total = weight × this price'));

  // three-way mode toggle
  var toggle = el('div', 'toggle');
  var modes = [
    { value: 'per_item',    label: 'Per-Item' },
    { value: 'same_weight', label: 'Same Weight' },
    { value: 'bulk',        label: 'Bulk' },
  ];
  modes.forEach(function (m) {
    var lbl = document.createElement('label');
    lbl.style.marginRight = '12px';
    lbl.style.fontSize = '13px';
    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'mode-' + li.id;
    radio.checked = itemState.weightMode === m.value;
    radio.addEventListener('change', function () {
      itemState.weightMode = m.value;
      if (m.value === 'per_item') itemState.weights = new Array(itemState.quantity).fill('');
      if (m.value === 'bulk')     itemState.weights = [''];
      rerender();
    });
    lbl.appendChild(radio);
    lbl.appendChild(document.createTextNode(' ' + m.label));
    toggle.appendChild(lbl);
  });
  panel.appendChild(toggle);

  var row = el('div', 'weight-row');

  if (itemState.weightMode === 'bulk') {
    var bulkInput = document.createElement('input');
    bulkInput.type = 'number'; bulkInput.step = '0.01'; bulkInput.placeholder = 'Total lbs';
    bulkInput.value = itemState.weights[0] || '';
    bulkInput.addEventListener('input', function (e) { itemState.weights[0] = e.target.value; });
    row.appendChild(bulkInput);

  } else if (itemState.weightMode === 'same_weight') {
    var swLabel = el('div', null);
    swLabel.style.fontSize = '13px';
    swLabel.style.marginBottom = '4px';
    swLabel.textContent = 'Weight per item (lb):';
    row.appendChild(swLabel);

    var swInput = document.createElement('input');
    swInput.type = 'number'; swInput.step = '0.01'; swInput.placeholder = 'lb each';
    swInput.value = itemState.sameWeightValue || '';
    swInput.addEventListener('input', function (e) { itemState.sameWeightValue = e.target.value; });
    row.appendChild(swInput);

    var qtyLabel = el('div', null);
    qtyLabel.style.fontSize = '13px';
    qtyLabel.style.marginTop = '6px';
    qtyLabel.style.marginBottom = '4px';
    qtyLabel.textContent = 'Quantity found:';
    row.appendChild(qtyLabel);

    var qtyInput = document.createElement('input');
    qtyInput.type = 'number'; qtyInput.min = '1'; qtyInput.max = String(li.quantity);
    qtyInput.placeholder = String(li.quantity);
    qtyInput.value = itemState.sameWeightQty !== '' ? itemState.sameWeightQty : li.quantity;
    qtyInput.addEventListener('input', function (e) { itemState.sameWeightQty = e.target.value; });
    row.appendChild(qtyInput);

  } else {
    // per_item: one input per box
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
  confirmBtn.style.marginTop = '8px';
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

    // Skip removed items
    if (item && item.resolvedType === 'remove') return;

    if (item && item.resolvedType === 'weight' && item.confirmedWeights && item.confirmedWeights.length > 0) {
      // Weight item: price = totalWeight × pricePerLb, qty collapses to 1
      var totalWeight = item.confirmedWeights.reduce(function (s, w) { return s + Number(w); }, 0);
      var pricePerLb = (item.newPrice !== null) ? item.newPrice : parseFloat(li.price || 0);
      totalPrice += totalWeight * pricePerLb;

      var costPerLb = (item.newCost !== null) ? item.newCost
        : (li.cost !== null && li.cost !== undefined) ? parseFloat(li.cost) : null;
      if (costPerLb === null || isNaN(costPerLb)) {
        anyNullCost = true;
      } else {
        totalCost += totalWeight * costPerLb;
      }
    } else {
      // Unit item (or unresolved weight item): use qty × per-unit price
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

// ─── order card (detail view) ──────────────────────────────────────────────

function renderOrderCard(container, order, orderState) {
  var card = el('div', 'card');

  // ── card header ──
  card.appendChild(el('h2', null, order.name + (order.customer_name ? ' — ' + order.customer_name : '')));
  if (order.created_at) {
    card.appendChild(el('div', 'order-time', formatTimestamp(order.created_at)));
  }

  // ── line items ──
  order.line_items.forEach(function (li) {
    var itemState = getItemState(order.id, li);
    var row = el('div', 'line-item' + (isFullyResolved(itemState) ? ' resolved' : ''));
    row.setAttribute('data-li-id', li.id);

    // title
    row.appendChild(el('div', 'li-title',
      li.title + (li.variant_title ? ' (' + li.variant_title + ')' : '')));

    // qty — green variants for partial/remove/same-weight-reduced; plain otherwise
    if (itemState.resolvedType === 'partial' && itemState.resolvedQuantity !== null) {
      row.appendChild(el('div', 'li-stat confirmed', 'Qty: ' + itemState.resolvedQuantity + ' (of ' + li.quantity + ')'));
    } else if (itemState.resolvedType === 'remove') {
      row.appendChild(el('div', 'li-stat confirmed', 'Qty: 0 (of ' + li.quantity + ')'));
    } else if (itemState.confirmedWeights && itemState.weightMode === 'same_weight' && itemState.confirmedWeights.length < li.quantity) {
      row.appendChild(el('div', 'li-stat confirmed', 'Qty: ' + itemState.confirmedWeights.length + ' (of ' + li.quantity + ')'));
    } else {
      row.appendChild(el('div', 'li-stat', 'Qty: ' + li.quantity));
    }

    // confirmed weights (green) — same_weight: show per-item weight + qty change separately
    if (itemState.confirmedWeights) {
      var cw = itemState.confirmedWeights;
      if (itemState.weightMode === 'same_weight') {
        row.appendChild(el('div', 'li-stat confirmed', 'Weight: ' + cw[0] + ' lb'));
      } else {
        var allSame = cw.length > 1 && cw.every(function (w) { return w === cw[0]; });
        var weightStr = allSame
          ? cw[0] + ' lb × ' + cw.length
          : cw.join(', ') + ' lb';
        row.appendChild(el('div', 'li-stat confirmed', 'Weight: ' + weightStr));
      }
    }

    // cost / price / margin — each field turns green only if the driver changed it
    var effectivePrice = itemState.newPrice !== null ? itemState.newPrice : parseFloat(li.price || 0);
    var effectiveCost = itemState.newCost !== null ? itemState.newCost : (li.cost !== null && li.cost !== undefined ? parseFloat(li.cost) : null);
    var costClass  = itemState.newCost  !== null ? 'li-stat confirmed' : 'li-stat';
    var priceClass = itemState.newPrice !== null ? 'li-stat confirmed' : 'li-stat';
    var marginClass = (itemState.newCost !== null || itemState.newPrice !== null) ? 'li-stat confirmed' : 'li-stat';

    if (effectiveCost !== null && !isNaN(effectiveCost)) {
      row.appendChild(el('div', costClass, 'Cost:   ' + fmtMoney(effectiveCost)));
    } else {
      row.appendChild(el('div', 'li-stat', 'Cost:   N/A'));
    }

    row.appendChild(el('div', priceClass, 'Price:  ' + fmtMoney(effectivePrice)));

    if (effectiveCost !== null && !isNaN(effectiveCost)) {
      var m = calcMarginPct(effectivePrice, effectiveCost);
      row.appendChild(el('div', marginClass, 'Margin: ' + (m !== null ? m.toFixed(1) + '%' : 'N/A')));
    } else {
      row.appendChild(el('div', 'li-stat', 'Margin: N/A'));
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

    // "Update Weight" toggle button (weight items only); label changes after resolution
    if (itemState.hasWeight) {
      var wBtn = el('button', 'btn btn-update-w', itemState.resolved ? 'Re-enter Weight' : 'Update Weight');
      wBtn.addEventListener('click', function () {
        itemState.weightExpanded = !itemState.weightExpanded;
        rerender();
      });
      btnRow.appendChild(wBtn);
    }

    row.appendChild(btnRow);

    // non-weight items: Found / Partial / Removed
    if (!itemState.hasWeight) {
      var actionRow = el('div');
      if (itemState.resolved) {
        // show status + Reset
        var statusLabel = '✓ ' + (itemState.resolvedType || 'resolved');
        actionRow.appendChild(el('span', 'li-stat', statusLabel));
        var resetBtn = el('button', 'btn btn-reset', 'Reset');
        resetBtn.style.marginLeft = '8px';
        resetBtn.addEventListener('click', function () {
          itemState.resolved = false;
          itemState.resolvedType = null;
          itemState.resolvedQuantity = null;
          itemState.partialExpanded = false;
          rerender();
        });
        actionRow.appendChild(resetBtn);
      } else if (itemState.partialExpanded) {
        // inline partial quantity input
        var partialInput = document.createElement('input');
        partialInput.type = 'number'; partialInput.min = '1';
        partialInput.max = String(li.quantity - 1);
        partialInput.placeholder = 'Qty found';
        partialInput.style.cssText = 'width:80px;margin-right:6px;';
        var confirmPartialBtn = el('button', 'btn btn-partial', 'Confirm');
        confirmPartialBtn.addEventListener('click', function () {
          var qty = parseInt(partialInput.value, 10);
          if (isNaN(qty) || qty < 1 || qty >= li.quantity) return;
          itemState.partialExpanded = false;
          markResolved(order.id, li, itemState, 'partial', qty);
        });
        var cancelPartialBtn = el('button', 'btn btn-reset', 'Cancel');
        cancelPartialBtn.addEventListener('click', function () {
          itemState.partialExpanded = false;
          rerender();
        });
        actionRow.appendChild(partialInput);
        actionRow.appendChild(confirmPartialBtn);
        actionRow.appendChild(cancelPartialBtn);
      } else {
        // unresolved: show Found / Partial / Removed
        var foundBtn = el('button', 'btn btn-found', 'Found It');
        foundBtn.addEventListener('click', function () { markResolved(order.id, li, itemState, 'found'); });
        var partialBtn = el('button', 'btn btn-partial', 'Partial');
        partialBtn.addEventListener('click', function () {
          itemState.partialExpanded = true;
          rerender();
        });
        var removeBtn = el('button', 'btn btn-remove', 'Remove');
        removeBtn.addEventListener('click', function () { markResolved(order.id, li, itemState, 'remove'); });
        actionRow.appendChild(foundBtn);
        actionRow.appendChild(partialBtn);
        actionRow.appendChild(removeBtn);
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
    card.appendChild(el('div', 'li-stat', '⏳ Updating…'));
    var pbWrap = el('div', 'progress-bar-wrap');
    pbWrap.appendChild(el('div', 'progress-bar-fill loading'));
    card.appendChild(pbWrap);
  } else if (orderState.completed) {
    var allOk = !orderState.results.some(function (r) { return !r.success; });
    if (!allOk) {
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

  container.appendChild(card);
}

// ─── custom confirm modal ──────────────────────────────────────────────────

function showConfirm(message, confirmLabel) {
  return new Promise(function (resolve) {
    var backdrop = el('div', 'modal-backdrop');
    var box = el('div', 'modal-box');
    box.appendChild(el('div', 'modal-msg', message));
    var actions = el('div', 'modal-actions');
    var cancelBtn = el('button', 'btn-modal-cancel', 'Cancel');
    var confirmBtn = el('button', 'btn-modal-confirm', confirmLabel || 'Confirm');
    cancelBtn.addEventListener('click', function () {
      document.body.removeChild(backdrop);
      resolve(false);
    });
    confirmBtn.addEventListener('click', function () {
      document.body.removeChild(backdrop);
      resolve(true);
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    box.appendChild(actions);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
  });
}

function showSuccess(message, draftOrderId, realOrderId) {
  return new Promise(function (resolve) {
    var backdrop = el('div', 'modal-backdrop');
    var box = el('div', 'modal-box');
    var icon = el('div', 'modal-success-icon', '✅');
    var msg = el('div', 'modal-msg', message);
    var actions = el('div', 'modal-actions');
    function goToList() {
      document.body.removeChild(backdrop);
      resolve();
      currentView = 'list';
      selectedOrderId = null;
      sessionStorage.removeItem(SESSION_VIEW_KEY);
      rerender();
      window.scrollTo(0, 0);
      loadData();
    }
    if (realOrderId) {
      var printBtn = el('button', 'btn-modal-cancel', '🖨 Print Invoice');
      printBtn.addEventListener('click', function () {
        printInvoice(draftOrderId, realOrderId);
        goToList();
      });
      actions.appendChild(printBtn);
    }
    var okBtn = el('button', 'btn-modal-confirm', 'OK');
    okBtn.addEventListener('click', goToList);
    actions.appendChild(okBtn);
    box.appendChild(icon);
    box.appendChild(msg);
    box.appendChild(actions);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
  });
}

// ─── deliver order ─────────────────────────────────────────────────────────

async function markDelivered(order) {
  var realId = getRealOrderId(order, state[order.id]);
  if (!realId) return;
  var confirmed = await showConfirm('Mark order ' + order.name + ' as delivered?', 'Mark as Delivered');
  if (!confirmed) return;
  try {
    var res = await fetch('/pickup/deliver', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: realId }),
    });
    var data = await res.json();
    if (data.success) {
      await loadData(); // refresh list — order disappears (tagged delivered)
    } else {
      await showConfirm('Failed to mark as delivered. Please try again.', 'OK');
    }
  } catch (err) {
    await showConfirm('Network error: ' + err.message, 'OK');
  }
}

// ─── list view (homepage) ──────────────────────────────────────────────────

function renderList(root, orders) {
  // Header: date + stats
  var incompleteCount = 0;
  var completedCount = 0;
  orders.forEach(function (o) {
    var os = state[o.id];
    if (isOrderCompleted(o, os)) completedCount++; else incompleteCount++;
  });

  var header = el('div', 'list-header');

  var titleRow = el('div');
  titleRow.style.display = 'flex';
  titleRow.style.justifyContent = 'space-between';
  titleRow.style.alignItems = 'center';
  titleRow.style.marginBottom = '4px';
  titleRow.appendChild(el('h1', null, 'Pickup Assistant'));
  header.appendChild(titleRow);
  header.appendChild(el('div', 'list-date', formatDate(new Date())));
  var statsRow = el('div', 'list-stats');
  statsRow.appendChild(el('span', 'stat-incomplete', 'Incomplete: ' + incompleteCount));
  statsRow.appendChild(el('span', 'stat-completed', 'Completed: ' + completedCount));
  header.appendChild(statsRow);

  root.appendChild(header);

  if (orders.length === 0) {
    root.appendChild(el('div', 'card', 'No orders.'));
    return;
  }

  orders.forEach(function (order) {
    var orderState = state[order.id];
    var completed = isOrderCompleted(order, orderState);
    var realId = getRealOrderId(order, orderState);
    var status = getOrderStatus(order, orderState);
    var badgeClass = status === 'printed' ? 'badge-printed' : (status === 'completed' ? 'badge-completed' : 'badge-incomplete');
    var badgeText = status === 'printed' ? 'Printed' : (status === 'completed' ? 'Completed' : 'Incomplete');

    var card = el('div', 'card list-card');

    // Name + badge row
    var nameBadge = el('div');
    nameBadge.style.display = 'flex';
    nameBadge.style.justifyContent = 'space-between';
    nameBadge.style.alignItems = 'center';
    var nameSpan = el('span', null, order.name);
    nameSpan.style.fontWeight = '600';
    nameSpan.style.fontSize = '15px';
    nameBadge.appendChild(nameSpan);
    nameBadge.appendChild(el('span', 'status-badge ' + badgeClass, badgeText));
    card.appendChild(nameBadge);

    if (order.customer_name) {
      card.appendChild(el('div', 'li-stat', order.customer_name));
    }
    if (order.created_at) {
      card.appendChild(el('div', 'order-time', formatTimestamp(order.created_at)));
    }

    // First 3 item titles summary
    var titles = (order.line_items || []).slice(0, 3).map(function (li) { return li.title; });
    if (titles.length > 0) {
      var summary = titles.join(', ') + (order.line_items.length > 3 ? '…' : '');
      card.appendChild(el('div', 'li-stat', summary));
    }

    // Print Invoice button for completed/printed orders
    if (completed && realId) {
      var printBtn = el('button', 'btn-print-list', '🖨  Print Invoice');
      printBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        printInvoice(order.id, realId);
      });
      card.appendChild(printBtn);
    }

    // Tap card → detail view
    card.addEventListener('click', function () {
      selectedOrderId = order.id;
      currentView = 'detail';
      sessionStorage.setItem(SESSION_VIEW_KEY, String(order.id));
      history.pushState(null, '', '#order-' + order.id);
      rerender();
    });

    // Swipe left → mark as delivered (completed/printed orders only)
    if (completed && realId) {
      card.style.position = 'relative';
      card.style.overflow = 'hidden';

      // Green overlay tracks the finger; sits above card content but below Print Invoice button
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:absolute;top:0;right:0;height:100%;width:0;background:#22c55e;opacity:0.5;z-index:1;pointer-events:none;border-radius:0 8px 8px 0;';
      card.appendChild(overlay);

      var swipeStartX = null;
      var triggered = false;

      function resetOverlay() {
        overlay.style.transition = 'width 0.2s ease-out';
        overlay.style.width = '0';
        swipeStartX = null;
        triggered = false;
      }

      card.addEventListener('touchstart', function (e) {
        swipeStartX = e.touches[0].clientX;
        triggered = false;
        overlay.style.transition = 'none'; // track finger with no lag
      }, { passive: true });

      card.addEventListener('touchmove', function (e) {
        if (swipeStartX === null || triggered) return;
        var touch = e.touches[0];
        var delta = touch.clientX - swipeStartX;
        var cardWidth = card.offsetWidth;

        // If finger moves outside the card's vertical bounds, snap back
        var rect = card.getBoundingClientRect();
        if (touch.clientY < rect.top || touch.clientY > rect.bottom) {
          resetOverlay();
          return;
        }

        if (delta < 0) {
          var swipeWidth = Math.min(-delta, cardWidth);
          overlay.style.width = swipeWidth + 'px';

          // Trigger when overlay reaches 50% of card width
          if (swipeWidth >= cardWidth / 2) {
            triggered = true;
            e.preventDefault(); // prevent click
            overlay.style.transition = 'none';
            overlay.style.width = '0';
            swipeStartX = null;
            triggered = false;
            markDelivered(order); // custom modal — non-blocking, no rAF needed
          }
        }
      }, { passive: false });

      // Snap back on finger lift (if threshold not met) or touch cancelled
      card.addEventListener('touchend', function () { if (!triggered) resetOverlay(); });
      card.addEventListener('touchcancel', resetOverlay);
    }

    root.appendChild(card);
  });
}

// ─── detail view ───────────────────────────────────────────────────────────

function renderDetail(root, orders, orderId) {
  var order = orders.find(function (o) { return o.id === orderId; });
  if (!order) {
    var err = el('div', 'card', 'Order not found.');
    var back = el('button', 'btn btn-back', '← Back');
    back.addEventListener('click', function () { currentView = 'list'; selectedOrderId = null; sessionStorage.removeItem(SESSION_VIEW_KEY); loadData(); });
    root.appendChild(back);
    root.appendChild(err);
    return;
  }

  // Back button
  var backBtn = el('button', 'btn btn-back', '← Back');
  backBtn.addEventListener('click', function () {
    currentView = 'list';
    selectedOrderId = null;
    sessionStorage.removeItem(SESSION_VIEW_KEY);
    history.pushState(null, '', '#');
    loadData();
  });
  root.appendChild(backBtn);

  var orderState = state[order.id];
  var completed = isOrderCompleted(order, orderState);

  // Sourced order — read-only with real line items
  if (order.status === 'sourced') {
    var realId = getRealOrderId(order, orderState);
    var card = el('div', 'card');
    card.appendChild(el('h2', null, order.name + (order.customer_name ? ' — ' + order.customer_name : '')));
    if (order.created_at) card.appendChild(el('div', 'order-time', formatTimestamp(order.created_at)));
    var completedBanner = el('div', 'result-success', '✅ Order completed');
    completedBanner.style.marginBottom = '10px';
    card.appendChild(completedBanner);

    // Real order line items (read-only)
    (order.line_items || []).forEach(function (li) {
      var row = el('div', 'line-item');
      row.appendChild(el('div', 'li-title',
        li.title + (li.variant_title ? ' (' + li.variant_title + ')' : '')));
      row.appendChild(el('div', 'li-stat', 'Qty: ' + li.quantity));
      row.appendChild(el('div', 'li-stat', 'Price: $' + li.price));
      (li.properties || []).forEach(function (p) {
        row.appendChild(el('div', 'li-stat', p.name + ': ' + p.value));
      });
      card.appendChild(row);
    });

    if (realId) {
      var printBtn = el('button', 'btn-print', 'Print Invoice');
      printBtn.addEventListener('click', function () { printInvoice(order.id, realId); });
      card.appendChild(printBtn);
    }
    root.appendChild(card);
    return;
  }

  // Open order (or in-session completed open order): full editing UI
  renderOrderCard(root, order, orderState);
}

// ─── main render ────────────────────────────────────────────────────────────

function render(orders) {
  var root = document.getElementById('app');
  root.innerHTML = '';
  if (currentView === 'detail' && selectedOrderId !== null) {
    renderDetail(root, orders, selectedOrderId);
  } else {
    renderList(root, orders);
  }
}

loadData();
</script>
</body>
</html>`;
}
