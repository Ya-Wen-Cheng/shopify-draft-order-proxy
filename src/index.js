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
 *   PUT  /pickup/deliver                    → add 'delivered' tag to a sourced order
 *   GET  /invoice/{order_id}                → printable order invoice
 */

export { CostChangeHandler } from './cost-change-handler.js';

import { getPickupData, updateLineItems, completeDraftOrder, markOrderDelivered } from './pickup.js';
import { renderPickupPage } from './pickup-template.js';
import { renderInvoiceHtml } from './invoice-template.js';

// ── Membership helpers ────────────────────────────────────────────────────────

function normalizeUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return 'https://' + url;
}

/**
 * Build a metafields array for the membership namespace.
 * Only includes fields with a non-empty value.
 * `ordering_method` is stored as list.single_line_text_field (JSON array string).
 * `website` is stored as url type.
 * All others are single_line_text_field.
 */
function buildMetafields(body) {
  const fields = [
    { key: 'business_type',       value: body.business_type },
    { key: 'business_subtype',    value: body.business_subtype },
    { key: 'restaurant_hours',    value: body.restaurant_hours },
    { key: 'website',             value: normalizeUrl(body.website) },
    { key: 'delivery_door',       value: body.delivery_door },
    { key: 'manager_name',        value: body.manager_name },
    { key: 'manager_phone',       value: body.manager_phone },
    { key: 'manager_email',       value: body.manager_email },
    { key: 'chef_name',           value: body.chef_name },
    { key: 'chef_phone',          value: body.chef_phone },
    { key: 'chef_email',          value: body.chef_email },
    { key: 'emergency_name',      value: body.emergency_name },
    { key: 'emergency_title',     value: body.emergency_title },
    { key: 'emergency_phone',     value: body.emergency_phone },
    { key: 'emergency_alt_phone', value: body.emergency_alt_phone },
    {
      key: 'ordering_method',
      // Fix 6: coerce string → array so callers can pass either form
      value: (() => {
        const orderingMethod = Array.isArray(body.ordering_method)
          ? body.ordering_method
          : (typeof body.ordering_method === 'string' ? [body.ordering_method] : []);
        return orderingMethod.length > 0 ? JSON.stringify(orderingMethod) : '';
      })(),
    },
  ];

  return fields
    .filter(f => f.value && f.value.length > 0)
    .map(f => ({
      namespace: 'membership',
      key: f.key,
      value: f.value,
      type: f.key === 'ordering_method'
        ? 'list.single_line_text_field'
        : 'single_line_text_field',
    }));
}

