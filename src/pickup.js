/**
 * Pickup Assistant (G19) — Draft Orders tab
 *
 * Pure helper functions for the /pickup/* routes. Each function takes the
 * Shopify REST base URL + access token and returns either the response data
 * directly (getPickupData) or a { status, body } pair ready to hand back
 * to the caller.
 */

function shopifyHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': token,
  };
}

// ── GET /pickup/data ────────────────────────────────────────────────────────

export async function getPickupData(restBase, token) {
  const res = await fetch(`${restBase}/draft_orders.json?status=open`, {
    headers: shopifyHeaders(token),
  });
  const data = await res.json();

  if (!res.ok) {
    const err = new Error(JSON.stringify(data.errors || data));
    err.status = res.status;
    throw err;
  }

  const draftOrders = (data.draft_orders || []).filter(order => {
    const tags = (order.tags || '').split(',').map(t => t.trim());
    return tags.includes('draft-order-tab');
  });

  const productIds = [...new Set(
    draftOrders.flatMap(o => (o.line_items || []).map(li => li.product_id)).filter(Boolean)
  )];

  const weightProductIds = new Set();
  if (productIds.length > 0) {
    const gqlRes = await fetch(`${restBase}/graphql.json`, {
      method: 'POST',
      headers: shopifyHeaders(token),
      body: JSON.stringify({
        query: `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id tags } } }`,
        variables: { ids: productIds.map(id => `gid://shopify/Product/${id}`) },
      }),
    });
    const gqlData = await gqlRes.json();
    for (const node of gqlData?.data?.nodes || []) {
      if (node?.tags?.some(t => t.toLowerCase() === 'weight')) {
        weightProductIds.add(Number(node.id.split('/').pop()));
      }
    }
  }

  return draftOrders.map(order => ({
    id: order.id,
    name: order.name,
    customer_name: [order.shipping_address?.first_name, order.shipping_address?.last_name]
      .filter(Boolean)
      .join(' '),
    line_items: (order.line_items || []).map(li => ({
      id: li.id,
      title: li.title,
      variant_title: li.variant_title,
      quantity: li.quantity,
      price: li.price,
      sku: li.sku,
      has_weight_tag: weightProductIds.has(li.product_id),
    })),
  }));
}

// ── PUT /pickup/update ──────────────────────────────────────────────────────

export function applyLineItemUpdate(lineItem, update) {
  if (!update) return lineItem;

  switch (update.type) {
    case 'remove':
      return null;

    case 'partial':
      return { ...lineItem, quantity: update.quantity };

    case 'weight': {
      const weights = (update.weights || []).map(Number);
      const totalWeight = weights.reduce((sum, w) => sum + w, 0);
      const unitPrice = Number(update.unit_price ?? lineItem.price);
      return {
        ...lineItem,
        quantity: 1,
        price: (totalWeight * unitPrice).toFixed(2),
        properties: [
          ...(lineItem.properties || []),
          { name: 'Weight (lb)', value: weights.join(', ') },
        ],
      };
    }

    case 'found':
    default:
      return lineItem;
  }
}

export async function updateLineItems(restBase, token, draftOrderId, updates) {
  const getRes = await fetch(`${restBase}/draft_orders/${draftOrderId}.json`, {
    headers: shopifyHeaders(token),
  });
  const getData = await getRes.json();

  if (!getRes.ok) {
    return { status: getRes.status, body: { error: 'shopify_error', message: JSON.stringify(getData.errors) } };
  }

  const currentLineItems = getData.draft_order.line_items || [];
  const updatesById = new Map(updates.map(u => [String(u.line_item_id), u]));

  const mergedLineItems = currentLineItems
    .map(li => applyLineItemUpdate(li, updatesById.get(String(li.id))))
    .filter(Boolean);

  const putRes = await fetch(`${restBase}/draft_orders/${draftOrderId}.json`, {
    method: 'PUT',
    headers: shopifyHeaders(token),
    body: JSON.stringify({ draft_order: { id: Number(draftOrderId), line_items: mergedLineItems } }),
  });
  const putData = await putRes.json();

  if (!putRes.ok) {
    return { status: putRes.status, body: { error: 'shopify_error', message: JSON.stringify(putData.errors) } };
  }

  return { status: 200, body: putData };
}

// ── PUT /pickup/complete ────────────────────────────────────────────────────

export async function completeDraftOrder(restBase, token, draftOrderId) {
  const completeRes = await fetch(`${restBase}/draft_orders/${draftOrderId}/complete.json`, {
    method: 'PUT',
    headers: shopifyHeaders(token),
  });
  const completeData = await completeRes.json();

  if (!completeRes.ok) {
    return { status: completeRes.status, body: { error: 'shopify_error', message: JSON.stringify(completeData.errors) } };
  }

  const gqlRes = await fetch(`${restBase}/graphql.json`, {
    method: 'POST',
    headers: shopifyHeaders(token),
    body: JSON.stringify({
      query: `query($id: ID!) { draftOrder(id: $id) { order { id legacyResourceId } } }`,
      variables: { id: `gid://shopify/DraftOrder/${draftOrderId}` },
    }),
  });
  const gqlData = await gqlRes.json();
  const orderId = gqlData?.data?.draftOrder?.order?.legacyResourceId;

  if (!orderId) {
    return { status: 200, body: { draft_order: completeData.draft_order } };
  }

  const orderRes = await fetch(`${restBase}/orders/${orderId}.json`, {
    headers: shopifyHeaders(token),
  });
  const orderData = await orderRes.json();
  const existingTags = (orderData?.order?.tags || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  if (!existingTags.includes('sourced')) {
    existingTags.push('sourced');
    await fetch(`${restBase}/orders/${orderId}.json`, {
      method: 'PUT',
      headers: shopifyHeaders(token),
      body: JSON.stringify({ order: { id: Number(orderId), tags: existingTags.join(', ') } }),
    });
  }

  return { status: 200, body: { draft_order: completeData.draft_order, order_id: orderId } };
}
