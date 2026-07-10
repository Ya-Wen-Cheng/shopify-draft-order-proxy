/**
 * Server-rendered mobile UI for the Pickup Assistant Draft Orders tab (G19).
 * All state (weights, resolved items, completed orders) lives client-side in
 * memory for the duration of the session — no background polling, no auth.
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
  .card h2 { margin: 0 0 8px; font-size: 16px; }
  .line-item { border-top: 1px solid #eee; padding: 12px 0; }
  .line-item:first-child { border-top: none; }
  .line-item.resolved { opacity: 0.5; }
  .btn { padding: 8px 14px; border-radius: 6px; border: none; margin-right: 6px; margin-top: 6px; font-size: 14px; }
  .btn-found { background: #22c55e; color: #fff; }
  .btn-partial { background: #eab308; color: #fff; }
  .btn-remove { background: #ef4444; color: #fff; }
  .btn-complete { background: #2563eb; color: #fff; width: 100%; padding: 14px; font-size: 16px; margin-top: 12px; border: none; border-radius: 6px; }
  .btn-complete:disabled { background: #ccc; }
  .btn-print { background: #6b21a8; color: #fff; width: 100%; padding: 14px; font-size: 16px; margin-top: 8px; border: none; border-radius: 6px; }
  input[type=number] { width: 70px; padding: 6px; font-size: 14px; margin-right: 6px; }
  .toggle label { margin-right: 12px; font-size: 13px; }
  .weight-row { margin-top: 6px; }
</style>
</head>
<body>
  <h1>Pickup Assistant — Draft Orders</h1>
  <div id="orders">Loading…</div>

<script>
var state = {};

function el(tag, className, html) {
  var e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function getItemState(orderId, li) {
  var order = state[orderId];
  if (!order.items[li.id]) {
    order.items[li.id] = {
      resolved: false,
      hasWeight: !!li.has_weight_tag,
      bulk: false,
      weightCount: 1,
      weights: [''],
      quantity: li.quantity,
      unitPrice: li.price
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

async function loadData() {
  var res = await fetch('/pickup/data');
  var data = await res.json();
  var orders = data.draft_orders || [];
  orders.forEach(function (order) {
    if (!state[order.id]) {
      state[order.id] = { items: {}, completed: false, realOrderId: null, order: order };
    } else {
      state[order.id].order = order;
    }
    order.line_items.forEach(function (li) { getItemState(order.id, li); });
  });
  render(orders);
}

function saveWeight(orderId, li, itemState) {
  var weights = itemState.weights.filter(function (w) { return w !== '' && !isNaN(Number(w)); });
  if (weights.length === 0) return;
  fetch('/pickup/update', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      draft_order_id: orderId,
      updates: [{ line_item_id: li.id, type: 'weight', weights: weights.map(Number), unit_price: itemState.unitPrice }]
    })
  }).then(function () {
    itemState.resolved = true;
    render(Object.keys(state).map(function (id) { return state[id].order; }));
  });
}

function markResolved(orderId, li, itemState, type, quantity) {
  var body = { draft_order_id: orderId, updates: [{ line_item_id: li.id, type: type }] };
  if (type === 'partial') body.updates[0].quantity = quantity;
  fetch('/pickup/update', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function () {
    itemState.resolved = true;
    render(Object.keys(state).map(function (id) { return state[id].order; }));
  });
}

function completeOrder(order) {
  fetch('/pickup/complete', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft_order_id: order.id })
  }).then(function (res) { return res.json(); })
    .then(function (data) {
      state[order.id].completed = true;
      state[order.id].realOrderId = data.order_id || null;
      render(Object.keys(state).map(function (id) { return state[id].order; }));
    });
}

function renderWeightInputs(container, orderId, li, itemState) {
  container.innerHTML = '';

  var toggle = el('div', 'toggle');
  toggle.innerHTML =
    '<label><input type="radio" name="mode-' + li.id + '"' + (!itemState.bulk ? ' checked' : '') + '> Per-Item</label>' +
    '<label><input type="radio" name="mode-' + li.id + '"' + (itemState.bulk ? ' checked' : '') + '> Bulk</label>';
  var radios = toggle.querySelectorAll('input');
  radios[0].addEventListener('change', function () { itemState.bulk = false; itemState.weights = ['']; renderWeightInputs(container, orderId, li, itemState); });
  radios[1].addEventListener('change', function () { itemState.bulk = true; itemState.weights = ['']; renderWeightInputs(container, orderId, li, itemState); });
  container.appendChild(toggle);

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
  container.appendChild(row);

  var saveBtn = el('button', 'btn btn-found', 'Save Weight');
  saveBtn.addEventListener('click', function () { saveWeight(orderId, li, itemState); });
  container.appendChild(saveBtn);
}

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
    card.appendChild(el('h2', null, order.name + (order.customer_name ? ' — ' + order.customer_name : '')));

    order.line_items.forEach(function (li) {
      var itemState = getItemState(order.id, li);
      var row = el('div', 'line-item' + (itemState.resolved ? ' resolved' : ''));
      row.appendChild(el('div', null, li.title + (li.variant_title ? ' — ' + li.variant_title : '') + ' (qty ' + li.quantity + ')'));

      if (itemState.hasWeight) {
        var weightContainer = el('div');
        renderWeightInputs(weightContainer, order.id, li, itemState);
        row.appendChild(weightContainer);
      } else {
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
        row.appendChild(foundBtn);
        row.appendChild(partialBtn);
        row.appendChild(removeBtn);
      }
      card.appendChild(row);
    });

    var completeBtn = el('button', 'btn-complete', orderState.completed ? 'Completed ✓' : 'Complete Order');
    completeBtn.disabled = orderState.completed || !allResolved(order.id);
    completeBtn.addEventListener('click', function () { completeOrder(order); });
    card.appendChild(completeBtn);

    if (orderState.completed) {
      var printBtn = el('button', 'btn-print', 'Print Invoice');
      printBtn.addEventListener('click', function () {
        if (orderState.realOrderId) window.open('/invoice/' + orderState.realOrderId, '_blank');
      });
      card.appendChild(printBtn);
    }

    root.appendChild(card);
  });
}

loadData();
</script>
</body>
</html>`;
}
