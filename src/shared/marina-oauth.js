(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MarinaOAuth = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  class MarinaOAuthError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = "MarinaOAuthError";
      Object.assign(this, options);
    }
  }

  function cryptoSource(cryptoImpl) {
    const source = cryptoImpl || (typeof globalThis !== "undefined" ? globalThis.crypto : null);
    if (!source?.getRandomValues || !source?.subtle) throw new MarinaOAuthError("Criptografia sigură nu este disponibilă.", { code: "marina_crypto_unavailable" });
    return source;
  }

  function base64Url(bytes) {
    const values = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = "";
    for (const value of values) binary += String.fromCharCode(value);
    const encoded = typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(binary, "binary").toString("base64");
    return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function randomToken(cryptoImpl, byteLength = 32) {
    const cryptoApi = cryptoSource(cryptoImpl);
    const bytes = new Uint8Array(byteLength);
    cryptoApi.getRandomValues(bytes);
    return base64Url(bytes);
  }

  async function pkceChallenge(verifier, cryptoImpl) {
    const cryptoApi = cryptoSource(cryptoImpl);
    const digest = await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(String(verifier)));
    return base64Url(new Uint8Array(digest));
  }

  async function createPkcePair({ cryptoImpl, verifier = null } = {}) {
    const codeVerifier = verifier || randomToken(cryptoImpl, 48);
    if (codeVerifier.length < 43 || codeVerifier.length > 128) throw new MarinaOAuthError("Verifierul PKCE are o lungime invalidă.", { code: "marina_invalid_pkce_verifier" });
    return { codeVerifier, codeChallenge: await pkceChallenge(codeVerifier, cryptoImpl) };
  }

  function createState(cryptoImpl) {
    return randomToken(cryptoImpl, 32);
  }

  function buildAuthorizationUrl({ authorizationEndpoint, clientId, redirectUri, scopes, state, codeChallenge }) {
    if (!authorizationEndpoint || !clientId || !redirectUri || !state || !codeChallenge) {
      throw new MarinaOAuthError("Parametrii OAuth Marina sunt incompleți.", { code: "marina_oauth_config_incomplete" });
    }
    const url = new URL(authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: String(clientId),
      redirect_uri: String(redirectUri),
      scope: Array.isArray(scopes) ? scopes.join(" ") : String(scopes || ""),
      state: String(state),
      code_challenge: String(codeChallenge),
      code_challenge_method: "S256"
    }).toString();
    return url.toString();
  }

  function parseCallbackUrl(value, { protocol, pathname = "/callback" } = {}) {
    let url;
    try { url = new URL(String(value || "")); }
    catch { throw new MarinaOAuthError("Callback-ul OAuth Marina este invalid.", { code: "marina_invalid_callback" }); }
    if (protocol && url.protocol !== protocol) throw new MarinaOAuthError("Schema callback-ului OAuth Marina este invalidă.", { code: "marina_invalid_callback" });
    if (pathname && url.pathname !== pathname) throw new MarinaOAuthError("Calea callback-ului OAuth Marina este invalidă.", { code: "marina_invalid_callback" });
    const error = url.searchParams.get("error");
    if (error) throw new MarinaOAuthError(url.searchParams.get("error_description") || "Autentificarea Marina a fost anulată.", { code: `marina_oauth_${error}`, oauthError: error });
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) throw new MarinaOAuthError("Callback-ul OAuth Marina nu conține codul și starea necesare.", { code: "marina_callback_incomplete" });
    return { code, state };
  }

  function validateState(expected, received) {
    if (!expected || !received || String(expected) !== String(received)) {
      throw new MarinaOAuthError("Starea OAuth Marina nu corespunde cererii inițiale.", { code: "marina_state_mismatch" });
    }
    return true;
  }

  function formBody(values) {
    return new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "")).toString();
  }

  return { MarinaOAuthError, base64Url, randomToken, pkceChallenge, createPkcePair, createState, buildAuthorizationUrl, parseCallbackUrl, validateState, formBody };
});
