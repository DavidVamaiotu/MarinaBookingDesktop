"use strict";

const { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { MarinaStore } = require("./src/main/marina-store");
const MarinaConfig = require("./src/shared/marina-config");
const SagaInvoice = require("./src/shared/saga-invoice");
const SagaWebApi = require("./src/shared/saga-web-api");
const { MarinaOAuthController } = require("./src/main/marina-oauth-controller");
const { MarinaTokenStore } = require("./src/main/marina-token-store");
const { SagaWebTokenStore } = require("./src/main/saga-web-token-store");
const { MarinaV1ApiClient } = require("./src/main/marina-v1-client");
const { MarinaBookingProvider } = require("./src/main/marina-provider-service");
const { parseReservationDeepLink } = require("./src/shared/reservation-deep-link");
const validate = require("./src/main/validation");

app.setName("Marina Booking");
if (process.platform === "linux") app.commandLine.appendSwitch("password-store", "gnome-libsecret");

let window = null;
let updaterConfigured = false;
const contexts = {};
const VALID_SOURCES = new Set(["rooms", "camping"]);
const pendingOAuthUrls = [];
const SAGA_INVOICE_SETTINGS_KEY = "sagaInvoiceSettings:v1";

function assertWritableSource(source) {
  const settings = contextFor(source).service.settings();
  if (!settings.connected) throw Object.assign(new Error("Conectează contul Marina înainte de a modifica rezervări."), { code: "marina_reconnect_required", auth: true, permanent: true });
  if (!settings.capabilities?.canMutateBookings) throw Object.assign(new Error("Contul Marina conectat nu are scope-ul bookings:write."), { code: "marina_scope_required", permanent: true });
}

function assertReadableSource(source) {
  const settings = contextFor(source).service.settings();
  if (!settings.connected) throw Object.assign(new Error("Conectează contul Marina înainte de a accesa rezervările."), { code: "marina_reconnect_required", auth: true, permanent: true });
  if (!settings.capabilities?.bookingsRead) throw Object.assign(new Error("Contul Marina conectat nu are scope-ul bookings:read."), { code: "marina_scope_required", permanent: true });
}

function oauthUrlFromArgs(args = []) { return args.find((value) => String(value).startsWith("ro.marinapark.booking.desktop://")) || null; }

function registerDesktopOAuthProtocol() {
  app.setAsDefaultProtocolClient("ro.marinapark.booking.desktop");
  if (process.platform !== "linux") return;
  try {
    const applicationsDirectory = path.join(app.getPath("home"), ".local", "share", "applications");
    const desktopFile = path.join(applicationsDirectory, "marina-booking-oauth.desktop");
    const projectArgument = app.isPackaged ? "" : ` ${JSON.stringify(__dirname)}`;
    const contents = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Marina Booking OAuth",
      "NoDisplay=true",
      `Exec=${JSON.stringify(process.execPath)}${projectArgument} %u`,
      "Terminal=false",
      "MimeType=x-scheme-handler/ro.marinapark.booking.desktop;",
      "Categories=Office;",
      ""
    ].join("\n");
    mkdirSync(applicationsDirectory, { recursive: true });
    const temporaryFile = `${desktopFile}.${process.pid}.tmp`;
    writeFileSync(temporaryFile, contents, { mode: 0o644 });
    renameSync(temporaryFile, desktopFile);
    try { execFileSync("update-desktop-database", [applicationsDirectory], { stdio: "ignore" }); } catch {}
    execFileSync("xdg-mime", ["default", path.basename(desktopFile), "x-scheme-handler/ro.marinapark.booking.desktop"], { stdio: "ignore" });
  } catch (error) {
    console.error("Marina OAuth protocol registration failed:", error.code || error.message);
  }
}

