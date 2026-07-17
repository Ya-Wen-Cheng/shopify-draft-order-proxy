/**
 * CostChangeHandler Durable Object
 *
 * Serializes cost-change processing per inventory_item_id (one DO instance
 * per id), so concurrent webhook deliveries for the same item can't race
 * each other's metafield reads/writes. No durable storage is used — all
 * state lives in Shopify product metafields.
 */

const SHOP_NAME  = '6kaf1n-gt';
const API_VERSION = '2026-07';
const GRAPHQL_URL = `https://${SHOP_NAME}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;
const MAX_RETRIES = 2;

const READ_QUERY = `
  query CostChangeRead($id: ID!) {
    inventoryItem(id: $id) {
      id
      variant {
        id
        title
        product {
          id
          variantsCount { count }
          lastKnownCost: metafield(namespace: "custom", key: "last_known_cost") { value }
          costChangeLog: metafield(namespace: "custom", key: "cost_change_log") { value }
          costChangeSource: metafield(namespace: "custom", key: "cost_change_source") { id value }
        }
      }
    }
  }
`;

const WRITE_MUTATION = `
  mutation CostChangeWrite($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key }
      userErrors { field message }
    }
  }
`;

const DELETE_SOURCE_MUTATION = `
  mutation CostChangeSourceDelete($id: ID!) {
    metafieldDelete(input: { id: $id }) {
      deletedId
      userErrors { field message }
    }
  }
`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function gidToId(gid) {
  return gid.split('/').pop();
}

function formatCost(cost) {
  return Number(cost).toFixed(2);
}

function buildLogLine({ date, variantTitle, priorCost, newCost, source, isMultiVariant }) {
  const change = `$${formatCost(priorCost)} → $${formatCost(newCost)}`;
  return isMultiVariant
    ? `${date} | ${variantTitle} | ${change} | ${source}`
    : `${date} | ${change} | ${source}`;
}

export class CostChangeHandler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async graphqlRequest(query, variables) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(GRAPHQL_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': this.env.SHOPIFY_TOKEN,
          },
          body: JSON.stringify({ query, variables }),
        });

        if (!res.ok) {
          lastError = new Error(`Shopify API returned ${res.status}`);
        } else {
          const result = await res.json();
          if (result.errors) {
            lastError = new Error(`Shopify GraphQL error: ${JSON.stringify(result.errors)}`);
          } else {
            return result;
          }
        }
      } catch (err) {
        lastError = err;
      }

      if (attempt < MAX_RETRIES) {
        await sleep(2 ** attempt * 100);
      }
    }
    throw lastError;
  }

  async fetch(request) {
    let payload;
    try {
      payload = await request.json();
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
    }

    const inventoryItemGid = `gid://shopify/InventoryItem/${payload.id}`;
    const newCost = payload.cost;

    try {
      const readResult = await this.graphqlRequest(READ_QUERY, { id: inventoryItemGid });
      const inventoryItem = readResult.data?.inventoryItem;
      if (!inventoryItem?.variant?.product) {
        return new Response(JSON.stringify({ error: 'Inventory item not found' }), { status: 404 });
      }

      const variant        = inventoryItem.variant;
      const variantId       = gidToId(variant.id);
      const variantTitle    = variant.title;
      const product         = variant.product;
      const isMultiVariant  = (product.variantsCount?.count ?? 1) > 1;

      const lastKnownCost = product.lastKnownCost?.value ? JSON.parse(product.lastKnownCost.value) : {};
      const costChangeLog = product.costChangeLog?.value || '';
      const costChangeSourceId    = product.costChangeSource?.id || null;
      const costChangeSource     = product.costChangeSource?.value || '';

      const priorCost = lastKnownCost[variantId];

      // No prior recorded cost — self-healing initialization, no log entry.
      if (priorCost === undefined) {
        lastKnownCost[variantId] = newCost;
        await this.graphqlRequest(WRITE_MUTATION, {
          metafields: [{
            ownerId: product.id,
            namespace: 'custom',
            key: 'last_known_cost',
            type: 'json',
            value: JSON.stringify(lastKnownCost),
          }],
        });
        return new Response(JSON.stringify({ ok: true, initialized: true }), { status: 200 });
      }

      // Cost unchanged — nothing to write.
      if (Number(priorCost) === Number(newCost)) {
        return new Response(JSON.stringify({ ok: true, unchanged: true }), { status: 200 });
      }

      const date = new Date().toISOString().slice(0, 10);
      const source = costChangeSource || 'manual';
      const logLine = buildLogLine({
        date,
        variantTitle,
        priorCost,
        newCost,
        source,
        isMultiVariant,
      });
      const newLog = costChangeLog ? `${logLine}\n${costChangeLog}` : logLine;
      lastKnownCost[variantId] = newCost;

      await this.graphqlRequest(WRITE_MUTATION, {
        metafields: [
          {
            ownerId: product.id,
            namespace: 'custom',
            key: 'last_known_cost',
            type: 'json',
            value: JSON.stringify(lastKnownCost),
          },
          {
            ownerId: product.id,
            namespace: 'custom',
            key: 'cost_change_log',
            type: 'multi_line_text_field',
            value: newLog,
          },
        ],
      });

      // Clear cost_change_source after use (delete rather than blank to satisfy Shopify validation)
      if (costChangeSourceId) {
        await this.graphqlRequest(DELETE_SOURCE_MUTATION, { id: costChangeSourceId });
      }

      return new Response(JSON.stringify({ ok: true, logged: true }), { status: 200 });
    } catch (err) {
      console.error('CostChangeHandler error:', err.message, err.stack);
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }
}
