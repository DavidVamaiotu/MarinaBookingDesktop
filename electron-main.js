"use strict";

const { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const { execFileSync } = require("node:child_process");
const { mkdirSync, renameSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { BookingDatabase } = require("./src/main/database");
const { CredentialVault } = require("./src/main/credential-vault");
const { MarinaApiClient, normalizeBaseUrl } = require("./src/main/api-client");
const MarinaConfig = require("./src/shared/marina-config");
const { CommandQueue } = require("./src/main/command-queue");
const { BookingService } = require("./src/main/booking-service");
const { MarinaOAuthController } = require("./src/main/marina-oauth-controller");
const { MarinaTokenStore } = require("./src/main/marina-token-store");
const { MarinaV1ApiClient } = require("./src/main/marina-v1-client");
const { MarinaBookingProvider } = require("./src/main/marina-provider-service");
const { MarinaRoomsMigrationService } = require("./src/main/marina-migration-service");
const { MarinaPublicPricingSource } = require("./src/main/marina-public-pricing");
const validate = require("./src/main/validation");

app.setName("Marina Booking");
if (process.platform === "linux") app.commandLine.appendSwitch("password-store", "gnome-libsecret");

let window = null;
let updaterConfigured = false;
const contexts = {};
const VALID_SOURCES = new Set(["rooms", "camping", "marina"]);
const pendingOAuthUrls = [];

function assertWritableSource(source) {
  if (source !== "marina") return;
  const settings = contextFor(source).service.settings();
  if (!settings.connected) throw Object.assign(new Error("Conectează contul Marina înainte de a modifica rezervări."), { code: "marina_reconnect_required", auth: true, permanent: true });
  if (!settings.capabilities?.canMutateBookings) throw Object.assign(new Error("Contul Marina conectat nu are scope-ul bookings:write."), { code: "marina_scope_required", permanent: true });
}

function assertReadableSource(source) {
  if (source !== "marina") return;
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
  const oauth = contexts.marina?.oauth;
  if (!oauth) { pendingOAuthUrls.push(url); return; }
  try {
    await oauth.acceptCallback(url);
    if (contexts.marina.service.visibleRange) await contexts.marina.service.refresh(contexts.marina.service.visibleRange);
    window?.show();
    window?.focus();
  } catch (error) {
    console.error("Marina OAuth callback failed:", error.code || error.message);
    contexts.marina.service.emitState();
  }
}

function configureAutoUpdater() {
  if (updaterConfigured || !app.isPackaged || process.platform !== "win32") return;
  updaterConfigured = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (error) => console.error("Desktop update failed:", error));
  autoUpdater.on("update-downloaded", async ({ version }) => {
    const { response } = await dialog.showMessageBox(window, {
      type: "info",
      title: "Actualizare pregătită",
      message: `Marina Booking ${version} a fost descărcată.`,
      detail: "Repornește aplicația pentru a instala actualizarea.",
      buttons: ["Repornește și instalează", "Mai târziu"],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (response === 0) autoUpdater.quitAndInstall(false, true);
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

function sendMigrationStatus(status) {
  if (window && !window.isDestroyed()) window.webContents.send("marina:migration-progress", status);
}

function assertMigrationAccess() {
  const context = contextFor("marina");
  const settings = context.service.settings();
  if (!settings.connected) throw Object.assign(new Error("Reconectează Marina înainte de import."), { code: "marina_reconnect_required", auth: true, permanent: true });
  if (!settings.capabilities?.resourcesRead || !settings.capabilities?.resourcesWrite || !settings.capabilities?.bookingsRead || !settings.capabilities?.bookingsWrite) {
    throw Object.assign(new Error("Importul necesită scope-urile resources:read, resources:write, bookings:read și bookings:write."), { code: "marina_scope_required", permanent: true });
  }
  return context;
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
    const { service, database } = contextFor(source);
    const booking = validate.bookingInput(input);
    if (database && source !== "marina") booking.apiDates = database.bookingDateTimes(booking.dates);
    return service.create(booking);
  });
  ipcMain.handle("booking:get", (_event, source, localId) => {
    assertReadableSource(source);
    if (source !== "marina") return contextFor(source).service.state().bookings.find((booking) => booking.localId === validate.id(localId, "localId")) || null;
    return contextFor(source).service.details(validate.id(localId, "localId"));
  });
  ipcMain.handle("booking:edit", (_event, source, localId, patch) => { assertWritableSource(source); return contextFor(source).service.update(validate.id(localId, "localId"), validate.bookingPatch(patch), "edit"); });
  ipcMain.handle("booking:status", (_event, source, localId, patch) => { assertWritableSource(source); return contextFor(source).service.update(validate.id(localId, "localId"), validate.bookingPatch(patch), "status"); });
  ipcMain.handle("booking:note", (_event, source, localId, patch) => { assertWritableSource(source); return contextFor(source).service.update(validate.id(localId, "localId"), validate.bookingPatch(patch), "note"); });
  ipcMain.handle("booking:trash", (_event, source, localId, patch) => { assertWritableSource(source); return contextFor(source).service.update(validate.id(localId, "localId"), validate.bookingPatch(patch), "trash"); });
  ipcMain.handle("booking:payment", (_event, source, localId) => { assertReadableSource(source); return contextFor(source).service.payment(validate.id(localId, "localId")); });
  ipcMain.handle("booking:deposit", (_event, source, localId, input) => { assertWritableSource(source); return contextFor(source).service.updateDeposit(validate.id(localId, "localId"), validate.deposit(input, { requireNote: source !== "marina" })); });
  ipcMain.handle("booking:payment-request", (_event, source, localId, input) => { assertWritableSource(source); return contextFor(source).service.requestPayment(validate.id(localId, "localId"), validate.paymentRequest(input)); });
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
  ipcMain.handle("queue:retry", (_event, source, id) => { assertWritableSource(source); return contextFor(source).service.retry(validate.id(id, "commandId")); });
  ipcMain.handle("queue:revert", (_event, source, localId) => { assertWritableSource(source); return contextFor(source).service.revert(validate.id(localId, "localId")); });
  ipcMain.handle("queue:clear-failed", (_event, source) => { assertWritableSource(source); return contextFor(source).service.clearFailedCommands(); });
  ipcMain.handle("queue:pause", (_event, source) => {
    if (source === "marina") throw Object.assign(new Error("Calendarul Marina nu folosește coada locală WordPress."), { code: "marina_feature_unsupported", permanent: true });
    for (const queueSource of ["rooms", "camping"]) contextFor(queueSource).service.pauseQueue();
    return contextFor(source).service.state().diagnostics;
  });
  ipcMain.handle("queue:resume", (_event, source) => {
    if (source === "marina") throw Object.assign(new Error("Calendarul Marina nu folosește coada locală WordPress."), { code: "marina_feature_unsupported", permanent: true });
    for (const queueSource of ["rooms", "camping"]) contextFor(queueSource).service.resumeQueue();
    return contextFor(source).service.state().diagnostics;
  });
  ipcMain.handle("settings:get", (_event, source) => contextFor(source).service.settings());
  ipcMain.handle("settings:save", (_event, source, input) => {
    assertWritableSource(source);
    if (source === "marina") throw Object.assign(new Error("Configurația OAuth Marina se furnizează prin mediul aplicației."), { code: "marina_settings_managed", permanent: true });
    const { service, database } = contextFor(source);
    const settings = validate.settings(input);
    settings.apiBaseUrl = normalizeBaseUrl(settings.apiBaseUrl);
    if (!settings.password && !service.vault.hasPassword()) throw new Error("Parola de aplicație este obligatorie la prima salvare a setărilor.");
    if (settings.password) service.vault.setPassword(settings.password);
    const previous = database.getSettings();
    database.saveSettings(settings);
    const endpointChanged = Boolean(previous.apiBaseUrl && previous.apiBaseUrl !== settings.apiBaseUrl);
    if (previous.apiBaseUrl !== settings.apiBaseUrl || previous.username !== settings.username || settings.password) database.invalidateLoadedRanges();
    if (previous.apiBaseUrl !== settings.apiBaseUrl) service.clearQuoteCache();
    if (endpointChanged) {
      database.quarantineQueuedCommands();
      service.queue.pauseForEndpointChange();
    } else {
      service.queue.resumeAfterCredentials({ retryFailed: !previous.apiBaseUrl || previous.apiBaseUrl === settings.apiBaseUrl });
    }
    service.emitState();
    return service.settings();
  });
  ipcMain.handle("settings:test", async (_event, source, input) => {
    assertWritableSource(source);
    if (source === "marina") {
      const today = new Date().toISOString().slice(0, 10);
      const state = await contextFor(source).service.refresh(contextFor(source).service.visibleRange || { start: today, end: today });
      return { ok: true, resources: state.resources.length };
    }
    const { service } = contextFor(source);
    const settings = validate.settings(input);
    settings.apiBaseUrl = normalizeBaseUrl(settings.apiBaseUrl);
    const password = settings.password || service.vault.getPassword();
    if (!password) throw new Error("Parola de aplicație este obligatorie înainte de testarea conexiunii.");
    const testClient = new MarinaApiClient({ getConfig: async () => ({ ...settings, password }) });
    return { ok: true, resources: (await testClient.resources()).length };
  });
  ipcMain.handle("settings:clear", (_event, source) => {
    assertWritableSource(source);
    if (source === "marina") return contextFor(source).service.disconnect().then((state) => state.settings);
    const { service, database } = contextFor(source);
    service.clearQuoteCache();
    service.vault.clear();
    database.saveSettings({ apiBaseUrl: "", username: "" });
    database.setMeta("authPaused", "true");
    service.queue.authPaused = true;
    service.emitState();
    return service.settings();
  });
  ipcMain.handle("marina:connect", () => contextFor("marina").service.connect());
  ipcMain.handle("marina:disconnect", () => contextFor("marina").service.disconnect());
  ipcMain.handle("marina:migration-status", () => contextFor("marina").migration.status());
  ipcMain.handle("marina:migration-preview", () => assertMigrationAccess().migration.preview());
  ipcMain.handle("marina:migration-run", async () => {
    const context = assertMigrationAccess();
    const result = await context.migration.run();
    if (context.service.visibleRange) await context.service.refresh(context.service.visibleRange);
    return result;
  });
}

function createMarinaSetupContext() {
  const database = new BookingDatabase(path.join(app.getPath("userData"), "marina-provider.sqlite"));
  let persistedConfig = {};
  try {
    persistedConfig = JSON.parse(database.db.prepare("SELECT value FROM sync_meta WHERE key='marinaPublicConfig'").get()?.value || "{}");
  } catch {}
  const marinaConfig = MarinaConfig.createConfig(process.env, persistedConfig);
  if (MarinaConfig.hasExplicitConfig(process.env)) {
    database.setMeta("marinaPublicConfig", JSON.stringify(MarinaConfig.publicEnvironment(marinaConfig)));
  }
  const tokenStore = new MarinaTokenStore({ database, safeStorage });
  const oauth = new MarinaOAuthController({ config: marinaConfig, tokenStore, openExternal: (url) => shell.openExternal(url) });
  const api = new MarinaV1ApiClient({ baseUrl: marinaConfig.apiBaseUrl, oauth });
  const cacheStore = {
    load() {
      try { return JSON.parse(database.db.prepare("SELECT value FROM sync_meta WHERE key='marinaProviderCache'").get()?.value || "{}"); }
      catch { return {}; }
    },
    save(value) { database.setMeta("marinaProviderCache", JSON.stringify(value)); }
  };
  const service = new MarinaBookingProvider({ config: marinaConfig, oauth, api, cacheStore });
  service.on("state", (state) => sendState("marina", state));
  return { database, service, oauth, api };
}

function createSourceContext(source, filename, defaults = {}) {
  const database = new BookingDatabase(path.join(app.getPath("userData"), filename), defaults.stayTimes);
  const current = database.getSettings();
  if (defaults.apiBaseUrl && !current.apiBaseUrl) database.saveSettings({ apiBaseUrl: defaults.apiBaseUrl, timezone: defaults.timezone || "Europe/Bucharest" });
  if (defaults.resources?.length && database.listResources().length === 0) database.replaceResources(defaults.resources);
  const vault = new CredentialVault(database, safeStorage);
  const initialSettings = database.getSettings();
  if (!vault.hasPassword() || !initialSettings.apiBaseUrl || !initialSettings.username) {
    database.setMeta("authPaused", "true");
    database.setMeta("online", "false");
  }
  const api = new MarinaApiClient({ getConfig: async () => ({ ...database.getSettings(), password: vault.getPassword() }) });
  const queue = new CommandQueue({ database, api, skipAvailabilityChecks: Boolean(defaults.skipAvailabilityChecks) });
  const service = new BookingService({ database, api, queue, vault, resourceIds: defaults.resourceIds });
  service.on("state", (state) => sendState(source, state));
  return { database, service, api };
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
  contexts.rooms = createSourceContext("rooms", "marina-booking.sqlite");
  contexts.camping = createSourceContext("camping", "marina-booking-camping.sqlite", {
    apiBaseUrl: "https://camping.marinapark.ro/wp-json/marina-booking/v1",
    stayTimes: { checkIn: "14:00:01", checkOut: "12:00:02" },
    skipAvailabilityChecks: true,
    resources: [
      { id: 1, title: "Corturi", capacity: 10, base_cost: null, default_form: "standard" },
      { id: 2, title: "Rulote", capacity: 5, base_cost: null, default_form: "rulota" }
    ]
  });
  contexts.marina = createMarinaSetupContext();
  const migrationStore = {
    load() {
      try { return JSON.parse(contexts.marina.database.db.prepare("SELECT value FROM sync_meta WHERE key='marinaRoomsMigrationJournal'").get()?.value || "{}"); }
      catch { return {}; }
    },
    save(value) { contexts.marina.database.setMeta("marinaRoomsMigrationJournal", JSON.stringify(value)); }
  };
  contexts.marina.migration = new MarinaRoomsMigrationService({
    sourceApi: {
      resources: () => contexts.rooms.api.resources({ timeoutMs: 60_000 }),
      bookings: (start, end) => contexts.rooms.api.bookings(start, end, null, { timeoutMs: 60_000, maxAttempts: 3 })
    },
    targetApi: contexts.marina.api,
    pricingSource: new MarinaPublicPricingSource(),
    journalStore: migrationStore,
    onProgress: sendMigrationStatus
  });
  for (const url of pendingOAuthUrls.splice(0)) await handleOAuthUrl(url);
  registerIpc();
  for (const context of Object.values(contexts)) context.service.start();
  await createWindow();
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
  for (const context of Object.values(contexts)) {
    context.service.stop();
    context.database?.close();
  }
});
