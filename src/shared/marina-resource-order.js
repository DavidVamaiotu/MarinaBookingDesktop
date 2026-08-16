"use strict";

const titleCollator = new Intl.Collator("ro", { numeric: true, sensitivity: "base" });

function resourceTitle(resource) {
  return String(resource?.title ?? resource?.name ?? resource?.label ?? "").trim();
}

function isIgnoredMarinaResource(resource) {
  return resourceTitle(resource) === "32";
}

function providerOrder(resource) {
  const value = Number(resource?.providerId ?? resource?.id);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function compareMarinaResources(left, right) {
  return providerOrder(left) - providerOrder(right)
    || titleCollator.compare(resourceTitle(left), resourceTitle(right))
    || String(left?.providerId ?? left?.id ?? "").localeCompare(String(right?.providerId ?? right?.id ?? ""));
}

function orderMarinaResources(resources) {
  return [...(resources || [])].filter((resource) => !isIgnoredMarinaResource(resource)).sort(compareMarinaResources);
}

module.exports = { compareMarinaResources, isIgnoredMarinaResource, orderMarinaResources };
