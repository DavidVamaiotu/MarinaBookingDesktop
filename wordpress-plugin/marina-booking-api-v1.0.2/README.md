# Marina Booking API v1.0.6

## New in v1.0.6: safe booking resource moves

Editing a booking can now move it to another Booking Calendar resource without losing guest fields or check-in/check-out boundaries. The bridge saves the edited booking against its current resource first, then delegates the move to Booking Calendar's native resource-change helper so field suffixes and the destination resource stay aligned.

The edit request also carries the note currently shown in the app. Resource moves preserve that note exactly and do not recalculate it for the destination resource.

## New in v1.0.5: queued deposit collection

Adds authenticated, idempotent endpoints for reading a booking payment, changing the exact deposit/payment amount together with its canonical pricing note, and sending Booking Calendar's native Payment Request email.

A separate, update-safe WordPress bridge for **Booking Calendar** and **Booking Calendar Pro**. It does not edit either vendor plugin.

## New in v1.0.4: fast and full native price quotes

The existing authenticated, read-only endpoint remains:

```text
POST /wp-json/marina-booking/v1/prices/calculate
```

It now accepts an optional `mode` field:

- `"fast"` — intended for reception workflow and live date/form selection. It calculates the native Booking Calendar total once, keeps coupon amount, deposit and balance, and skips website-preview-only data. It calculates the original price as well only when the site is explicitly configured to base the deposit on original cost.
- `"full"` — default for backward compatibility. It returns the v1.0.3-style detailed quote: original and additional cost, advanced-cost hints, coupon description, all formatted values, deposit and balance.

Both modes use Booking Calendar's native Business Medium+ price engine. No price arithmetic is duplicated in Electron.

### Private server-side quote cache

Price quotes are cached with WordPress transients, inside the authenticated API only:

| Mode | Default cache TTL |
|---|---:|
| `fast` | 60 seconds |
| `full` | 30 seconds |

The cache key uses the authenticated API user, site, locale, resource, dates, normalized form data, booking form type and mode. The HTTP response is still `Cache-Control: no-store, private`; the cache is never a public/browser cache.

Responses include diagnostic headers:

```text
X-Marina-Price-Mode: FAST|FULL
X-Marina-Price-Cache: HIT|MISS|BYPASS
```

A site developer can change or disable the cache without modifying the plugin:

```php
add_filter( 'marina_booking_api_price_cache_ttl', function( $ttl, $mode ) {
    return 'fast' === $mode ? 45 : 15; // Return 0 to disable a mode's quote cache.
}, 10, 2 );
```

## Security model

- No public endpoints. Every route requires a WordPress user with `manage_marina_booking_api`.
- On activation, the plugin creates a least-privilege **Marina Booking API** role containing only `read` and the API capability. Administrators retain access.
- HTTPS is required by default.
- Browser requests require a WordPress REST nonce. Remote apps should use a dedicated WordPress **Application Password** over HTTPS.
- Responses are `no-store, private`; no CORS headers are added.
- Rate limits: 60 mutations / 5 minutes and 300 reads or price previews / 5 minutes per user and route.
- The API never exposes permanent deletion or Booking Calendar's force-save-if-unavailable option.

## Upgrade

This ZIP intentionally retains the same root directory as the v1.0.2 package so WordPress can replace it in place.

1. Back up the WordPress database and current plugin ZIP.
2. In WordPress, upload this ZIP through **Plugins → Add New → Upload Plugin**.
3. Confirm replacement of the existing Marina Booking API plugin if WordPress asks.
4. Verify that only one **Marina Booking API** plugin is active.
5. Test one known quotation in both modes against Booking Calendar's normal price preview before using it in Electron.

## Routes

Base path:

```text
/wp-json/marina-booking/v1
```

