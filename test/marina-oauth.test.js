"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const MarinaOAuth = require("../src/shared/marina-oauth");

test("Marina OAuth creates an S256 PKCE pair and authorization URL", async () => {
  const verifier = "v".repeat(43);
  const pair = await MarinaOAuth.createPkcePair({ cryptoImpl: webcrypto, verifier });
  assert.equal(pair.codeVerifier, verifier);
  assert.match(pair.codeChallenge, /^[A-Za-z0-9_-]+$/);
  const state = MarinaOAuth.createState(webcrypto);
  const authorizationUrl = MarinaOAuth.buildAuthorizationUrl({
    authorizationEndpoint: "https://booking.husi.ro/oauth/authorize",
    clientId: "desktop-client",
    redirectUri: MarinaOAuth.DESKTOP_REDIRECT_URI || "ro.marinapark.booking.desktop://oauth/callback",
    scopes: ["resources:read", "bookings:read"],
    state,
    codeChallenge: pair.codeChallenge
  });
  const parsed = new URL(authorizationUrl);
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(parsed.searchParams.get("client_id"), "desktop-client");
  assert.equal(parsed.searchParams.get("state"), state);
});

test("Marina OAuth validates callback state and rejects OAuth errors", () => {
  const callback = MarinaOAuth.parseCallbackUrl("ro.marinapark.booking.desktop://oauth/callback?code=abc&state=state-1", {
    protocol: "ro.marinapark.booking.desktop:"
  });
  assert.deepEqual(callback, { code: "abc", state: "state-1" });
  assert.equal(MarinaOAuth.validateState("state-1", callback.state), true);
  assert.throws(() => MarinaOAuth.validateState("expected", "received"), { code: "marina_state_mismatch" });
  assert.throws(() => MarinaOAuth.parseCallbackUrl("ro.marinapark.booking.desktop://oauth/callback?error=access_denied&error_description=Anulat", {
    protocol: "ro.marinapark.booking.desktop:"
  }), { code: "marina_oauth_access_denied" });
});
