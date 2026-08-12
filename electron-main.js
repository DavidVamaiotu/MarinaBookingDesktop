"use strict";

const { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("node:path");
const { BookingDatabase } = require("./src/main/database");
const { CredentialVault } = require("./src/main/credential-vault");
const { MarinaApiClient, normalizeBaseUrl } = require("./src/main/api-client");
const { CommandQueue } = require("./src/main/command-queue");
const { BookingService } = require("./src/main/booking-service");
const validate = require("./src/main/validation");

app.setName("Marina Booking");
if (process.platform === "linux") app.commandLine.appendSwitch("password-store", "gnome-libsecret");

let window = null;
let updaterConfigured = false;
const contexts = {};
const VALID_SOURCES = new Set(["rooms", "camping"]);

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
    const { service, database } = contextFor(source);
    const booking = validate.bookingInput(input);
    booking.apiDates = database.bookingDateTimes(booking.dates);
    return service.create(booking);
  });
  ipcMain.handle("booking:edit", (_event, source, localId, patch) => contextFor(source).service.update(validate.id(localId, "localId"), validate.bookingPatch(patch), "edit"));
  ipcMain.handle("booking:status", (_event, source, localId, patch) => contextFor(source).service.update(validate.id(localId, "localId"), validate.bookingPatch(patch), "status"));
  ipcMain.handle("booking:note", (_event, source, localId, patch) => contextFor(source).service.update(validate.id(localId, "localId"), validate.bookingPatch(patch), "note"));
  ipcMain.handle("booking:trash", (_event, source, localId, patch) => contextFor(source).service.update(validate.id(localId, "localId"), validate.bookingPatch(patch), "trash"));
  ipcMain.handle("booking:payment", (_event, source, localId) => contextFor(source).service.payment(validate.id(localId, "localId")));
  ipcMain.handle("booking:deposit", (_event, source, localId, input) => contextFor(source).service.updateDeposit(validate.id(localId, "localId"), validate.deposit(input)));
  ipcMain.handle("booking:payment-request", (_event, source, localId, input) => contextFor(source).service.requestPayment(validate.id(localId, "localId"), validate.paymentRequest(input)));
  ipcMain.handle("booking:availability", (_event, source, input) => {
    const { service } = contextFor(source);
    input = validate.object(input);
    const resourceId = Number(input.resourceId);
    if (!Number.isInteger(resourceId) || resourceId < 1) throw new TypeError("resourceId trebuie să fie pozitiv.");
    const excludeBookingId = input.excludeBookingId === undefined || input.excludeBookingId === null
      ? undefined
      : validate.id(input.excludeBookingId, "excludeBookingId");
    return service.availability(resourceId, validate.availabilityDates(input.dates), { excludeBookingId });
  });
  ipcMain.handle("booking:quote", (_event, source, input) => contextFor(source).service.quote(validate.quoteInput(input)));
  ipcMain.handle("booking:quote-clear", (_event, source) => contextFor(source).service.clearQuoteCache());
  ipcMain.handle("queue:retry", (_event, source, id) => contextFor(source).service.retry(validate.id(id, "commandId")));
  ipcMain.handle("queue:revert", (_event, source, localId) => contextFor(source).service.revert(validate.id(localId, "localId")));
  ipcMain.handle("queue:clear-failed", (_event, source) => contextFor(source).service.clearFailedCommands());
  ipcMain.handle("queue:pause", (_event, source) => {
    for (const queueSource of ["rooms", "camping"]) contextFor(queueSource).service.pauseQueue();
    return contextFor(source).service.state().diagnostics;
  });
  ipcMain.handle("queue:resume", (_event, source) => {
    for (const queueSource of ["rooms", "camping"]) contextFor(queueSource).service.resumeQueue();
    return contextFor(source).service.state().diagnostics;
  });
  ipcMain.handle("settings:get", (_event, source) => contextFor(source).service.settings());
  ipcMain.handle("settings:save", (_event, source, input) => {
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
    const { service } = contextFor(source);
    const settings = validate.settings(input);
    settings.apiBaseUrl = normalizeBaseUrl(settings.apiBaseUrl);
    const password = settings.password || service.vault.getPassword();
    if (!password) throw new Error("Parola de aplicație este obligatorie înainte de testarea conexiunii.");
    const testClient = new MarinaApiClient({ getConfig: async () => ({ ...settings, password }) });
    return { ok: true, resources: (await testClient.resources()).length };
  });
  ipcMain.handle("settings:clear", (_event, source) => {
    const { service, database } = contextFor(source);
    service.clearQuoteCache();
    service.vault.clear();
    database.saveSettings({ apiBaseUrl: "", username: "" });
    database.setMeta("authPaused", "true");
    service.queue.authPaused = true;
    service.emitState();
    return service.settings();
  });
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
  return { database, service };
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
  registerIpc();
  for (const context of Object.values(contexts)) context.service.start();
  await createWindow();
  configureAutoUpdater();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { window?.show(); window?.focus(); });
  app.whenReady().then(start).catch((error) => { console.error(error); app.quit(); });
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  for (const context of Object.values(contexts)) {
    context.service.stop();
    context.database.close();
  }
});
