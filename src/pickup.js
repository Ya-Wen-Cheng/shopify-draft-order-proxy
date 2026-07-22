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
  // Parallel fetch: open draft orders tagged draft-order-tab + real orders tagged sourced
  const [openRes, sourcedRes] = await Promise.all([
    fetch(`${restBase}/draft_orders.json?status=open&limit=250`, { headers: shopifyHeaders(token) }),
    fetch(`${restBase}/orders.json?tag=sourced&limit=250`, { headers: shopifyHeaders(token) }),
  ]);
  const [openData, sourcedData] = await Promise.all([openRes.json(), sourcedRes.json()]);

  if (!openRes.ok) {
    const err = new Error(JSON.stringify(openData.errors || openData));
    err.status = openRes.status;
    throw err;
  }

  const hasTag = order => (order.tags || '').split(',').map(t => t.trim()).includes('draft-order-tab');
  const openOrders = (openData.draft_orders || []).filter(hasTag);
  // Exclude already-delivered orders from the pickup list
  const sourcedOrders = (sourcedData.orders || []).filter(order => {
    const tags = (order.tags || '').split(',').map(t => t.trim());
    return !tags.includes('delivered');
  });

  // GraphQL enrichment only for open orders (need cost + weight tag)
  const productIds = [...new Set(
    openOrders.flatMap(o => (o.line_items || []).map(li => li.product_id)).filter(Boolean)
  )];

  const weightProductIds = new Set();
  // Map<numericVariantId, { cost, inventoryItemGid }>
  const variantCostMap = new Map();

  if (productIds.length > 0) {
    const gqlRes = await fetch(`${restBase}/graphql.json`, {
      method: 'POST',
      headers: shopifyHeaders(token),
      body: JSON.stringify({
        query: `query($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              tags
              variants(first: 100) {
                edges {
                  node {
                    id
                    inventoryItem {
                      id
                      unitCost { amount }
                    }
                  }
                }
              }
            }
          }
        }`,
        variables: { ids: productIds.map(id => `gid://shopify/Product/${id}`) },
      }),
    });
    const gqlData = await gqlRes.json();
    for (const node of gqlData?.data?.nodes || []) {
      if (node?.tags?.some(t => t.toLowerCase() === 'weight')) {
        weightProductIds.add(Number(node.id.split('/').pop()));
      }
      for (const edge of node?.variants?.edges || []) {
        const variantNode = edge.node;
        const numericVariantId = Number(variantNode.id.split('/').pop());
        variantCostMap.set(numericVariantId, {
          cost: variantNode.inventoryItem?.unitCost?.amount ?? null,
          inventoryItemGid: variantNode.inventoryItem?.id ?? null,
        });
      }
    }
  }

  function customerName(order) {
    // Prefer shipping address, fall back to customer record
    const fromShipping = [order.shipping_address?.first_name, order.shipping_address?.last_name]
      .filter(Boolean).join(' ');
    if (fromShipping) return fromShipping;
    return [order.customer?.first_name, order.customer?.last_name]
      .filter(Boolean).join(' ');
  }

  const enrichedOpen = openOrders.map(order => ({
    id: order.id,
    name: order.name,
    status: 'open',
    order_id: null,
    created_at: order.created_at,
    customer_name: customerName(order),
    line_items: (order.line_items || []).map(li => {
      const variantInfo = variantCostMap.get(li.variant_id);
      return {
        id: li.id,
        title: li.title,
        variant_title: li.variant_title,
        quantity: li.quantity,
        price: li.price,
        sku: li.sku,
        has_weight_tag: weightProductIds.has(li.product_id),
        cost: variantInfo?.cost ?? null,
        inventory_item_id: variantInfo?.inventoryItemGid ?? null,
        variant_id: li.variant_id,
        product_id: li.product_id,
      };
    }),
  }));

  // Sourced orders already have all the data we need — no second fetch required
  const enrichedSourced = sourcedOrders.map(order => ({
    id: order.id,
    name: order.name,
    status: 'sourced',
    order_id: order.id,
    created_at: order.created_at,
    customer_name: customerName(order),
    line_items: (order.line_items || []).map(li => ({
      id: li.id,
      title: li.title,
      variant_title: li.variant_title || null,
      quantity: li.quantity,
      price: li.price,
      properties: li.properties || [],
    })),
  }));

  // Combined, newest first
  return [...enrichedOpen, ...enrichedSourced].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );
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
      // Prefer unit_price from the change (driver's confirmed price per lb,
      // including any cost/price panel update). Fall back to server price.
      const unitPrice = Number(update.unit_price ?? lineItem.price);
      const totalPrice = (totalWeight * unitPrice).toFixed(2);
      return {
        ...lineItem,
        quantity: 1,
        price: totalPrice,
        properties: [
          ...(lineItem.properties || []),
          { name: 'Weight (lb)', value: weights.join(', ') },
          { name: 'Price Breakdown', value: `$${unitPrice.toFixed(2)}/lb × ${totalWeight} lb = $${totalPrice}` },
        ],
      };
    }

    case 'found':
    default:
      // 'cost_price' type is handled in completeDraftOrder (price override applied inline after this call)
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