| Method | Route | Purpose | Idempotency-Key required |
|---|---|---|---|
| GET | `/resources` | List booking resources | No |
| POST | `/availability` | Check dates/times | No |
| POST | `/prices/calculate` | Native price preview for one resource | No |
| GET | `/bookings?start=YYYY-MM-DD&end=YYYY-MM-DD&resource_id=1` | List bookings | No |
| GET | `/bookings?external_id=YOUR-ID` | Exact external-ID lookup | No |
| GET | `/bookings/by-external-id/YOUR-ID` | Exact external-ID lookup | No |
| POST | `/bookings` | Create booking | **Yes** |
| GET | `/bookings/{id}` | Read one booking | No |
| PUT/PATCH | `/bookings/{id}` | Edit dates/form data/note and move resources | **Yes** |
| POST | `/bookings/{id}/status` | Set approved/pending | **Yes** |
| POST | `/bookings/{id}/note` | Replace internal remark | **Yes** |
| POST | `/bookings/{id}/trash` | Trash/restore | **Yes** |
| GET | `/bookings/{id}/payment` | Read saved payment/deposit state | No |
| PATCH | `/bookings/{id}/deposit` | Atomically update payment amount and pricing note | **Yes** |
| POST | `/bookings/{id}/payment-request` | Send native Payment Request email | **Yes** |

`PATCH /bookings/{id}/deposit` accepts `deposit: 0`. It writes `cost = 0` to the native Booking Calendar database row and saves the matching canonical note (`Depozit: 0 RON`, with the full total remaining). Negative deposits are rejected.

For an edit preflight, `/availability` accepts the existing WordPress booking ID as `exclude_booking_id`. The full proposed stay must still be sent in `dates`; Booking Calendar excludes only that booking through its native `skip_booking_id` lookup and continues to detect every other overlap:

```json
{
  "resource_id": 4,
  "dates": ["2026-07-17 15:00:01", "2026-07-18 00:00:00", "2026-07-19 00:00:00", "2026-07-20 00:00:00", "2026-07-21 12:00:02"],
  "exclude_booking_id": 44
}
```

The payment-request body is strict. Dates use ISO `YYYY-MM-DD`; `nights` must match the saved Booking Calendar period; and `reason` is the six-letter `[paymentreason]` code used by the EuPlatesc link:

```json
{
  "reason": "aBcDeF",
  "nights": 2,
  "start_date": "2026-07-20",
  "end_date": "2026-07-22"
}
```

Before sending, the endpoint verifies the period against `wp_bookingdates` and writes Booking Calendar's `selected_short_dates_hint{resource_id}` and `nights_number_hint{resource_id}` form fields used by the EuPlatesc payment page.

## Price calculation examples

### Fast reception quote

```bash
curl --user 'api-user:APPLICATION PASSWORD' \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "fast",
    "resource_id": 4,
    "dates": ["2026-07-20", "2026-07-21", "2026-07-22"],
    "form_data": {
      "adults": {"value": "2", "type": "selectbox-one"},
      "coupon": {"value": "SUMMER2026", "type": "text"}
    },
    "booking_form_type": "standard"
  }' \
  https://example.com/wp-json/marina-booking/v1/prices/calculate
```

Fast response fields include:

```json
{
  "mode": "fast",
  "total": 450,
  "deposit": 100,
  "balance": 350,
  "coupon_discount": 50,
  "formatted": {
    "total": "450 RON",
    "deposit": "100 RON",
    "balance": "350 RON"
  }
}
```

### Full quote

Omit `mode` or send `"mode": "full"`. Full is the default and includes `base_cost`, `original_cost`, `additional_cost`, `advanced_cost_hints`, `coupon_description`, detailed formatted amounts, total, deposit, and balance.

## Idempotent writes

All mutating routes still require an `Idempotency-Key`. Use a new random UUID for each user command; keep the same key for retries of the exact same command. Create requests also require immutable `external_id` and can reconcile safely through Booking Calendar's `sync_gid` field.

## Electron notes

- Debounce price previews (for example 250–400 ms after changing dates/form fields).
- Use `fast` while the receptionist is selecting/changing dates or price-dependent fields.
- Use `full` for the review step and before the final reservation save.
- Do not copy pricing math into Electron.
