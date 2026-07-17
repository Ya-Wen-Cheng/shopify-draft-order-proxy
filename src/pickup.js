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
              variants(first: 100) {  /* assumes ≤100 variants per product; no pagination */
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
      // Build variant cost map from each product's variant edges
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

  return draftOrders.map(order => ({
    id: order.id,
    name: order.name,
    created_at: order.created_at,
    customer_name: [order.shipping_address?.first_name, order.shipping_address?.last_name]
      .filter(Boolean)
      .join(' '),
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
    costChanged: c.cost !== null && c.cost !== undefined && c.cost !== c.current_cost,
    priceChanged: c.price !== null && c.price !== undefined && c.price !== c.current_price,
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

        // Only push a result entry here if there's no price change (price change will push it below)
        if (!change.priceChanged) {
          results.push({ line_item_id: change.line_item_id, title: change.title, success: true });
        }
      } catch (err) {
        results.push({ line_item_id: change.line_item_id, title: change.title, success: false, error: err.message });
        // Skip price update for this item if cost update failed
        continue;
      }
    }

    // Price-only changes (costChanged=false, priceChanged=true) also need a result entry,
    // but we defer that to the line-item merge step below where we track success/failure.
    // Items with costChanged=true && priceChanged=true: cost result already pushed above (success),
    // price merge success will be reflected in the overall results.
  }

  // ── Step 3: Single fetch-then-merge for all line-item-level changes ────────
  // Includes: weight/partial/remove/found changes, plus cost_price items where priceChanged
  const failedIds = new Set(results.filter(r => !r.success).map(r => r.line_item_id));
  const priceChanges = costPriceChanges.filter(c => c.priceChanged && !failedIds.has(c.line_item_id));
  const allLineItemChanges = [...lineItemChanges, ...priceChanges];

  if (allLineItemChanges.length > 0) {
    try {
      const getRes = await fetch(`${restBase}/draft_orders/${draftOrderId}.json`, {
        headers: shopifyHeaders(token),
      });
      const getData = await getRes.json();

      if (!getRes.ok) {
        // Mark all pending line-item changes as failed
        for (const change of allLineItemChanges) {
          // Don't double-add entries for items that already have a failed cost entry
          const alreadyFailed = failedIds.has(change.line_item_id);
          if (!alreadyFailed) {
            results.push({ line_item_id: change.line_item_id, title: change.title, success: false, error: JSON.stringify(getData.errors) });
          }
        }
      } else {
        const currentLineItems = getData.draft_order.line_items || [];
        const updatesById = new Map(allLineItemChanges.map(u => [String(u.line_item_id), u]));

        const mergedLineItems = currentLineItems
          .map(li => {
            const update = updatesById.get(String(li.id));
            if (!update) return li;

            // Apply standard line-item update (weight/partial/remove/found)
            let merged = applyLineItemUpdate(li, update);

            // For cost_price items where priceChanged: override the price field
            if (update.type === 'cost_price' && update.priceChanged && merged !== null) {
              merged = { ...merged, price: String(update.price) };
            }

            return merged;
          })
          .filter(Boolean);

        const putRes = await fetch(`${restBase}/draft_orders/${draftOrderId}.json`, {
          method: 'PUT',
          headers: shopifyHeaders(token),
          body: JSON.stringify({ draft_order: { id: Number(draftOrderId), line_items: mergedLineItems } }),
        });
        const putData = await putRes.json();

        if (!putRes.ok) {
          for (const change of allLineItemChanges) {
            const alreadyFailed = failedIds.has(change.line_item_id);
            if (!alreadyFailed) {
              results.push({ line_item_id: change.line_item_id, title: change.title, success: false, error: JSON.stringify(putData.errors) });
            }
          }
        } else {
          // Mark all line-item changes as succeeded (unless already marked failed from cost step)
          for (const change of allLineItemChanges) {
            const alreadyFailed = failedIds.has(change.line_item_id);
            if (!alreadyFailed) {
              results.push({ line_item_id: change.line_item_id, title: change.title, success: true });
            }
          }
        }
      }
    } catch (err) {
      for (const change of allLineItemChanges) {
        const alreadyFailed = failedIds.has(change.line_item_id);
        if (!alreadyFailed) {
          results.push({ line_item_id: change.line_item_id, title: change.title, success: false, error: err.message });
        }
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

  return { status: 200, body: { results, all_succeeded: true, draft_order: completeData.draft_order, order_id: orderId } };
}
