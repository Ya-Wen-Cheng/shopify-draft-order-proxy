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
 *   POST /webhook/cost-update               → Shopify inventory_items/update webhook
 *
 *   GET  /pickup                            → Pickup Assistant mobile UI (G19)
 *   GET  /pickup/data                       → open draft orders tagged draft-order-tab
 *   PUT  /pickup/update                     → update draft order line items (fetch-then-merge)
 *   PUT  /pickup/complete                   → complete draft order, tag resulting order `sourced`
 *   GET  /invoice/{order_id}                → printable order invoice
 */

export { CostChangeHandler } from './cost-change-handler.js';

import { getPickupData, updateLineItems, completeDraftOrder } from './pickup.js';
import { renderPickupPage } from './pickup-template.js';
import { renderInvoiceHtml } from './invoice-template.js';

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

// ── Shopify webhook HMAC verification ───────────────────────────────────────

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computedHmac = btoa(String.fromCharCode(...new Uint8Array(signature)));

  return timingSafeEqual(computedHmac, hmacHeader);
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

    // ── POST /webhook/cost-update — Shopify inventory_items/update ─────
    if (request.method === 'POST' && url.pathname === '/webhook/cost-update') {
      const rawBody   = await request.text();
      const hmacHeader = request.headers.get('X-Shopify-Hmac-Sha256');
      const valid = await verifyShopifyHmac(rawBody, hmacHeader, env.SHOPIFY_WEBHOOK_SECRET);

      if (!valid) {
        return json({ error: 'Invalid HMAC signature' }, 401);
      }

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch (err) {
        return json({ error: 'Invalid JSON payload' }, 400);
      }

      if (payload.cost === null || payload.cost === undefined) {
        return json({ ok: true }, 200);
      }

      try {
        const doId   = env.COST_CHANGE_HANDLER.idFromName(String(payload.id));
        const stub   = env.COST_CHANGE_HANDLER.get(doId);
        const doRes  = await stub.fetch('https://cost-change-handler/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: rawBody,
        });
        const doData = await doRes.json().catch(() => ({}));
        return json(doData, doRes.status);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /pickup — Pickup Assistant mobile UI ───────────────────────
    if (url.pathname === '/pickup' && request.method === 'GET') {
      return new Response(renderPickupPage(), { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // ── GET /pickup/data — open draft orders tagged draft-order-tab ───
    if (url.pathname === '/pickup/data' && request.method === 'GET') {
      try {
        const draftOrders = await getPickupData(restBase, token);
        return json({ draft_orders: draftOrders });
      } catch (err) {
        return json({ error: err.message }, err.status || 500);
      }
    }

    // ── PUT /pickup/update — fetch-then-merge line item updates ───────
    if (url.pathname === '/pickup/update' && request.method === 'PUT') {
      try {
        const body = await request.json();
        const { draft_order_id, updates } = body;
        if (!draft_order_id || !Array.isArray(updates)) {
          return json({ error: 'Missing draft_order_id or updates' }, 400);
        }
        const result = await updateLineItems(restBase, token, draft_order_id, updates);
        return json(result.body, result.status);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── PUT /pickup/complete — complete draft order, tag order `sourced` ──
    if (url.pathname === '/pickup/complete' && request.method === 'PUT') {
      try {
        const body = await request.json();
        const { draft_order_id, changes } = body;
        if (!draft_order_id) {
          return json({ error: 'Missing draft_order_id' }, 400);
        }
        const result = await completeDraftOrder(restBase, token, draft_order_id, changes);
        return json(result.body, result.status);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /invoice/{order_id} — printable invoice ────────────────────
    if (url.pathname.startsWith('/invoice/') && request.method === 'GET') {
      const orderId = url.pathname.slice('/invoice/'.length);
      if (!orderId) return json({ error: 'Missing order id' }, 400);

      try {
        const res = await fetch(`${restBase}/orders/${orderId}.json`, {
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
        });
        const data = await res.json();
        if (!res.ok) {
          return json({ error: 'shopify_error', message: JSON.stringify(data.errors) }, res.status);
        }
        return new Response(renderInvoiceHtml(data.order), { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

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

      const customerPayload = {
        customer: {
          first_name,
          last_name,
          email,
          phone: phone || '',
          note: business_name
            ? `membership-signup\nBusiness: ${business_name}`
            : 'membership-signup',
          addresses: [{
            first_name,
            last_name,
            address1: address.address1,
            address2: address.address2 || '',
            city: address.city,
            province: address.province,
            zip: address.zip,
            country: address.country || 'United States',
            phone: phone || '',
          }],
        },
      };

      try {
        const res = await fetch(`${restBase}/customers.json`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
          body: JSON.stringify(customerPayload),
        });

        const result = await res.json();

        if (res.status === 422 && result.errors?.email) {
          return json({ error: 'duplicate_email', message: 'An account with this email already exists.' }, 409);
        }

        if (res.status !== 201) {
          return json({ error: 'shopify_error', message: JSON.stringify(result.errors) }, 422);
        }

        return json({ success: true, customer: { id: result.customer.id, email: result.customer.email } });
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
        // Step 1: GET current customer note to avoid clobbering it
        const getRes = await fetch(`${restBase}/customers/${customerId}.json`, {
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
        });

        const getResult = await getRes.json();

        if (getRes.status !== 200) {
          return json({ error: 'shopify_error', message: JSON.stringify(getResult.errors) }, 422);
        }

        const existingNote = getResult.customer.note || '';

        // Step 2: Idempotency check — skip PUT if already marked
        if (existingNote.startsWith('membership-signup')) {
          return json({ success: true });
        }

        // Step 3: Prepend marker to existing note
        const newNote = existingNote ? `membership-signup\n${existingNote}` : 'membership-signup';

        // Step 4: PUT the combined note
        const putRes = await fetch(`${restBase}/customers/${customerId}.json`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
          body: JSON.stringify({ customer: { id: customerId, note: newNote } }),
        });

        const putResult = await putRes.json();

        if (putRes.status !== 200) {
          return json({ error: 'shopify_error', message: JSON.stringify(putResult.errors) }, 422);
        }

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
          customer: { id: cart.customerId },
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

        // Send draft order invoice via Shopify (non-blocking)
        if (res.status === 201 && result.draft_order) {
          ctx.waitUntil(
            fetch(`${restBase}/draft_orders/${result.draft_order.id}/send_invoice.json`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': token,
              },
              body: JSON.stringify({ draft_order_invoice: {} }),
            }).catch(err => console.error('[Invoice] Failed to send:', err))
          );
        }

        return json(result, res.status);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    return new Response('Method not allowed', { status: 405, headers: CORS });
  },
};
