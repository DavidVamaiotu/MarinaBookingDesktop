"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const MarinaConfig = require("../src/shared/marina-config");

test("Marina integration is disabled by default and exposes safe defaults", () => {
  const config = MarinaConfig.createConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.configured, false);
  assert.equal(config.apiBaseUrl, "https://booking.husi.ro");
  assert.deepEqual(config.scopes, ["resources:read", "resources:write", "bookings:read", "bookings:write"]);
  assert.equal(config.redirectUris.desktop, MarinaConfig.DESKTOP_REDIRECT_URI);
});

test("Marina configuration normalizes flags, scopes, and provider-qualified identities", () => {
  const config = MarinaConfig.createConfig({
    MARINA_INTEGRATION_ENABLED: "true",
    MARINA_API_BASE_URL: "https://booking.husi.ro/",
    MARINA_OAUTH_CLIENT_ID: " public-client ",
    MARINA_OAUTH_SCOPES: "bookings:write resources:read bookings:write"
  });
  assert.equal(config.configured, true);
  assert.equal(config.clientId, "public-client");
  assert.deepEqual(config.scopes, ["bookings:write", "resources:read"]);
  assert.equal(MarinaConfig.providerKey("existing", 42), "existing:42");
  assert.equal(MarinaConfig.providerKey("marina", 42), "marina:42");
  assert.notEqual(MarinaConfig.providerKey("existing", 42), MarinaConfig.providerKey("marina", 42));
  assert.deepEqual(MarinaConfig.capabilities(config.scopes), {
    resourcesRead: true,
    resourcesWrite: false,
    bookingsRead: false,
    bookingsWrite: true,
    canLoadCalendar: false,
    canMutateBookings: true,
    canManageResources: false
  });
});

test("Marina URLs reject non-HTTPS endpoints", () => {
  assert.throws(() => MarinaConfig.normalizeBaseUrl("http://booking.husi.ro"), { code: "marina_https_required" });
  const config = MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "client", MARINA_API_BASE_URL: "http://booking.husi.ro" });
  assert.equal(config.configured, false);
  assert.equal(config.configurationError, "marina_https_required");
});

test("Marina public configuration persists across normal launches and runtime values take precedence", () => {
  const persisted = {
    MARINA_INTEGRATION_ENABLED: "true",
    MARINA_API_BASE_URL: "https://booking.husi.ro/",
    MARINA_OAUTH_CLIENT_ID: "saved-public-client",
    MARINA_OAUTH_SCOPES: "resources:read bookings:read"
  };
  const restored = MarinaConfig.createConfig({}, persisted);
  assert.equal(restored.configured, true);
  assert.equal(restored.clientId, "saved-public-client");
  assert.deepEqual(restored.scopes, ["resources:read", "bookings:read"]);
  assert.deepEqual(MarinaConfig.publicEnvironment(restored), {
    MARINA_INTEGRATION_ENABLED: "true",
    MARINA_API_BASE_URL: "https://booking.husi.ro",
    MARINA_OAUTH_CLIENT_ID: "saved-public-client",
    MARINA_OAUTH_SCOPES: "resources:read bookings:read"
  });
  assert.equal(MarinaConfig.createConfig({ MARINA_OAUTH_CLIENT_ID: "runtime-client" }, persisted).clientId, "runtime-client");
  assert.equal(MarinaConfig.hasExplicitConfig({}), false);
  assert.equal(MarinaConfig.hasExplicitConfig({ MARINA_INTEGRATION_ENABLED: "true" }), true);
});
