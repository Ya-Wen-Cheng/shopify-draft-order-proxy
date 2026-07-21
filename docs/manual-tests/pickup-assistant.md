# Manual Tests — Pickup Assistant (G19)

## Pre-requisites

- Worker deployed to Cloudflare (`npx wrangler deploy`)
- `SHOPIFY_TOKEN` set in Cloudflare dashboard
- One draft order created in Shopify Admin, tagged `draft-order-tab`, with the 6 line items below
- At least one product tagged `weight` in Shopify Admin (used for items A, B, and C)
- At least one product **without** the `weight` tag (used for items D, E, and F)
- All items have a recorded cost in Shopify Admin (Inventory → cost field) except item B (to verify N/A display)

## Test Order Setup

Create a single draft order in Shopify Admin tagged `draft-order-tab` with these line items:

| Label | Product type | Qty | Notes |
|-------|-------------|-----|-------|
| A     | Weight variant | 2 | Per-item mode test |
| B     | Weight variant (no cost recorded) | 3 | Bulk mode + N/A cost test |
| C     | Weight variant | 3 | Same Weight mode + qty reduction test |
| D     | Unit variant | 1 | Found + price-only update |
| E     | Unit variant | 4 | Partial + cost-only update |
| F     | Unit variant | 1 | Removed |

Note the current cost and price for items A, C, and D before testing.

---

## Tests

### 1. Page load

1. [ ] Navigate to `/pickup` in a mobile browser (or browser devtools mobile view)
2. [ ] Draft order card appears with the correct order name and customer name
3. [ ] Timestamp is shown below the order name
4. [ ] Items A, B, and C show `[Update Cost & Price]` and `[Update Weight]` buttons — no Found/Partial/Removed
5. [ ] Items D, E, and F show `[Update Cost & Price]` and `[Found It]` `[Partial]` `[Removed]` buttons — no Update Weight
6. [ ] Item B shows `Cost: N/A` and `Margin: N/A` (no cost recorded)
7. [ ] Order summary shows `Cost: N/A` (because item B has no cost)
8. [ ] Complete button is **disabled**

---

### 2. Item A — weight item, per-item mode, cost + price update

9. [ ] Click `[Update Cost & Price]` on item A — cost/price panel expands inline
10. [ ] Enter a cost value — suggested prices at 25/20/15% margin update live below the cost field
11. [ ] Enter a price value — click `[Calculate Margin]` — margin percentage shown
12. [ ] Click `[Confirm]` — panel closes, **Cost and Price both turn green** (both were changed); Margin also green
13. [ ] Click `[Update Weight]` on item A — weight panel expands
14. [ ] Three radio options shown: `Per-Item`, `Same Weight`, `Bulk` — Per-Item selected by default
15. [ ] Price per unit hint shows the price just confirmed (not the original catalog price)
16. [ ] 2 inputs shown (one per qty)
17. [ ] Enter a weight in each input (e.g. `2.5` and `3.0`)
18. [ ] Click `[Confirm Weight]` — panel closes, `Weight: 2.5, 3.0 lb` shown in green

---

### 3. Item B — weight item, bulk mode, no cost/price update

19. [ ] Click `[Update Weight]` on item B — weight panel expands
20. [ ] Select `Bulk` radio — panel switches to a single `Total lbs` input
21. [ ] Enter a total weight (e.g. `8.0`)
22. [ ] Click `[Confirm Weight]` — panel closes, `Weight: 8 lb` shown in green

---

### 4. Item C — weight item, same-weight mode, quantity reduction

23. [ ] Click `[Update Weight]` on item C — weight panel expands
24. [ ] Select `Same Weight` radio — panel shows two inputs: `Weight per item (lb)` and `Quantity found`
25. [ ] `Quantity found` is pre-filled with `3` (the original qty)
26. [ ] Enter a weight per item (e.g. `40`)
27. [ ] Reduce `Quantity found` to `2` (driver only has 2 boxes)
28. [ ] Click `[Confirm Weight]` — panel closes, `Weight: 40 lb × 2` shown in green (collapsed display)

---

### 5. localStorage persistence

29. [ ] Refresh the page — all confirmed weights, cost/price entries, and resolution states are restored
30. [ ] Item C still shows `Weight: 40 lb × 2` in green
31. [ ] Weight panel mode (Per-Item / Same Weight / Bulk) is restored correctly on re-open

---

### 6. Item D — unit item, Found, price-only update

32. [ ] Click `[Update Cost & Price]` on item D — panel expands
33. [ ] Leave cost field unchanged, enter a new price only
34. [ ] Click `[Confirm]` — panel closes, **Price turns green, Cost does not** (only price changed)
35. [ ] Click `[Found It]` — `✓ found` shown with a `[Reset]` button

---

### 7. Item E — unit item, Partial, cost-only update

36. [ ] Click `[Update Cost & Price]` on item E — panel expands
37. [ ] Enter a new cost only, leave price field unchanged
38. [ ] Click `[Confirm]` — panel closes, **Cost turns green, Price does not** (only cost changed)
39. [ ] Click `[Partial]` — an inline quantity input appears (no browser prompt)
40. [ ] Enter a quantity less than 4 (e.g. `2`) and click `[Confirm]`
41. [ ] `✓ partial` shown with `[Reset]` button; Qty shows `2 (of 4)` in green

---

### 8. Item F — unit item, Removed

42. [ ] Click `[Removed]` on item F — `✓ remove` shown with a `[Reset]` button
43. [ ] Item F remains visible in the list (not hidden)

---

### 9. Reset behaviour

44. [ ] Click `[Reset]` on item D — `[Found It]` `[Partial]` `[Removed]` buttons reappear, item is unresolved
45. [ ] Re-mark item D as `[Found It]`

---

### 10. Order summary and Complete

46. [ ] Order summary reflects:
    - Item A: `totalWeight × pricePerLb` (2.5 + 3.0 = 5.5 lb × confirmed price)
    - Item B: `8.0 × price` (bulk weight × price)
    - Item C: `40 × 2 × price` (same weight × reduced qty × price)
    - Item D: new price × qty 1
    - Item E: original price × 2 (partial qty)
    - Item F: excluded (removed)
47. [ ] Complete button is now **enabled**
48. [ ] Click `[Complete Order]` — progress indicator `⏳ Updating… please wait` shown
49. [ ] Success banner appears: `✅ All 6 items updated successfully.`
50. [ ] `[Print Invoice]` button appears

---

### 11. Backend verification

51. [ ] In Shopify Admin → Orders — a new order exists, tagged `sourced`
52. [ ] Item A: price = `5.5 × pricePerLb`; `Weight (lb)` shows `2.5, 3.0`; `Price Breakdown` shows calculation; linked to original variant
53. [ ] Item B: price = `8.0 × price`; `Weight (lb)` shows `8`
54. [ ] Item C: price = `80 × price` (40 × 2); `Weight (lb)` shows `40, 40`; `Price Breakdown` shows calculation; qty on order = 1
55. [ ] Item D: price updated to new price entered in step 33
56. [ ] Item E: qty = `2` (partial); inventory item cost updated to value entered in step 37
57. [ ] Item F: removed from the order

---

### 12. Print Invoice

58. [ ] Click `[Print Invoice]` — `/invoice/{orderId}` opens in a new tab
59. [ ] Invoice renders at full 8.5×11 width with correct order details and line items
60. [ ] Weight items show `Weight (lb)` and `Price Breakdown` properties

---

## Cleanup

- Delete or archive the test order in Shopify Admin after verification
- Optionally reset costs on test products to their original values