async function handleOAuthUrl(url) {
  if (!url) return;
  const reservationLink = parseReservationDeepLink(url);
  if (reservationLink) {
    if (window?.webContents) {
      window.webContents.send("reservation:link", reservationLink);
      window.show();
      window.focus();
    } else {
      pendingOAuthUrls.push(url);
    }
    return;
  }
  const oauth = contexts.rooms?.oauth;
  if (!oauth) { pendingOAuthUrls.push(url); return; }
  try {
    await oauth.acceptCallback(url);
    for (const source of VALID_SOURCES) {
      const service = contexts[source]?.service;
      if (service?.visibleRange) await service.refresh(service.visibleRange);
      else service?.emitState();
    }
    window?.show();
    window?.focus();
  } catch (error) {
    console.error("Marina OAuth callback failed:", error.code || error.message);
    for (const source of VALID_SOURCES) contexts[source]?.service.emitState();
  }
}

function configureAutoUpdater() {
  if (updaterConfigured || !app.isPackaged || process.platform !== "win32") return;
  updaterConfigured = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (error) => console.error("Desktop update failed:", error));
  autoUpdater.on("update-downloaded", async ({ version }) => {
    try {
      const options = {
        type: "info",
        title: "Actualizare pregătită",
        message: `Marina Booking ${version} a fost descărcată.`,
        detail: "Repornește aplicația pentru a instala actualizarea.",
        buttons: ["Repornește și instalează", "Mai târziu"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      };
      const { response } = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      if (response === 0) autoUpdater.quitAndInstall(false, true);
    } catch (error) {
      console.error("Desktop update prompt failed:", error);
    }
  });
  setTimeout(() => void autoUpdater.checkForUpdates().catch((error) => {
    console.error("Desktop update check failed:", error);
  }), 4000);
}

function contextFor(source) {
  if (!VALID_SOURCES.has(source) || !contexts[source]) throw new TypeError("Sursa rezervărilor este invalidă.");
  return contexts[source];
}

function sendState(source, state) {
  if (window && !window.isDestroyed()) window.webContents.send("state:changed", { source, state });
}

