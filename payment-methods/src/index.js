/**
 * AIGO Shopify Payment Methods Proxy
 *
 * Routes:
 *   OPTIONS /   → CORS preflight
 *   GET     /   → list store's enabled manual payment gateways
 *
 * Returns:
 *   [{ id: string, name: string, description: string, chips: string[] }]
 *
 * Filters out:
 *   - Non-manual gateways (type !== 'manual')
 *   - Disabled gateways (enabled === false)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** Derive short badge labels from a payment gateway name. */
export function deriveChips(name) {
  // Extract text in parentheses: "Bank Transfer (ACH)" → ["ACH"]
  const parenMatch = name.match(/\(([^)]+)\)/);
  if (parenMatch) return [parenMatch[1].toUpperCase()];

  const lc = name.toLowerCase();
  if (lc.includes('net 30'))      return ['NET 30'];
  if (lc.includes('net 60'))      return ['NET 60'];
  if (lc.includes('net 45'))      return ['NET 45'];
  if (lc.includes('invoice'))     return ['INVOICE'];
  if (lc.includes('credit card')) return ['VISA', 'MC', 'AMEX'];
  if (lc.includes('check'))       return ['CHECK'];
  if (lc.includes('zelle'))       return ['ZELLE'];
  if (lc.includes('venmo'))       return ['VENMO'];
  if (lc.includes('cash'))        return ['CASH'];
  if (lc.includes('wire'))        return ['WIRE'];

  // Default: first word uppercased, max 6 chars
  return [name.split(/[\s·(]/)[0].toUpperCase().slice(0, 6)];
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    const shopName = '6kaf1n-gt';
    const token    = env.SHOPIFY_TOKEN;
    const restBase = `https://${shopName}.myshopify.com/admin/api/2024-01`;

    try {
      const res = await fetch(`${restBase}/payment_gateways.json`, {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
      });

      if (!res.ok) {
        const err = await res.text();
        return json({ error: `Shopify error: ${err}` }, res.status);
      }

      const data = await res.json();
      const gateways = (data.payment_gateways || [])
        .filter(g => g.type === 'manual' && g.enabled !== false)
        .map(g => ({
          id:          String(g.id),
          name:        g.name,
          description: g.description || '',
          chips:       deriveChips(g.name),
        }));

      return json(gateways);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