async function updateEmailMarketing(restBase, token, customerGid, acceptsMarketing) {
  const mutation = `
    mutation customerEmailMarketingConsentUpdate(
      $customerId: ID!
      $marketingState: CustomerEmailMarketingState!
      $marketingOptInLevel: CustomerMarketingOptInLevel!
    ) {
      customerEmailMarketingConsentUpdate(input: {
        customerId: $customerId
        emailMarketingConsent: {
          marketingState: $marketingState
          marketingOptInLevel: $marketingOptInLevel
        }
      }) {
        customer { id }
        userErrors { field message code }
      }
    }
  `;
  await fetch(`${restBase}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({
      query: mutation,
      variables: {
        customerId: customerGid,
        marketingState: acceptsMarketing ? 'SUBSCRIBED' : 'UNSUBSCRIBED',
        marketingOptInLevel: 'SINGLE_OPT_IN',
      },
    }),
  });
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

    // ── GET /?action=check-phone — check if phone is already on a customer ──
    if (request.method === 'GET' && action === 'check-phone') {
      const phone = url.searchParams.get('phone');
      if (!phone) return json({ error: 'phone param required' }, 400);
      const query = `
        query checkPhone($q: String!) {
          customers(first: 1, query: $q) {
            edges { node { id } }
          }
        }
      `;
      const res = await fetch(`${restBase}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables: { q: `phone:${phone}` } }),
      });
      const result = await res.json();
      const taken = (result?.data?.customers?.edges?.length ?? 0) > 0;
      return json({ taken });
    }

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

    // ── PUT /pickup/deliver — add 'delivered' tag to a sourced order ──
    if (url.pathname === '/pickup/deliver' && request.method === 'PUT') {
      try {
        const body = await request.json();
        if (!body.order_id) return json({ error: 'order_id required' }, 400);
        const result = await markOrderDelivered(restBase, token, body.order_id);
        return json(result);
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

      const { first_name, last_name, email, phone, address = {},
              restaurant_name, restaurant_phone,
              business_type, business_subtype,
              emergency_name, emergency_phone,
              ordering_method } = body;

      const memberTags = ['member'];

      // Validate required fields
      const missing = [];
      if (!first_name)                                       missing.push('first_name');
      if (!last_name)                                        missing.push('last_name');
      if (!email)                                            missing.push('email');
      if (!phone)                                            missing.push('phone');
      if (!restaurant_name)                                  missing.push('restaurant_name');
      if (!restaurant_phone)                                 missing.push('restaurant_phone');
      if (!business_type)                                    missing.push('business_type');
      if (!business_subtype)                                 missing.push('business_subtype');
      if (!emergency_name)                                   missing.push('emergency_name');
      if (!emergency_phone)                                  missing.push('emergency_phone');
      if (!Array.isArray(ordering_method) || ordering_method.length === 0) missing.push('ordering_method');
      if (!address.address1)                                 missing.push('address.address1');
      if (!address.city)                                     missing.push('address.city');
      if (!address.province)                                 missing.push('address.province');
      if (!address.zip)                                      missing.push('address.zip');

      if (missing.length > 0) {
        return json({ error: 'validation', message: `Missing required fields: ${missing.join(', ')}` }, 400);
      }

      // Validate email format
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: 'validation', message: 'Invalid email address' }, 400);
      }

      const metafields = buildMetafields(body);

      const createMutation = `
        mutation customerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer { id email }
            userErrors { field message }
          }
        }
      `;

      const createInput = {
        firstName: first_name,
        lastName: last_name,
        email,
        phone,
        note: 'membership-signup',
        tags: memberTags,
        taxExempt: true,
        addresses: [{
          firstName: first_name,
          lastName: last_name,
          company: restaurant_name,
          address1: address.address1,
          address2: address.address2 || '',
          city: address.city,
          province: address.province,
          zip: address.zip,
          countryCode: 'US',
          phone: restaurant_phone,
        }],
        metafields,
      };

      try {
        const createRes = await fetch(`${restBase}/graphql.json`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
          body: JSON.stringify({ query: createMutation, variables: { input: createInput } }),
        });

        const createResult = await createRes.json();

        // Top-level GraphQL errors (network/schema errors, not userErrors)
        if (createResult?.errors?.length) {
          return json({ success: false, error: createResult.errors[0].message }, 500);
        }

        let userErrors = createResult?.data?.customerCreate?.userErrors || [];

        // If phone is taken, retry without it — same behaviour as activate-membership
        const isPhoneTakenOnCreate = userErrors.some(
          e => /phone/i.test(e.field?.join?.('') ?? '') && /taken/i.test(e.message)
        );
        let phoneSkipped = false;
        if (isPhoneTakenOnCreate) {
          phoneSkipped = true;
          const { phone: _omit, ...createInputWithoutPhone } = createInput;
          const retryRes = await fetch(`${restBase}/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            body: JSON.stringify({ query: createMutation, variables: { input: createInputWithoutPhone } }),
          });
          const retryResult = await retryRes.json();
          if (retryResult?.errors?.length) {
            return json({ success: false, error: retryResult.errors[0].message }, 500);
          }
          userErrors = retryResult?.data?.customerCreate?.userErrors || [];
        }

        // Check for duplicate email error
        const isDuplicateEmail = userErrors.some(
          e => e.field?.includes('email') && /taken|exists|already/i.test(e.message)
        );

        if (isDuplicateEmail) {
          // Find existing customer
          const findQuery = `
            query findCustomer($query: String!) {
              customers(first: 1, query: $query) {
                edges { node { id email note tags } }
              }
            }
          `;
          const findRes = await fetch(`${restBase}/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            body: JSON.stringify({ query: findQuery, variables: { query: `email:${email}` } }),
          });
          const findResult = await findRes.json();
          const existingCustomer = findResult?.data?.customers?.edges?.[0]?.node;

          if (!existingCustomer) {
            return json({ error: 'shopify_error', message: 'Duplicate email but customer not found' }, 422);
          }

          // Overwrite customer info + metafields, preserve existing tags
          const existingTags = existingCustomer.tags || [];
          const mergedTags = [...new Set([...existingTags, ...memberTags])];
          const dupUpdateMutation = `
            mutation customerUpdate($input: CustomerInput!) {
              customerUpdate(input: $input) {
                customer { id }
                userErrors { field message }
              }
            }
          `;
          const dupUpdateRes = await fetch(`${restBase}/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            body: JSON.stringify({
              query: dupUpdateMutation,
              variables: { input: {
                id: existingCustomer.id,
                firstName: first_name,
                lastName: last_name,
                phone,
                note: 'membership-signup',
                tags: mergedTags,
                taxExempt: true,
                metafields,
              }},
            }),
          });
          const dupUpdateResult = await dupUpdateRes.json();
          const dupErrors = dupUpdateResult?.data?.customerUpdate?.userErrors || [];
          if (dupErrors.length > 0) {
            return json({ error: dupErrors[0].message, userErrors: dupErrors }, 422);
          }

          // Append restaurant address as default (do not overwrite existing addresses)
          const addAddressMutation = `
            mutation customerAddressCreate($customerId: ID!, $address: MailingAddressInput!, $setAsDefault: Boolean!) {
              customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: $setAsDefault) {
                address { id }
                userErrors { field message }
              }
            }
          `;
          await fetch(`${restBase}/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            body: JSON.stringify({
              query: addAddressMutation,
              variables: {
                customerId: existingCustomer.id,
                setAsDefault: true,
                address: {
                  firstName: first_name,
                  lastName: last_name,
                  company: restaurant_name,
                  address1: address.address1,
                  address2: address.address2 || '',
                  city: address.city,
                  province: address.province,
                  zip: address.zip,
                  countryCode: 'US',
                  phone: restaurant_phone,
                },
              },
            }),
          });

          await updateEmailMarketing(restBase, token, existingCustomer.id, body.accepts_marketing);
          return json({ success: true, phone_skipped: phoneSkipped, customer: { id: existingCustomer.id, email: existingCustomer.email } });
        }

        // Any other userErrors = hard failure
        if (userErrors.length > 0) {
          return json({ error: 'shopify_error', message: userErrors[0].message, userErrors }, 422);
        }

        const newCustomer = createResult?.data?.customerCreate?.customer;
        // Fix 4: null guard — customerCreate returned no customer object
        if (!newCustomer) {
          return json({ error: 'shopify_error', message: 'Customer was not returned by Shopify' }, 500);
        }
        await updateEmailMarketing(restBase, token, newCustomer.id, body.accepts_marketing);
        return json({ success: true, phone_skipped: phoneSkipped, customer: { id: newCustomer.id, email: newCustomer.email } });
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
      const activateTags = ['member'];

      // Validate customer_id — check presence first, then coerce and validate
      if (customer_id == null || customer_id === '') {
        return json({ error: 'validation', message: 'customer_id is required' }, 400);
      }
      const customerId = Number(customer_id);
      if (!Number.isFinite(customerId) || !Number.isInteger(customerId) || customerId <= 0) {
        return json({ error: 'validation', message: 'customer_id must be a positive integer' }, 400);
      }

      // Validate required fields — same set as signup
      const activateMissing = [];
      if (!body.first_name)        activateMissing.push('first_name');
      if (!body.last_name)         activateMissing.push('last_name');
      if (!body.restaurant_name)   activateMissing.push('restaurant_name');
      if (!body.restaurant_phone)  activateMissing.push('restaurant_phone');
      if (!body.business_type)     activateMissing.push('business_type');
      if (!body.business_subtype)  activateMissing.push('business_subtype');
      if (!body.emergency_name)    activateMissing.push('emergency_name');
      if (!body.emergency_phone)   activateMissing.push('emergency_phone');
      if (!Array.isArray(body.ordering_method) || body.ordering_method.length === 0) activateMissing.push('ordering_method');
      const addr = body.address || {};
      if (!addr.address1)          activateMissing.push('address.address1');
      if (!addr.city)              activateMissing.push('address.city');
      if (!addr.province)          activateMissing.push('address.province');
      if (!addr.zip)               activateMissing.push('address.zip');

      if (activateMissing.length > 0) {
        return json({ error: 'validation', message: `Missing required fields: ${activateMissing.join(', ')}` }, 400);
      }

      try {
        // Step 1: GET current customer to check idempotency
        const getRes = await fetch(`${restBase}/customers/${customerId}.json`, {
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
        });

        const getResult = await getRes.json();

        // Fix 5: use !getRes.ok (covers 4xx/5xx) and safe error message fallback
        if (!getRes.ok) {
          return json({ error: 'shopify_error', message: JSON.stringify(getResult.errors || 'Unknown Shopify error') }, 422);
        }

        // We still read the note to build the combined note value, but we never early-return.
        // Fix 3: removed idempotency early-return — customerUpdate is safe to call repeatedly.
        const existingNote = getResult.customer.note || '';

        // Step 2: Write metafields + membership-signup note via GraphQL customerUpdate (always)
        const metafields = buildMetafields(body);

        const updateMutation = `
          mutation customerUpdate($input: CustomerInput!) {
            customerUpdate(input: $input) {
              customer { id }
              userErrors { field message }
            }
          }
        `;

        const updateInput = {
          id: `gid://shopify/Customer/${customerId}`,
          firstName: body.first_name,
          lastName:  body.last_name,
          phone:     body.phone,
          // Build combined note: prepend membership-signup, preserving any prior content
          note: existingNote && !existingNote.startsWith('membership-signup')
            ? `membership-signup\n${existingNote}`
            : 'membership-signup',
          tags: activateTags,
          taxExempt: true,
          metafields,
        };

        const updateRes = await fetch(`${restBase}/graphql.json`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
          body: JSON.stringify({ query: updateMutation, variables: { input: updateInput } }),
        });

        let updateResult = await updateRes.json();
        let userErrors = updateResult?.data?.customerUpdate?.userErrors || [];

        // If phone is taken by another account, retry without it — phone stays unchanged
        const phoneTaken = userErrors.some(e => /phone/i.test(e.field?.join?.('') ?? '') && /taken/i.test(e.message));
        if (phoneTaken) {
          const { phone: _omit, ...updateInputWithoutPhone } = updateInput;
          const retryRes = await fetch(`${restBase}/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
            body: JSON.stringify({ query: updateMutation, variables: { input: updateInputWithoutPhone } }),
          });
          updateResult = await retryRes.json();
          userErrors = updateResult?.data?.customerUpdate?.userErrors || [];
        }

        if (userErrors.length > 0) {
          return json({ error: userErrors[0].message, userErrors }, 422);
        }

        // Step 3: Add restaurant address as default (OTP accounts start with no address)
        const addAddressMutation = `
          mutation customerAddressCreate($customerId: ID!, $address: MailingAddressInput!, $setAsDefault: Boolean!) {
            customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: $setAsDefault) {
              address { id }
              userErrors { field message }
            }
          }
        `;
        await fetch(`${restBase}/graphql.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
          body: JSON.stringify({
            query: addAddressMutation,
            variables: {
              customerId: `gid://shopify/Customer/${customerId}`,
              setAsDefault: true,
              address: {
                firstName:  body.first_name,
                lastName:   body.last_name,
                company:    body.restaurant_name,
                address1:   addr.address1,
                address2:   addr.address2 || '',
                city:       addr.city,
                province:   addr.province,
                zip:        addr.zip,
                countryCode: 'US',
                phone:      body.restaurant_phone,
              },
            },
          }),
        });

        await updateEmailMarketing(restBase, token, `gid://shopify/Customer/${customerId}`, body.accepts_marketing);

        return json({ success: true, phone_skipped: phoneTaken });
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
