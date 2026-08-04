"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ErrorMessages = require("../src/shared/error-messages");

test("known English API and proxy errors are translated to Romanian", () => {
  assert.equal(
    ErrorMessages.message(new Error("Too many requests. Please try again shortly.")),
    "Au fost trimise prea multe cereri. Aplicația va reîncerca automat."
  );
  assert.equal(
    ErrorMessages.message(new Error("Bad Gateway")),
    "Serverul WordPress este temporar indisponibil. Încercați din nou."
  );
  assert.equal(
    ErrorMessages.message(new Error("Error invoking remote method 'booking:create': Error: Booking not found.")),
    "Rezervarea nu a fost găsită în WordPress."
  );
});

test("structured API codes are translated even when their message is unknown", () => {
  assert.equal(
    ErrorMessages.message({ code: "marina_booking_api_invalid_resource", message: "Unexpected text" }),
    "Spațiul selectat nu este valid."
  );
  assert.equal(
    ErrorMessages.message({ code: "http_503", message: "Unexpected text" }),
    "Serverul WordPress nu poate fi accesat momentan. Încercați din nou."
  );
});

test("Romanian errors are preserved and unknown English errors use a Romanian fallback", () => {
  assert.equal(
    ErrorMessages.message(new Error("Rezervarea nu a fost găsită.")),
    "Rezervarea nu a fost găsită."
  );
  assert.equal(
    ErrorMessages.message(new Error("An entirely new upstream failure")),
    ErrorMessages.FALLBACK
  );
});
