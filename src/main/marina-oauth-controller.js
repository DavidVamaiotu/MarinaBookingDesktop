"use strict";

const { EventEmitter } = require("node:events");
const { webcrypto } = require("node:crypto");
const OAuth = require("../shared/marina-oauth");

const METADATA_PATH = "/.well-known/oauth-authorization-server";
const TERMINAL_REFRESH_ERRORS = new Set(["invalid_grant", "invalid_token", "invalid_client", "unauthorized_client"]);

class MarinaOAuthController extends EventEmitter {
  constructor({ config, tokenStore, openExternal, fetchImpl = globalThis.fetch, cryptoImpl = webcrypto, now = Date.now } = {}) {
    super();
    this.config = config;
    this.tokenStore = tokenStore;
    this.openExternal = openExternal;
    this.fetchImpl = fetchImpl;
    this.cryptoImpl = cryptoImpl;
    this.now = now;
    this.metadata = null;
    this.pending = null;
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    this.effectiveScopes = [...config.scopes];
    this.refreshPromise = null;
  }

  endpoint(value, label) {
    let endpoint;
    try { endpoint = new URL(String(value || ""), `${this.config.apiBaseUrl}/`); }
    catch { throw Object.assign(new Error(`Endpoint-ul OAuth ${label} este invalid.`), { code: "marina_oauth_metadata_invalid" }); }
    const base = new URL(this.config.apiBaseUrl);
    if (endpoint.protocol !== "https:" || endpoint.origin !== base.origin) {
      throw Object.assign(new Error(`Endpoint-ul OAuth ${label} nu aparține serverului Marina configurat.`), { code: "marina_oauth_metadata_invalid" });
    }
    return endpoint.toString();
  }

  async discover({ force = false } = {}) {
    if (this.metadata && !force) return this.metadata;
    const response = await this.fetchImpl(`${this.config.apiBaseUrl}${METADATA_PATH}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error"
    });
    if (!response.ok) throw Object.assign(new Error(`Descoperirea OAuth Marina a eșuat (HTTP ${response.status}).`), { code: "marina_oauth_discovery_failed", status: response.status, temporary: response.status >= 500 });
    const payload = await response.json();
    this.metadata = Object.freeze({
      issuer: this.endpoint(payload.issuer || this.config.apiBaseUrl, "issuer"),
      authorizationEndpoint: this.endpoint(payload.authorization_endpoint || "/oauth/authorize", "authorization"),
      tokenEndpoint: this.endpoint(payload.token_endpoint || "/oauth/token", "token"),
      revocationEndpoint: this.endpoint(payload.revocation_endpoint || "/oauth/revoke", "revocare")
    });
    return this.metadata;
  }

  async connect() {
    if (!this.config.configured) throw Object.assign(new Error("Integrarea Marina necesită activare și un client OAuth public configurat."), { code: "marina_oauth_config_incomplete", permanent: true });
    const metadata = await this.discover();
    const { codeVerifier, codeChallenge } = await OAuth.createPkcePair({ cryptoImpl: this.cryptoImpl });
    const state = OAuth.createState(this.cryptoImpl);
    this.pending = { codeVerifier, state };
    const authorizationUrl = OAuth.buildAuthorizationUrl({
      authorizationEndpoint: metadata.authorizationEndpoint,
      clientId: this.config.clientId,
      redirectUri: this.config.redirectUris.desktop,
      scopes: this.config.scopes,
      state,
      codeChallenge
    });
    await this.openExternal(authorizationUrl);
    this.emit("changed", this.status());
    return { opened: true };
  }

  async tokenRequest(values) {
    const metadata = await this.discover();
    const response = await this.fetchImpl(metadata.tokenEndpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: OAuth.formBody(values),
      redirect: "error"
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok || !payload.access_token) {
      throw Object.assign(new Error(payload.error_description || "Schimbul tokenului OAuth Marina a eșuat."), { code: payload.error || "marina_oauth_token_failed", status: response.status, auth: true });
    }
    return payload;
  }

  async acceptCallback(value) {
    if (!this.pending) throw Object.assign(new Error("Nu există o autentificare Marina în curs."), { code: "marina_oauth_not_pending", permanent: true });
    const callback = OAuth.parseCallbackUrl(value, { protocol: "ro.marinapark.booking.desktop:", pathname: "/callback" });
    OAuth.validateState(this.pending.state, callback.state);
    const codeVerifier = this.pending.codeVerifier;
    this.pending = null;
    try {
      const payload = await this.tokenRequest({
        grant_type: "authorization_code",
        client_id: this.config.clientId,
        code: callback.code,
        redirect_uri: this.config.redirectUris.desktop,
        code_verifier: codeVerifier
      });
      await this.applyToken(payload);
      this.emit("changed", this.status());
      return this.status();
    } catch (error) {
      this.clearMemory();
      this.emit("changed", this.status());
      throw error;
    }
  }

  async applyToken(payload) {
    this.accessToken = String(payload.access_token);
    this.accessTokenExpiresAt = this.now() + Math.max(0, Number(payload.expires_in) || 0) * 1000;
    if (payload.scope) this.effectiveScopes = String(payload.scope).split(/\s+/).filter(Boolean);
    if (payload.refresh_token) await this.tokenStore.setRefreshToken(String(payload.refresh_token));
  }

  clearMemory() {
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    this.pending = null;
  }

  async getAccessToken() {
    if (this.accessToken && this.accessTokenExpiresAt > this.now() + 60_000) return this.accessToken;
    await this.refresh();
    if (!this.accessToken) throw Object.assign(new Error("Conectarea Marina este necesară."), { code: "marina_reconnect_required", auth: true, permanent: true });
    return this.accessToken;
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const refreshToken = await this.tokenStore.getRefreshToken();
      if (!refreshToken) throw Object.assign(new Error("Conectarea Marina este necesară."), { code: "marina_reconnect_required", auth: true, permanent: true });
      try {
        const payload = await this.tokenRequest({ grant_type: "refresh_token", client_id: this.config.clientId, refresh_token: refreshToken });
        await this.applyToken(payload);
        this.emit("changed", this.status());
        return this.accessToken;
      } catch (error) {
        this.clearMemory();
        // Network/discovery/server failures must not turn a temporary outage into
        // another interactive login. Clear only when OAuth definitively rejects
        // the saved grant or client.
        if (TERMINAL_REFRESH_ERRORS.has(error.code) || error.status === 401) await this.tokenStore.clearRefreshToken();
        this.emit("changed", this.status());
        throw error;
      }
    })();
    try { return await this.refreshPromise; }
    finally { this.refreshPromise = null; }
  }

  async disconnect() {
    const refreshToken = await this.tokenStore.getRefreshToken();
    try {
      if (refreshToken) {
        const metadata = await this.discover();
        await this.fetchImpl(metadata.revocationEndpoint, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: OAuth.formBody({ token: refreshToken, token_type_hint: "refresh_token", client_id: this.config.clientId }),
          redirect: "error"
        });
      }
    } finally {
      this.clearMemory();
      await this.tokenStore.clearRefreshToken();
      this.emit("changed", this.status());
    }
  }

  async isConnected() { return this.config.configured && Boolean(this.accessToken || await this.tokenStore.hasRefreshToken()); }

  status() {
    return {
      configured: this.config.configured,
      connecting: Boolean(this.pending),
      connected: this.config.configured && Boolean(this.accessToken || this.tokenStore.hasRefreshTokenSync?.()),
      effectiveScopes: [...this.effectiveScopes]
    };
  }
}

module.exports = { METADATA_PATH, TERMINAL_REFRESH_ERRORS, MarinaOAuthController };