export async function completeDraftOrder(restBase, token, draftOrderId, changes = []) {
  const results = [];

  // ── Step 1: Separate cost/price changes, detect what actually changed ──────
  const costPriceChanges = changes.filter(c => c.type === 'cost_price').map(c => ({
    ...c,
    costChanged: c.cost !== null && c.cost !== undefined && parseFloat(c.cost) !== parseFloat(c.current_cost),
    priceChanged: c.price !== null && c.price !== undefined && parseFloat(c.price) !== parseFloat(c.current_price),
  }));

  // All other change types that affect line items directly
  const lineItemChanges = changes.filter(c => c.type !== 'cost_price');

  // ── Step 2: Process cost updates per item (metafield + inventory REST) ─────
  for (const change of costPriceChanges) {
    if (!change.costChanged && !change.priceChanged) {
      // No-op: neither cost nor price changed
      results.push({ line_item_id: change.line_item_id, title: change.title, success: true });
      continue;
    }

    if (change.costChanged) {
      if (!change.inventory_item_id) {
        results.push({ line_item_id: change.line_item_id, title: change.title, success: false, error: 'missing inventory_item_id' });
        continue;
      }
      try {
        // Step 2a: Set cost_change_source metafield to "pickup" on the product
        const metafieldRes = await fetch(`${restBase}/graphql.json`, {
          method: 'POST',
          headers: shopifyHeaders(token),
          body: JSON.stringify({
            query: `mutation CostChangeWrite($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                metafields { id key }
                userErrors { field message }
              }
            }`,
            variables: {
              metafields: [{
                ownerId: `gid://shopify/Product/${change.product_id}`,
                namespace: 'custom',
                key: 'cost_change_source',
                type: 'single_line_text_field',
                value: 'pickup',
              }],
            },
          }),
        });
        const metafieldData = await metafieldRes.json();
        const userErrors = metafieldData?.data?.metafieldsSet?.userErrors;
        if (userErrors && userErrors.length > 0) {
          throw new Error(userErrors.map(e => e.message).join('; '));
        }

        // Step 2b: Update inventory_item.cost via REST
        const numericInventoryItemId = change.inventory_item_id.split('/').pop();
        const invRes = await fetch(`${restBase}/inventory_items/${numericInventoryItemId}.json`, {
          method: 'PUT',
          headers: shopifyHeaders(token),
          body: JSON.stringify({ inventory_item: { id: Number(numericInventoryItemId), cost: change.cost } }),
        });
        if (!invRes.ok) {
          const invData = await invRes.json();
          throw new Error(JSON.stringify(invData.errors));
        }

        // Step 2c: Update variant catalog price if also changed
        if (change.priceChanged && change.variant_id) {
          const variantRes = await fetch(`${restBase}/variants/${change.variant_id}.json`, {
            method: 'PUT',
            headers: shopifyHeaders(token),
            body: JSON.stringify({ variant: { id: Number(change.variant_id), price: change.price } }),
          });
          if (!variantRes.ok) {
            const variantData = await variantRes.json();
            throw new Error(JSON.stringify(variantData.errors));
          }
        }

        // Only push a result entry here if there's no price change (price change handled in step 3)
        if (!change.priceChanged) {
          results.push({ line_item_id: change.line_item_id, title: change.title, success: true });
        }
      } catch (err) {
        results.push({ line_item_id: change.line_item_id, title: change.title, success: false, error: err.message });
        // Skip price update for this item if cost update failed
        continue;
      }
    }

    // Price-only changes (costChanged=false, priceChanged=true): update variant catalog price.
    // Items with costChanged=true && priceChanged=true already updated catalog price in step 2c.
    if (!change.costChanged && change.priceChanged && change.variant_id) {
      try {
        const variantRes = await fetch(`${restBase}/variants/${change.variant_id}.json`, {
          method: 'PUT',
          headers: shopifyHeaders(token),
          body: JSON.stringify({ variant: { id: Number(change.variant_id), price: change.price } }),
        });
        if (!variantRes.ok) {
          const variantData = await variantRes.json();
          throw new Error(JSON.stringify(variantData.errors));
        }
        // Result deferred to step 3 (line-item merge tracks success/failure for price changes)
      } catch (err) {
        results.push({ line_item_id: change.line_item_id, title: change.title, success: false, error: err.message });
      }
    }
  }

  // ── Step 3: Single fetch-then-merge for all line-item-level changes ────────
  // Resolutions (weight/partial/remove/found) and price-only changes are kept in
  // separate Maps so both can be applied to the same line item without either
  // overwriting the other (a single combined Map would silently drop one when an
  // item has both a resolution change and a price change).
  //
  // Weight items carry their own price via unit_price on the weight change, so
  // they are excluded from priceChanges to avoid double-applying a price.
  const failedIds = new Set(results.filter(r => !r.success).map(r => r.line_item_id));
  const weightLineItemIds = new Set(lineItemChanges.filter(c => c.type === 'weight').map(c => c.line_item_id));
  const priceChanges = costPriceChanges.filter(
    c => c.priceChanged && !failedIds.has(c.line_item_id) && !weightLineItemIds.has(c.line_item_id)
  );
  const resolutionById = new Map(lineItemChanges.map(u => [String(u.line_item_id), u]));
  const priceById      = new Map(priceChanges.map(u => [String(u.line_item_id), u]));

  // Deduplicated set of all items touched in this step (for result reporting)
  const allChangedItems = new Map();
  for (const c of [...lineItemChanges, ...priceChanges]) {
    if (!allChangedItems.has(c.line_item_id)) allChangedItems.set(c.line_item_id, c.title);
  }

  if (allChangedItems.size > 0) {
    try {
      const getRes = await fetch(`${restBase}/draft_orders/${draftOrderId}.json`, {
        headers: shopifyHeaders(token),
      });
      const getData = await getRes.json();

      if (!getRes.ok) {
        for (const [id, title] of allChangedItems) {
          if (!failedIds.has(id)) {
            results.push({ line_item_id: id, title, success: false, error: JSON.stringify(getData.errors) });
          }
        }
      } else {
        const currentLineItems = getData.draft_order.line_items || [];

        const mergedLineItems = currentLineItems
          .map(li => {
            const resUpdate   = resolutionById.get(String(li.id));
            const priceUpdate = priceById.get(String(li.id));
            // Apply resolution first (handles weight/partial/remove/found + price calc)
            let merged = resUpdate ? applyLineItemUpdate(li, resUpdate) : li;
            // Then overlay price change — skip removed items (merged === null)
            if (merged !== null && priceUpdate) {
              merged = { ...merged, price: String(priceUpdate.price) };
            }
            return merged;
          })
          .filter(Boolean);

        // ── Use GraphQL draftOrderUpdate so price overrides are respected ────────
        // REST API silently ignores price on variant line items.
        //
        // Shopify rules:
        //   - priceOverride works for both variant and custom line items.
        //   - originalUnitPrice/originalUnitPriceWithCurrency is ignored when
        //     variantId is provided; it only applies to custom line items.
        //   - Keeping variantId preserves product association for sales analytics.
        //
        // All variant items (including weight items) keep their variantId and use
        // priceOverride so Shopify analytics remain accurate.
        const gqlLineItems = mergedLineItems.map(li => {
          const input = {
            quantity: li.quantity,
            customAttributes: (li.properties || []).map(p => ({ key: p.name, value: p.value })),
          };
          if (li.variant_id) {
            input.variantId = `gid://shopify/ProductVariant/${li.variant_id}`;
            input.priceOverride = { amount: String(li.price), currencyCode: 'USD' };
          } else {
            input.title = li.title;
            input.requiresShipping = li.requires_shipping ?? true;
            input.originalUnitPrice = String(li.price);
          }
          return input;
        });

        const gqlRes = await fetch(`${restBase}/graphql.json`, {
          method: 'POST',
          headers: shopifyHeaders(token),
          body: JSON.stringify({
            query: `mutation DraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
              draftOrderUpdate(id: $id, input: $input) {
                draftOrder { id }
                userErrors { field message }
              }
            }`,
            variables: {
              id: `gid://shopify/DraftOrder/${draftOrderId}`,
              input: { lineItems: gqlLineItems },
            },
          }),
        });
        const gqlData = await gqlRes.json();
        const userErrors = gqlData?.data?.draftOrderUpdate?.userErrors;

        if (!gqlRes.ok || (userErrors && userErrors.length > 0)) {
          const errMsg = userErrors?.map(e => e.message).join('; ') || JSON.stringify(gqlData.errors);
          for (const [id, title] of allChangedItems) {
            if (!failedIds.has(id)) results.push({ line_item_id: id, title, success: false, error: errMsg });
          }
        } else {
          for (const [id, title] of allChangedItems) {
            if (!failedIds.has(id)) results.push({ line_item_id: id, title, success: true });
          }
        }
      }
    } catch (err) {
      for (const [id, title] of allChangedItems) {
        if (!failedIds.has(id)) results.push({ line_item_id: id, title, success: false, error: err.message });
      }
    }
  }

  // ── Step 4: Completion gating ──────────────────────────────────────────────
  const allSucceeded = results.every(r => r.success);

  if (!allSucceeded) {
    return { status: 200, body: { results, all_succeeded: false } };
  }

  // ── Complete the draft order + sourced-tag logic (unchanged) ───────────────
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
    return { status: 200, body: { results, all_succeeded: true, draft_order: completeData.draft_order } };
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

  const orderName = orderData?.order?.name || null;
  return { status: 200, body: { results, all_succeeded: true, draft_order: completeData.draft_order, order_id: orderId, order_name: orderName } };
}

// ── PUT /pickup/deliver ─────────────────────────────────────────────────────
// Adds 'delivered' tag to a sourced (real) order, removing it from the pickup list.

export async function markOrderDelivered(restBase, token, orderId) {
  const getRes = await fetch(`${restBase}/orders/${orderId}.json`, { headers: shopifyHeaders(token) });
  const getData = await getRes.json();
  if (!getRes.ok) throw new Error(JSON.stringify(getData.errors));

  const tags = (getData.order.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  if (!tags.includes('delivered')) {
    tags.push('delivered');
    const putRes = await fetch(`${restBase}/orders/${orderId}.json`, {
      method: 'PUT',
      headers: shopifyHeaders(token),
      body: JSON.stringify({ order: { id: Number(orderId), tags: tags.join(', ') } }),
    });
    if (!putRes.ok) {
      const putData = await putRes.json();
      throw new Error(JSON.stringify(putData.errors));
    }
  }

  return { success: true };
}
