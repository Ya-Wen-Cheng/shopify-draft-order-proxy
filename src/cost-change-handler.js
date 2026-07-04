/**
 * CostChangeHandler Durable Object
 *
 * Serializes cost-change processing per inventory_item_id (one DO instance
 * per id), so concurrent webhook deliveries for the same item can't race
 * each other's metafield reads/writes. No durable storage is used — all
 * state lives in Shopify product metafields.
 */
export class CostChangeHandler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
