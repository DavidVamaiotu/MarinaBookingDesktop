# Marina Booking API integration contract

The typed endpoint contract supplied with this integration is authoritative. The server does not
publish `/docs`, `/openapi.json`, or `/v1/openapi.json`; the application must not probe those paths
or block Marina on OpenAPI/Swagger discovery.

Authentication always runs before protected API access:

1. Discover OAuth metadata at `/.well-known/oauth-authorization-server`.
2. Open Authorization Code with PKCE S256 in the system browser.
3. Exchange the callback code at the discovered `/oauth/token` endpoint.
4. Send only the returned access token as `Authorization: Bearer ACCESS_TOKEN`.

`MARINA_OAUTH_CLIENT_ID` is a public OAuth client identifier. It belongs in authorization and token
request parameters, never in the `Authorization` header. Access tokens stay in memory; refresh
tokens are stored with the platform secure-storage service and replaced after successful rotation.

The provider uses the supplied `/v1/resources`, calendar, availability, booking, cancellation,
status, read-marker, and note endpoints. Cursor pagination is capped at 200 records per request.
Booking dates are nested in `periods`; top-level `start_date` and `end_date` are invalid. Date-only
`end_date` values are inclusive and are not converted through the workstation timezone. Timed
periods use RFC3339 `start_at`/`end_at` values and retain their offsets. Note mutations use a
non-blank `body` field.

The deployed API has no resource PATCH or DELETE route. Resource editing/deletion must not be
invented client-side and requires a backend capability. Booking removal is status-based (`trash`
or `cancelled`); there is no hard-delete booking route.

An unauthenticated 401 is expected and does not indicate an incompatible API. The application does
not perform protected contract probes before OAuth completes. After authentication,
`GET /v1/resources` returning an empty `data` array is a valid connected state.

Rooms, Camping, and Marina retain separate stores and IDs. Normal calendar mutations are sent only
to the provider that was active when the operation began; there is no mirroring, dual-write,
automatic fallback, or customer-data diagnostic logging.

The explicit **Importă Camere** operation in the Marina Calendar tab is the sole migration
exception. It requires all four scopes (`resources:read resources:write bookings:read
bookings:write`), reads Rooms resources and bookings from WordPress only, and reads prices from the
allowlisted public page
`https://www.marinapark.ro/preturi-cazare-camping/`. It never calls the WordPress price calculator
and writes only to Marina. The public page is parsed for Camera dubla, Camera Cvadrupla, Camera
dubla in bungalow, Camera dubla in bungalow superior, and Glamping; each published date is
normalized to integer bani and verified against the generated inclusive Marina seasons before the
first pricing PUT.

A durable source-ID journal, pricing hashes, versions, verification results, and deterministic
idempotency keys make the import resumable without duplicating completed resources, pricing, or
bookings. The journal contains IDs and progress metadata, not customer data. After migration,
Marina quotes, availability, booking writes, and pricing screens use Marina only; there is no
WordPress pricing fallback. The current public page publishes the 2026 season
(2026-04-17 through 2026-09-30); dates not published by the page are not invented.

Marina pricing uses `POST /v1/quotes` and quote-bound booking writes. The application displays
integer-minor totals, a 30% deposit, balance, nights, and the nightly breakdown without copying
`price_note` into booking notes. The Avans popup reads the server snapshot through
`GET /v1/bookings/{id}` and reads the booking's authoritative `price` object. A manually selected
client deposit is stored through the existing idempotent, version-guarded `PATCH /v1/bookings/{id}`
operation in the namespaced `custom_fields.parkline_manual_deposit_minor` value. It also replaces
only the canonical pricing line inside `internal_note` (`Cost total`, `Depozit`, `Rest`) and
preserves all other note text. The popup overlays that per-booking value on the quote snapshot and
recalculates the displayed balance without mutating Marina's server-authoritative quote pricing.
Payment-email operations remain intentionally unavailable until their Marina contract is added.
Resource administration remains hidden without `resources:write`.
