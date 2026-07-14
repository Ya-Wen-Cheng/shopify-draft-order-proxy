/**
 * AIGO Shopify Draft Order Proxy
 *
 * Routes:
 *   GET  /?id={draft_order_id}              → fetch a draft order
 *   PUT  /?id={id}&action=complete          → complete a draft order → real order
 *   POST /?action=add-address               → add address to customer profile
 *   POST /?action=signup                    → guest membership signup (creates customer)
 *   POST /?action=activate-membership       → activate membership for logged-in customer
 *   POST /                                  → create a draft order from cart
 */


// ── GraphQL helpers ───────────────────────────────────────────────────────────

async function gql(query, variables, gqlUrl, token) {
  const res = await fetch(gqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify GQL HTTP ${res.status}`);
  return res.json();
}

// Read founding-member counter from shop metafield
async function readFoundingCount(gqlUrl, token) {
  const result = await gql(
    `query { shop { id metafield(namespace: "membership", key: "first_100_free_count") { id value } } }`,
    {},
    gqlUrl,
    token,
  );
  const shop = result?.data?.shop;
  const metafield = shop?.metafield;
  return {
    shopId: shop?.id,
    count: metafield ? parseInt(metafield.value, 10) : 0,
  };
}

// Add membership tags and (if founding slot open) increment the counter.
// NOTE: the read-increment-write is not atomic — two concurrent calls near count=99
// can both grant founding-member status. "Roughly 100" over-grant is acceptable per spec.
// First call with no metafield bootstraps it at value "1".
async function applyMembership(customerGid, gqlUrl, token) {
  const { shopId, count } = await readFoundingCount(gqlUrl, token);
  const isFoundingMember = count < 100;
  const tags = isFoundingMember ? ['member', 'founding-member'] : ['member'];

  const tagsResult = await gql(
    `mutation tagsAdd($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
    }`,
    { id: customerGid, tags },
    gqlUrl,
    token,
  );
  const tagsErrors = tagsResult?.data?.tagsAdd?.userErrors ?? [];
  if (tagsErrors.length > 0) throw new Error(tagsErrors[0].message);

  if (isFoundingMember) {
    if (!shopId) throw new Error('Could not read shop GID for metafield update');
    const metaResult = await gql(
      `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
      }`,
      {
        metafields: [{
          ownerId: shopId,
          namespace: 'membership',
          key: 'first_100_free_count',
          value: String(count + 1),
          type: 'number_integer',
        }],
      },
      gqlUrl,
      token,
    );
    const metaErrors = metaResult?.data?.metafieldsSet?.userErrors ?? [];
    if (metaErrors.length > 0) throw new Error(metaErrors[0].message);
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const shopName   = '6kaf1n-gt';
    const token      = env.SHOPIFY_TOKEN;
    const restBase   = `https://${shopName}.myshopify.com/admin/api/2024-01`;

    const url    = new URL(request.url);
    const id     = url.searchParams.get('id');
    const action = url.searchParams.get('action');

    // ── GET /?id={draft_order_id} ─────────────────────────────────────
    if (request.method === 'GET') {
      if (!id) return json({ error: 'Missing id' }, 400);

      try {
        const res  = await fetch(`${restBase}/draft_orders/${id}.json`, {
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
        });
        const data = await res.json();
        return json(data, res.status);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── PUT /?id={id}&action=complete ─────────────────────────────────
    if (request.method === 'PUT' && action === 'complete') {
      if (!id) return json({ error: 'Missing id' }, 400);

      try {
        const res = await fetch(`${restBase}/draft_orders/${id}/complete.json`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
        });
        const data = await res.json();
        return json(data, res.status);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /?action=add-address — add address to customer profile ──────
    if (request.method === 'POST' && action === 'add-address') {
      try {
        const body = await request.json();
        const { customerId, address } = body;

        if (!customerId || !address || !address.address1) {
          return json({ error: 'Missing customerId or address' }, 400);
        }

        const mutation = `
          mutation customerUpdate($input: CustomerInput!) {
            customerUpdate(input: $input) {
              customer { id }
              userErrors { field message }
            }
          }
        `;

        const variables = {
          input: {
            id: `gid://shopify/Customer/${customerId}`,
            addresses: [{
              address1: address.address1,
              address2: address.address2 || '',
              city: address.city || '',
              province: address.province || '',
              country: address.country || '',
              zip: address.zip || '',
              firstName: address.firstName || '',
              lastName: address.lastName || '',
              phone: address.phone || '',
            }],
          },
        };

        const res = await fetch(`${restBase}/graphql.json`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
          body: JSON.stringify({ query: mutation, variables }),
        });

        const result = await res.json();
        const userErrors = result?.data?.customerUpdate?.userErrors;
        if (userErrors && userErrors.length > 0) {
          return json({ error: userErrors[0].message, userErrors }, 422);
        }

        return json({ success: true, data: result.data });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /?action=signup — guest membership signup ────────────────
    if (request.method === 'POST' && action === 'signup') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'validation', message: 'Invalid JSON body' }, 400);
      }

      const { first_name, last_name, email, phone, business_name, address = {} } = body;

      // Validate required fields
      const missing = [];
      if (!first_name)        missing.push('first_name');
      if (!last_name)         missing.push('last_name');
      if (!email)             missing.push('email');
      if (!address.address1)  missing.push('address.address1');
      if (!address.city)      missing.push('address.city');
      if (!address.province)  missing.push('address.province');
      if (!address.zip)       missing.push('address.zip');

      if (missing.length > 0) {
        return json({ error: 'validation', message: `Missing required fields: ${missing.join(', ')}` }, 400);
      }

      // Validate email format
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: 'validation', message: 'Invalid email address' }, 400);
      }

      try {
        const gqlUrl = `${restBase}/graphql.json`;

        // Step 1: Create customer via GraphQL
        const createResult = await gql(
          `mutation customerCreate($input: CustomerInput!) {
            customerCreate(input: $input) {
              customer { id }
              userErrors { field message }
            }
          }`,
          {
            input: {
              firstName: first_name,
              lastName: last_name,
              email,
              phone: phone || '',
              taxExempt: true,
              note: business_name
                ? `membership-signup\nBusiness: ${business_name}`
                : 'membership-signup',
            },
          },
          gqlUrl,
          token,
        );

        let customerGid = createResult?.data?.customerCreate?.customer?.id;

        // Step 2: If duplicate email, look up the existing customer
        const createErrors = createResult?.data?.customerCreate?.userErrors ?? [];
        if (createErrors.length > 0) {
          const isDuplicate = createErrors.some(
            e => e.field?.includes('email') && e.message?.toLowerCase().includes('taken'),
          );
          if (!isDuplicate) {
            return json({ error: 'shopify_error', message: createErrors[0].message }, 422);
          }

          const lookupResult = await gql(
            `query customerByEmail($query: String!) {
              customers(first: 1, query: $query) { edges { node { id tags } } }
            }`,
            { query: `email:${email}` },
            gqlUrl,
            token,
          );
          const existingNode = lookupResult?.data?.customers?.edges?.[0]?.node;
          if (!existingNode) {
            return json({ error: 'shopify_error', message: 'Customer not found after duplicate email' }, 422);
          }
          customerGid = existingNode.id;

          // Already a member — nothing to do
          if (existingNode.tags?.includes('member')) {
            return json({ success: true });
          }
        }

        // Step 3: Save delivery address
        const addrResult = await gql(
          `mutation customerAddressCreate($customerId: ID!, $address: MailingAddressInput!) {
            customerAddressCreate(customerId: $customerId, address: $address) {
              customerAddress { id }
              userErrors { field message }
            }
          }`,
          {
            customerId: customerGid,
            address: {
              firstName: first_name,
              lastName: last_name,
              address1: address.address1,
              address2: address.address2 || '',
              city: address.city,
              province: address.province,
              zip: address.zip,
              country: address.country || 'United States',
              phone: phone || '',
            },
          },
          gqlUrl,
          token,
        );
        const addrErrors = addrResult?.data?.customerAddressCreate?.userErrors ?? [];
        if (addrErrors.length > 0) throw new Error(addrErrors[0].message);

        // Steps 4–6: Apply membership tags + increment founding-member counter if slot open
        await applyMembership(customerGid, gqlUrl, token);

        return json({ success: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /?action=activate-membership — activate for logged-in customer ──
    if (request.method === 'POST' && action === 'activate-membership') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'validation', message: 'Invalid JSON body' }, 400);
      }

      const { customer_id } = body;

      // Validate customer_id — check presence first, then coerce and validate
      if (customer_id == null || customer_id === '') {
        return json({ error: 'validation', message: 'customer_id is required' }, 400);
      }
      const customerId = Number(customer_id);
      if (!Number.isFinite(customerId) || !Number.isInteger(customerId) || customerId <= 0) {
        return json({ error: 'validation', message: 'customer_id must be a positive integer' }, 400);
      }

      try {
        const customerGid = `gid://shopify/Customer/${customerId}`;
        const gqlUrl = `${restBase}/graphql.json`;
        await applyMembership(customerGid, gqlUrl, token);
        return json({ success: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST / — create draft order ───────────────────────────────────
    if (request.method === 'POST') {
      try {
        const cart = await request.json();
        console.log('>>> [Incoming] Email:', cart.email);

        const addr = cart.address || {};

        // Build note — append payment method and promo code if present
        let note = cart.note || '';
        if (cart.paymentMethod?.label) {
          note = note
            ? `${note}\n\nPayment method: ${cart.paymentMethod.label}`
            : `Payment method: ${cart.paymentMethod.label}`;
        }
        if (cart.promoCode) {
          note = note
            ? `${note}\nPromo code: ${cart.promoCode}`
            : `Promo code: ${cart.promoCode}`;
        }

        const draftOrder = {
          // Change A: Map memberDiscounts to per-line-item applied_discount
          line_items: (() => {
            const discountMap = {};
            if (Array.isArray(cart.memberDiscounts)) {
              for (const d of cart.memberDiscounts) {
                discountMap[String(d.variantId)] = d;  // Fix 2: normalize key to string
              }
            }
            return cart.items.map(item => {
              const variantId = String(item.variant_id || item.id);  // Fix 2: normalize lookup key
              const lineItem = { variant_id: variantId, quantity: item.quantity };
              const disc = discountMap[variantId];
              if (disc && disc.discountCents > 0) {
                lineItem.applied_discount = {
                  description: disc.title || 'Membership discount',
                  value_type:  'fixed_amount',
                  value:       (disc.discountCents / 100).toFixed(2),
                  // Fix 1: removed read-only `amount` field (computed by Shopify)
                };
              }
              return lineItem;
            });
          })(),
          email: cart.email,
          ...(cart.customerId && { customer: { id: Number(cart.customerId) } }),
          shipping_address: {
            first_name: addr.first_name || '',
            last_name:  addr.last_name  || '',
            address1:   addr.address1   || '',
            address2:   addr.address2   || '',
            city:       addr.city       || '',
            province:   addr.province   || '',
            country:    addr.country    || 'US',
            zip:        addr.zip        || '',
          },
          tags: [cart.tags, cart.paymentMethod?.id].filter(Boolean).join(', '),
          ...(note                 && { note }),
          // Change C: Zero out shipping_line.price when freeShipping is true
          ...(cart.shippingLine && {
            shipping_line: {
              title: cart.shippingLine.title,
              price: cart.freeShipping ? '0.00' : cart.shippingLine.price,
            },
          }),
          // If free shipping but no rate selected (edge case)
          ...(!cart.shippingLine && cart.freeShipping && {
            shipping_line: {
              title: 'Standard Shipping (Free)',
              price: '0.00',
            },
          }),
          // Change B: Add order-level applied_discount for promo code
          ...(cart.promoAmountCents > 0 && {
            applied_discount: {
              description: cart.promoCode ? `Promo code: ${cart.promoCode}` : 'Promo discount',
              value_type:  'fixed_amount',
              value:       (cart.promoAmountCents / 100).toFixed(2),
              // Fix 1: removed read-only `amount` field (computed by Shopify)
            },
          }),
        };

        const res = await fetch(`${restBase}/draft_orders.json`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
          body: JSON.stringify({ draft_order: draftOrder }),
        });

        const result = await res.json();

        return json(result, res.status);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    return new Response('Method not allowed', { status: 405, headers: CORS });
  },
};
