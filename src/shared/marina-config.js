(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MarinaConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_API_BASE_URL = "https://booking.husi.ro";
  const DEFAULT_SCOPES = ["resources:read", "resources:write", "bookings:read", "bookings:write"];
  const DESKTOP_REDIRECT_URI = "ro.marinapark.booking.desktop://oauth/callback";
  const MOBILE_REDIRECT_URI = "ro.marinapark.booking.mobile://oauth/callback";
  const SUPPORTED_PROVIDERS = ["existing", "marina"];
  const PUBLIC_CONFIG_KEYS = ["MARINA_INTEGRATION_ENABLED", "MARINA_API_BASE_URL", "MARINA_OAUTH_CLIENT_ID", "MARINA_OAUTH_SCOPES"];

  function booleanValue(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
  }

  function normalizeScopes(value = DEFAULT_SCOPES) {
    const values = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/);
    return [...new Set(values.map((scope) => String(scope).trim()).filter(Boolean))];
  }

  function normalizeBaseUrl(value = DEFAULT_API_BASE_URL) {
    let url;
    try {
      url = new URL(String(value || DEFAULT_API_BASE_URL).trim());
    } catch {
      throw Object.assign(new Error("URL-ul API Marina este invalid."), { code: "marina_invalid_url" });
    }
    if (url.protocol !== "https:") {
      throw Object.assign(new Error("URL-ul API Marina trebuie să folosească HTTPS."), { code: "marina_https_required" });
    }
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  }

  function environmentValue(name, environment = null) {
    if (environment && Object.prototype.hasOwnProperty.call(environment, name)) return environment[name];
    if (typeof globalThis !== "undefined" && globalThis.__MARINA_CONFIG__ && Object.prototype.hasOwnProperty.call(globalThis.__MARINA_CONFIG__, name)) {
      return globalThis.__MARINA_CONFIG__[name];
    }
    return undefined;
  }

  function configValue(name, environment = null, persisted = null) {
    const runtimeValue = environmentValue(name, environment);
    if (runtimeValue !== undefined && runtimeValue !== null && runtimeValue !== "") return runtimeValue;
    if (persisted && Object.prototype.hasOwnProperty.call(persisted, name)) return persisted[name];
    return undefined;
  }

  function hasExplicitConfig(environment = null) {
    return PUBLIC_CONFIG_KEYS.some((name) => environment && Object.prototype.hasOwnProperty.call(environment, name) && environment[name] !== "");
  }

  function createConfig(environment = null, persisted = null) {
    const scopes = normalizeScopes(configValue("MARINA_OAUTH_SCOPES", environment, persisted) || DEFAULT_SCOPES);
    let apiBaseUrl = DEFAULT_API_BASE_URL;
    let configurationError = null;
    try {
      apiBaseUrl = normalizeBaseUrl(configValue("MARINA_API_BASE_URL", environment, persisted) || DEFAULT_API_BASE_URL);
    } catch (error) {
      configurationError = error.code || "marina_invalid_url";
    }
    const clientId = String(configValue("MARINA_OAUTH_CLIENT_ID", environment, persisted) || "").trim();
    const enabled = booleanValue(configValue("MARINA_INTEGRATION_ENABLED", environment, persisted), false);
    return Object.freeze({
      enabled,
      configured: enabled && Boolean(clientId) && !configurationError,
      configurationError,
      apiBaseUrl,
      clientId,
      scopes,
      scopeString: scopes.join(" "),
      redirectUris: Object.freeze({ desktop: DESKTOP_REDIRECT_URI, mobile: MOBILE_REDIRECT_URI }),
      provider: "marina"
    });
  }

  function publicEnvironment(config) {
    return Object.freeze({
      MARINA_INTEGRATION_ENABLED: config.enabled ? "true" : "false",
      MARINA_API_BASE_URL: config.apiBaseUrl,
      MARINA_OAUTH_CLIENT_ID: config.clientId,
      MARINA_OAUTH_SCOPES: config.scopeString
    });
  }

  function providerIdentity(provider, id) {
    const normalizedProvider = SUPPORTED_PROVIDERS.includes(String(provider)) ? String(provider) : "existing";
    const normalizedId = String(id ?? "").trim();
    if (!normalizedId) throw new TypeError("Identitatea providerului este obligatorie.");
    return Object.freeze({ provider: normalizedProvider, id: normalizedId });
  }

  function providerKey(identityOrProvider, id) {
    const identity = typeof identityOrProvider === "object"
      ? providerIdentity(identityOrProvider.provider, identityOrProvider.id)
      : providerIdentity(identityOrProvider, id);
    return `${identity.provider}:${identity.id}`;
  }

  function scopeSet(scopes) {
    return new Set(normalizeScopes(scopes));
  }

  function capabilities(scopes) {
    const effective = scopeSet(scopes);
    return Object.freeze({
      resourcesRead: effective.has("resources:read"),
      resourcesWrite: effective.has("resources:write"),
      bookingsRead: effective.has("bookings:read"),
      bookingsWrite: effective.has("bookings:write"),
      canLoadCalendar: effective.has("resources:read") && effective.has("bookings:read"),
      canMutateBookings: effective.has("bookings:write"),
      canManageResources: effective.has("resources:write")
    });
  }

  return {
    DEFAULT_API_BASE_URL,
    DEFAULT_SCOPES,
    DESKTOP_REDIRECT_URI,
    MOBILE_REDIRECT_URI,
    SUPPORTED_PROVIDERS,
    PUBLIC_CONFIG_KEYS,
    booleanValue,
    normalizeScopes,
    normalizeBaseUrl,
    createConfig,
    hasExplicitConfig,
    publicEnvironment,
    providerIdentity,
    providerKey,
    capabilities
  };
});
