/**
 * AIGO Shopify Draft Order Proxy
 *
 * Routes:
 *   GET  /?id={draft_order_id}      → fetch a draft order
 *   PUT  /?id={id}&action=complete  → complete a draft order → real order
 *   POST /?action=add-address       → add address to customer profile
 *   POST /                          → create a draft order from cart
 */

import { sendOrderConfirmationEmail } from './send-email.js';

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
          line_items: cart.items.map(item => ({
            variant_id: item.variant_id || item.id,
            quantity:   item.quantity,
          })),
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
          ...(cart.shippingLine    && {
            shipping_line: {
              title: cart.shippingLine.title,
              price: cart.shippingLine.price,
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

        // Send confirmation email non-blocking
        if (res.status === 201 && result.draft_order) {
          ctx.waitUntil(
            sendOrderConfirmationEmail(result.draft_order, env)
              .catch(err => console.error('[Email] Failed to send confirmation:', err))
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
