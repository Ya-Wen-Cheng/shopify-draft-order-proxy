# Cost Change Webhook

## Feature: Cost Change Audit Log

> "As an operator, I want every product cost change to be automatically logged with old cost, new cost, date, and source — so that I can audit pricing history directly in Shopify Admin."

| AC# | Criteria | Test file | Test case name |
|-----|----------|-----------|----------------|
| 1 | Every cost change is logged to `custom.cost_change_log` with old cost, new cost, date, and source | `test/cost-change-handler.spec.js` | logs a single-variant cost change without a variant column |
| 2 | Log entries show `$X.XX → $Y.YY` format for costs | `test/cost-change-handler.spec.js` | logs a single-variant cost change without a variant column |
| 3 | Log entries include an ISO date (`YYYY-MM-DD`) | `test/cost-change-handler.spec.js` | logs a single-variant cost change without a variant column |
| 4 | Source defaults to `manual` when `cost_change_source` is absent | `test/cost-change-handler.spec.js` | logs a single-variant cost change without a variant column |
| 5 | Source is read from `cost_change_source` metafield (e.g. `order:#D1`) and cleared after logging | `test/cost-change-handler.spec.js` | uses cost_change_source when present and clears it after logging |
| 6 | Log is prepended (newest entry first) and stored as `multi_line_text_field` readable in Admin | `test/cost-change-handler.spec.js` | prepends new log entries, keeping newest first |
| 7 | Multi-variant products include the variant title column; single-variant products omit it | `test/cost-change-handler.spec.js` | logs a multi-variant cost change with the variant title / logs a single-variant cost change without a variant column |

## Feature: Reliability & Security

> "As a developer, I want the webhook to be secure, idempotent, and self-healing — so that cost records are never silently lost or corrupted."

| AC# | Criteria | Test file | Test case name |
|-----|----------|-----------|----------------|
| 8 | Valid HMAC signature returns 200; invalid returns 401 with no Shopify API calls | `test/cost-change-webhook.spec.js` | returns 401 when HMAC signature is invalid / returns 401 when HMAC header is missing |
| 9 | Null cost in payload returns 200 immediately with no API calls | `test/cost-change-webhook.spec.js` | returns 200 immediately when cost is null, with no Shopify API calls |
| 10 | Unchanged cost (matches `last_known_cost`) returns 200 with no write | `test/cost-change-handler.spec.js` | returns 200 with no mutation when cost is unchanged |
| 11 | Missing `last_known_cost` initializes the metafield with current cost; no log entry written | `test/cost-change-handler.spec.js` | initializes last_known_cost with no log entry when missing |
| 12 | Failed Shopify API calls are retried up to 2× then return 500 (triggering Shopify's own retry) | `test/cost-change-handler.spec.js` | retries failed Shopify API calls up to 2x then returns 500 |