function bundledMarinaEnvironment() {
  try {
    const value = JSON.parse(readFileSync(path.join(__dirname, "marina-build-config.json"), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function sagaInvoiceStore() {
  const database = contexts.rooms?.database || contexts.camping?.database;
  if (!database) throw new Error("Stocarea setărilor de facturare nu este disponibilă.");
  return database;
}

function sagaWebTokenStore() {
  return new SagaWebTokenStore({ database: sagaInvoiceStore(), safeStorage });
}

function getSagaInvoiceSettings() {
  let settings;
  try {
    const stored = JSON.parse(sagaInvoiceStore().getMeta(SAGA_INVOICE_SETTINGS_KEY) || "null");
    settings = validate.sagaInvoiceSettings(stored || SagaInvoice.defaultSupplierSettings());
  } catch {
    settings = validate.sagaInvoiceSettings(SagaInvoice.defaultSupplierSettings());
  }
  return { ...settings, sagaWebConfigured: sagaWebTokenStore().hasTokenSync() };
}

async function saveSagaInvoiceSettings(input) {
  const settings = validate.sagaInvoiceSettings(input);
  const token = validate.text(input?.sagaWebApiToken, "Cheia API SAGA Web", 20_000);
  if (token) await sagaWebTokenStore().setToken(token);
  sagaInvoiceStore().setMeta(SAGA_INVOICE_SETTINGS_KEY, JSON.stringify(settings));
  return { ...settings, sagaWebConfigured: sagaWebTokenStore().hasTokenSync() };
}

async function importSagaInvoice(input) {
  input = validate.sagaInvoiceImport(input);
  const store = sagaWebTokenStore();
  const token = await store.getToken();
  if (!token) throw Object.assign(new Error("Configurează cheia API SAGA Web în Setări înainte de import."), { code: "saga_web_not_configured", permanent: true });
  try {
    const result = await SagaWebApi.importSagaInvoice({ ...input, token });
    if (result.refreshToken) await store.setToken(result.refreshToken);
    return { success: result.success, message: result.message };
  } catch (error) {
    if (error?.refreshToken) {
      try { await store.setToken(error.refreshToken); }
      catch (storageError) { console.error("SAGA token rotation failed:", storageError?.code || storageError?.message); }
    }
    throw error;
  }
}

function registerIpc() {
  ipcMain.handle("state:bootstrap", (_event, source, input) => {
    const { service } = contextFor(source);
    const range = validate.range(input);
    service.visibleRange = range;
    return service.state(range);
  });
  ipcMain.handle("state:refresh", async (_event, source, input, options = {}) => {
    const { service } = contextFor(source);
    options = validate.object(options, "refresh options");
    return service.refresh(validate.range(input), { force: Boolean(options.force) });
  });
  ipcMain.handle("booking:create", (_event, source, input) => {
    assertWritableSource(source);
    const { service } = contextFor(source);
    const booking = validate.bookingInput(input);
    return service.create(booking);
  });
  ipcMain.handle("booking:get", (_event, source, localId) => {
    assertReadableSource(source);
    return contextFor(source).service.details(validate.id(localId, "localId"));
  });
  ipcMain.handle("booking:by-provider-id", (_event, source, providerId) => {
    assertReadableSource(source);
    return contextFor(source).service.getBookingByProviderId(validate.marinaBookingId(providerId));
  });
  ipcMain.handle("booking:edit", (_event, source, localId, patch) => { assertWritableSource(source); return contextFor(source).service.update(validate.id(localId, "localId"), validate.bookingPatch(patch), "edit"); });
  ipcMain.handle("booking:status", (_event, source, localId, patch) => { assertWritableSource(source); return contextFor(source).service.update(validate.id(localId, "localId"), validate.bookingPatch(patch), "status"); });
  ipcMain.handle("booking:note", (_event, source, localId, patch) => { assertWritableSource(source); return contextFor(source).service.update(validate.id(localId, "localId"), validate.bookingPatch(patch), "note"); });
  ipcMain.handle("booking:trash", (_event, source, localId, patch) => { assertWritableSource(source); return contextFor(source).service.update(validate.id(localId, "localId"), validate.bookingPatch(patch), "trash"); });
  ipcMain.handle("booking:payment", (_event, source, localId) => { assertReadableSource(source); return contextFor(source).service.payment(validate.id(localId, "localId")); });
  ipcMain.handle("booking:deposit", (_event, source, localId, input) => { assertWritableSource(source); return contextFor(source).service.updateDeposit(validate.id(localId, "localId"), validate.deposit(input, { requireNote: false })); });
  ipcMain.handle("booking:payment-request", (_event, source, localId, input) => {
    assertWritableSource(source);
    return contextFor(source).service.requestPayment(validate.id(localId, "localId"), validate.marinaPaymentRequest(input));
  });
  ipcMain.handle("booking:availability", (_event, source, input) => {
    assertReadableSource(source);
    const { service } = contextFor(source);
    input = validate.object(input);
    const resourceId = Number(input.resourceId);
    if (!Number.isInteger(resourceId) || resourceId < 1) throw new TypeError("resourceId trebuie să fie pozitiv.");
    const excludeBookingId = input.excludeBookingId === undefined || input.excludeBookingId === null
      ? undefined
      : validate.id(input.excludeBookingId, "excludeBookingId");
    return service.availability(resourceId, validate.availabilityDates(input.dates), { excludeBookingId });
  });
  ipcMain.handle("booking:quote", (_event, source, input) => { assertWritableSource(source); return contextFor(source).service.quote(validate.quoteInput(input)); });
  ipcMain.handle("booking:quote-clear", (_event, source) => { assertWritableSource(source); return contextFor(source).service.clearQuoteCache(); });
  ipcMain.handle("settings:get", (_event, source) => contextFor(source).service.settings());
  ipcMain.handle("saga-invoice-settings:get", () => getSagaInvoiceSettings());
  ipcMain.handle("saga-invoice-settings:save", (_event, input) => saveSagaInvoiceSettings(input));
  ipcMain.handle("saga-invoice:import", (_event, input) => importSagaInvoice(input));
  ipcMain.handle("settings:clear", (_event, source) => disconnectMarina(source));
  ipcMain.handle("marina:connect", () => contexts.rooms.service.connect());
  ipcMain.handle("marina:disconnect", (_event, source) => disconnectMarina(source));
}

async function disconnectMarina(requestedSource = "rooms") {
  let revocationError = null;
  try { await contexts.rooms.oauth.disconnect(); }
  catch (error) { revocationError = error; }
  const states = new Map();
  for (const source of VALID_SOURCES) states.set(source, contexts[source].service.clearSession());
  const state = states.get(VALID_SOURCES.has(requestedSource) ? requestedSource : "rooms");
  if (!revocationError) return state;
  return {
    ...state,
    settings: { ...state.settings, revocationUnconfirmed: true, revocationErrorCode: revocationError.code || "marina_revocation_failed" }
  };
}

function createMarinaWorkspaceContexts() {
  const database = new MarinaStore(path.join(app.getPath("userData"), "marina-provider.sqlite"));
  let persistedConfig = {};
  try {
    persistedConfig = JSON.parse(database.getMeta("marinaPublicConfig") || "{}");
  } catch {}
  const environment = { ...bundledMarinaEnvironment(), ...process.env };
  const marinaConfig = MarinaConfig.createConfig(environment, persistedConfig);
  if (MarinaConfig.hasExplicitConfig(environment)) {
    database.setMeta("marinaPublicConfig", JSON.stringify(MarinaConfig.publicEnvironment(marinaConfig)));
  }
  const tokenStore = new MarinaTokenStore({ database, safeStorage });
  const oauth = new MarinaOAuthController({ config: marinaConfig, tokenStore, openExternal: (url) => shell.openExternal(url) });
  const result = {};
  for (const source of VALID_SOURCES) {
    const api = new MarinaV1ApiClient({
      baseUrl: marinaConfig.apiBaseUrl,
      oauth,
      workspaceId: marinaConfig.workspaceIds[source],
      workspaceSlug: source
    });
    const workspaceConfig = Object.freeze({
      ...marinaConfig,
      workspaceId: marinaConfig.workspaceIds[source],
      workspaceSlug: source
    });
    const cacheKey = `marinaProviderCache:${source}`;
    const cacheStore = {
      load() {
        try { return JSON.parse(database.getMeta(cacheKey) || "{}"); }
        catch { return {}; }
      },
      save(value) { database.setMeta(cacheKey, JSON.stringify(value)); }
    };
    const service = new MarinaBookingProvider({ config: workspaceConfig, oauth, api, cacheStore });
    service.on("state", (state) => sendState(source, state));
    result[source] = { database, service, oauth, api };
  }
  return result;
}

async function createWindow() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": ["default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"] } });
  });
  window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1050,
    minHeight: 680,
    show: false,
    backgroundColor: "#f4f1e9",
    icon: path.join(__dirname, "assets", "marina-park-logo.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  await window.loadFile(path.join(__dirname, "index.html"));
}

async function start() {
  registerDesktopOAuthProtocol();
  Object.assign(contexts, createMarinaWorkspaceContexts());
  for (const url of pendingOAuthUrls.splice(0)) await handleOAuthUrl(url);
  registerIpc();
  for (const context of Object.values(contexts)) context.service.start();
  await createWindow();
  for (const url of pendingOAuthUrls.splice(0)) await handleOAuthUrl(url);
  configureAutoUpdater();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("open-url", (event, url) => { event.preventDefault(); void handleOAuthUrl(url); });
  app.on("second-instance", (_event, commandLine) => {
    void handleOAuthUrl(oauthUrlFromArgs(commandLine));
    window?.show();
    window?.focus();
  });
  const initialOAuthUrl = oauthUrlFromArgs(process.argv);
  if (initialOAuthUrl) pendingOAuthUrls.push(initialOAuthUrl);
  app.whenReady().then(start).catch((error) => { console.error(error); app.quit(); });
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  const closedDatabases = new Set();
  for (const context of Object.values(contexts)) {
    context.service.stop();
    if (context.database && !closedDatabases.has(context.database)) {
      closedDatabases.add(context.database);
      context.database.close();
    }
  }
});
