"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const sources = new Set(["rooms", "camping"]);
let currentSource = "rooms";

function setSource(source) {
  if (!sources.has(source)) throw new TypeError("Sursa rezervărilor este invalidă.");
  currentSource = source;
}

function sourceFor(input) {
  return sources.has(input?.source) ? input.source : currentSource;
}

contextBridge.exposeInMainWorld("marina", Object.freeze({
  setSource,
  bootstrap: (range) => invoke("state:bootstrap", currentSource, range),
  refresh: (range, options = {}) => invoke("state:refresh", currentSource, range, options),
  createBooking: (input) => invoke("booking:create", sourceFor(input), input),
  editBooking: (id, patch) => invoke("booking:edit", sourceFor(patch), id, patch),
  setStatus: (id, patch) => invoke("booking:status", sourceFor(patch), id, patch),
  setNote: (id, patch) => invoke("booking:note", sourceFor(patch), id, patch),
  setTrash: (id, patch) => invoke("booking:trash", sourceFor(patch), id, patch),
  getPayment: (id, input = {}) => invoke("booking:payment", sourceFor(input), id),
  updateDeposit: (id, input) => invoke("booking:deposit", sourceFor(input), id, input),
  requestPayment: (id, input) => invoke("booking:payment-request", sourceFor(input), id, input),
  checkAvailability: (input) => invoke("booking:availability", sourceFor(input), input),
  quoteBooking: (input) => invoke("booking:quote", sourceFor(input), input),
  clearQuoteCache: () => invoke("booking:quote-clear", currentSource),
  retryCommand: (id) => invoke("queue:retry", currentSource, id),
  revertBooking: (id) => invoke("queue:revert", currentSource, id),
  clearFailedCommands: () => invoke("queue:clear-failed", currentSource),
  pauseQueue: () => invoke("queue:pause", currentSource),
  resumeQueue: () => invoke("queue:resume", currentSource),
  getSettings: (source = currentSource) => invoke("settings:get", sources.has(source) ? source : currentSource),
  saveSettings: (input) => invoke("settings:save", sourceFor(input), input),
  testConnection: (input) => invoke("settings:test", sourceFor(input), input),
  clearCredentials: (source = currentSource) => invoke("settings:clear", sources.has(source) ? source : currentSource),
  onStateChanged: (callback) => {
    const listener = (_event, payload) => { if (payload?.source === currentSource) callback(payload.state); };
    ipcRenderer.on("state:changed", listener);
    return () => ipcRenderer.removeListener("state:changed", listener);
  }
}));
