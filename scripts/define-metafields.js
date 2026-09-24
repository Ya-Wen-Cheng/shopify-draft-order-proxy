/**
 * define-metafields.js
 *
 * One-time script: creates 16 customer metafield definitions under the
 * "membership" namespace via the Shopify Admin GraphQL API.
 *
 * Usage:
 *   SHOPIFY_ADMIN_TOKEN=<token> SHOPIFY_SHOP_NAME=<subdomain> node scripts/define-metafields.js
 *
 * Safe to re-run — definitions that already exist are skipped (idempotent).
 * Requires Node 18+ (native fetch).
 */

const API_VERSION = '2025-04';

const token      = process.env.SHOPIFY_ADMIN_TOKEN;
const shopDomain = process.env.SHOPIFY_SHOP_NAME && `${process.env.SHOPIFY_SHOP_NAME}.myshopify.com`;
const ENDPOINT   = `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`;

if (!token || !shopDomain) {
  console.error('Usage: SHOPIFY_ADMIN_TOKEN=<token> SHOPIFY_SHOP_NAME=<subdomain> node src/define-metafields.js');
  process.exit(1);
}

// definitions

const DEFINITIONS = [
  { key: 'business_type',    name: 'Business Type',                     type: 'single_line_text_field' },
  { key: 'business_subtype', name: 'Business Subcategory',              type: 'single_line_text_field' },
  { key: 'restaurant_hours', name: 'Restaurant Hours',                  type: 'single_line_text_field' },
  { key: 'website',          name: 'Website',                           type: 'url' }, // Worker must normalize bare domains to https:// before setting this metafield
  { key: 'delivery_door',    name: 'Location of Delivery Door',         type: 'single_line_text_field' },
  { key: 'manager_name',     name: 'Manager Name',                      type: 'single_line_text_field' },
  { key: 'manager_phone',    name: 'Manager Phone',                     type: 'single_line_text_field' },
  { key: 'manager_email',    name: 'Manager Email',                     type: 'single_line_text_field' },
  { key: 'chef_name',        name: 'Kitchen Manager / Chef Name',       type: 'single_line_text_field' },
  { key: 'chef_phone',       name: 'Kitchen Manager / Chef Phone',      type: 'single_line_text_field' },
  { key: 'chef_email',       name: 'Kitchen Manager / Chef Email',      type: 'single_line_text_field' },
  { key: 'emergency_name',   name: 'Emergency Contact Name',            type: 'single_line_text_field' },
  { key: 'emergency_title',  name: 'Emergency Contact Title',           type: 'single_line_text_field' },
  { key: 'emergency_phone',  name: 'Emergency Cell Number',             type: 'single_line_text_field' },
  { key: 'emergency_alt_phone', name: 'Emergency Alternate Number',     type: 'single_line_text_field' },
  // list of up to 4 values: 'Online' | 'Text' | 'Call' | 'Whatsapp'
  { key: 'ordering_method',  name: 'Preferred Ordering Method',         type: 'list.single_line_text_field' },
];

// GraphQL mutation

const MUTATION = `
  mutation metafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        key
        namespace
      }
      userErrors {
        field
        code
        message
      }
    }
  }
`;

// helpers

/**
 * Returns true if the userErrors array contains an "already taken" error,
 * which Shopify returns when the definition already exists.
 */
function isAlreadyExists(userErrors) {
  return userErrors.some(
    (e) =>
      e.code === 'TAKEN' ||
      e.code === 'ALREADY_EXISTS' ||
      e.message.toLowerCase().includes('has already been taken') ||
      e.message.toLowerCase().includes('already exists')
  );
}

async function createDefinition(def) {
  const variables = {
    definition: {
      name:      def.name,
      namespace: 'membership',
      key:       def.key,
      type:      def.type,
      ownerType: 'CUSTOMER',
    },
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type':           'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query: MUTATION, variables }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  const body = await res.json();

  if (body.errors) {
    throw new Error(JSON.stringify(body.errors));
  }

  const { createdDefinition, userErrors } = body.data.metafieldDefinitionCreate;

  if (userErrors && userErrors.length > 0) {
    if (isAlreadyExists(userErrors)) {
      return { status: 'skipped' };
    }
    throw new Error(userErrors.map((e) => `[${e.field}] ${e.message}`).join('; '));
  }

  return { status: 'created', id: createdDefinition.id };
}

// main

async function main() {
  console.log(`Creating ${DEFINITIONS.length} metafield definitions on ${SHOP_DOMAIN}...\n`);

  let created = 0;
  let skipped = 0;
  let failed  = 0;

  for (const def of DEFINITIONS) {
    const label = `membership.${def.key} (${def.type})`;
    try {
      const result = await createDefinition(def);
      if (result.status === 'skipped') {
        console.log(`  SKIP  ${label} — already exists`);
        skipped++;
      } else {
        console.log(`  OK    ${label} — created (${result.id})`);
        created++;
      }
    } catch (err) {
      console.error(`  FAIL  ${label} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. created=${created}, skipped=${skipped}, failed=${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
