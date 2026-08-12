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

The explicit **Importă Camere** operation is the sole migration exception. It requires all four
scopes (`resources:read resources:write bookings:read bookings:write`), reads the Rooms WordPress
API only through `GET /resources` and paginated `GET /bookings`, and writes only to Marina. A
durable source-ID journal and deterministic idempotency keys make the import resumable without
duplicating completed resources or bookings. The journal contains only IDs and progress metadata,
not customer data. When a historical booking references a resource that WordPress no longer lists,
the importer creates one archived-source resource from the booking's read-only resource label so
the reservation is preserved instead of discarded.

Pricing, deposits, payment status, and payment email remain unavailable in Marina because the
supplied Marina contract does not define those operations. Resource administration remains hidden
without `resources:write`.
