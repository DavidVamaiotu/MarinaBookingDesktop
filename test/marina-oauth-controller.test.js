"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const MarinaConfig = require("../src/shared/marina-config");
const { MarinaOAuthController } = require("../src/main/marina-oauth-controller");

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test("desktop OAuth discovers metadata, uses PKCE, and never sends the public client id as bearer", async () => {
  const calls = [];
  let stored = "";
  let opened = "";
  const config = MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" });
  const controller = new MarinaOAuthController({
    config,
    tokenStore: {
      setRefreshToken: async (value) => { stored = value; },
      getRefreshToken: async () => stored,
      clearRefreshToken: async () => { stored = ""; },
      hasRefreshToken: async () => Boolean(stored),
      hasRefreshTokenSync: () => Boolean(stored)
    },
    openExternal: async (url) => { opened = url; },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/.well-known/oauth-authorization-server")) return response(200, { issuer: "https://booking.husi.ro", authorization_endpoint: "https://booking.husi.ro/oauth/authorize", token_endpoint: "https://booking.husi.ro/oauth/token", revocation_endpoint: "https://booking.husi.ro/oauth/revoke" });
      return response(200, { access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600, scope: "resources:read bookings:read" });
    }
  });

  await controller.connect();
  const authorization = new URL(opened);
  assert.equal(calls[0].url, "https://booking.husi.ro/.well-known/oauth-authorization-server");
  assert.equal(authorization.searchParams.get("client_id"), "public-client");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  const state = authorization.searchParams.get("state");
  await controller.acceptCallback(`ro.marinapark.booking.desktop://oauth/callback?code=code-1&state=${state}`);
  const tokenCall = calls[1];
  assert.equal(tokenCall.options.headers.Authorization, undefined);
  assert.match(tokenCall.options.body, /client_id=public-client/);
  assert.equal(stored, "refresh-token");
  assert.equal(await controller.getAccessToken(), "access-token");
});

test("temporary refresh failures preserve the saved login while invalid grants clear it", async () => {
  const config = MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" });
  let stored = "refresh-token";
  let clearCalls = 0;
  let tokenResponse = response(503, { error: "temporarily_unavailable" });
  const controller = new MarinaOAuthController({
    config,
    tokenStore: {
      setRefreshToken: async (value) => { stored = value; },
      getRefreshToken: async () => stored,
      clearRefreshToken: async () => { clearCalls += 1; stored = ""; },
      hasRefreshToken: async () => Boolean(stored),
      hasRefreshTokenSync: () => Boolean(stored)
    },
    openExternal: async () => {},
    fetchImpl: async (url) => url.endsWith("/.well-known/oauth-authorization-server")
      ? response(200, { issuer: "https://booking.husi.ro", token_endpoint: "https://booking.husi.ro/oauth/token" })
      : tokenResponse
  });

  await assert.rejects(controller.refresh(), { code: "temporarily_unavailable" });
  assert.equal(stored, "refresh-token");
  assert.equal(clearCalls, 0);
  assert.equal(controller.status().connected, true);

  tokenResponse = response(400, { error: "invalid_grant" });
  await assert.rejects(controller.refresh(), { code: "invalid_grant" });
  assert.equal(stored, "");
  assert.equal(clearCalls, 1);
  assert.equal(controller.status().connected, false);
});
