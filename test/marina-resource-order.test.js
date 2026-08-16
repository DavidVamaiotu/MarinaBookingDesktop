"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { orderMarinaResources } = require("../src/shared/marina-resource-order");

test("Marina resources omit the irrelevant 32 entry and preserve Camere migration order", () => {
  const resources = [
    { providerId: "27", title: "32" },
    { providerId: "18", title: "camera dubla in bungalow - superior 20" },
    { providerId: "2", title: "camera cvadrupla 4" },
    { providerId: "25", title: "rulota 1" },
    { providerId: "23", title: "glamping-1" },
    { providerId: "3", title: "camera dubla 2" },
    { providerId: "9", title: "camera dubla in bungalow 9" },
    { providerId: "1", title: "camera cvadrupla 1" }
  ];

  assert.deepEqual(orderMarinaResources(resources).map((resource) => resource.title), [
    "camera cvadrupla 1",
    "camera cvadrupla 4",
    "camera dubla 2",
    "camera dubla in bungalow 9",
    "camera dubla in bungalow - superior 20",
    "glamping-1",
    "rulota 1"
  ]);
  assert.equal(resources.length, 8);
});
