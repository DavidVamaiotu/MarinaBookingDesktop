"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeFormData } = require("../src/shared/form-data");

test("API form data keeps nested WordPress values and textarea types", () => {
  const result = normalizeFormData({
    phone4: { field_value: "+40 700 000 000", field_type: "text" },
    custom_request4: { values: ["Sosire târzie", "Pătuț"], type: "textarea" }
  });
  assert.deepEqual(result.phone4, { value: "+40 700 000 000", type: "text" });
  assert.deepEqual(result.custom_request4, { value: "Sosire târzie, Pătuț", type: "textarea" });
});

test("aggregate WordPress field collections fill missing fields without overriding direct values", () => {
  const result = normalizeFormData({
    details4: { value: "Valoare directă", type: "textarea" },
    _all_fields_: [{ field_name: "details4", field_value: "Valoare agregată", field_type: "textarea" }, { field_name: "telefon4", field_value: "0712", field_type: "text" }]
  });
  assert.equal(result.details4.value, "Valoare directă");
  assert.equal(result.telefon4.value, "0712");
});

test("aggregate WordPress schemas do not import empty fields into booking data", () => {
  const emptyFields = Array.from({ length: 100 }, (_, index) => ({ field_name: `schema_${index}`, field_value: "", field_type: "text" }));
  const result = normalizeFormData({
    name23: { value: "Ana", type: "text" },
    _all_fields_: [...emptyFields, { field_name: "details23", field_value: "Sosire târzie", field_type: "textarea" }]
  });
  assert.deepEqual(result, {
    details23: { value: "Sosire târzie", type: "textarea" },
    name23: { value: "Ana", type: "text" }
  });
});

test("serialized JSON form data is normalized instead of discarded", () => {
  assert.equal(normalizeFormData(JSON.stringify({ observatii2: { raw_value: "Fără gluten", type: "textarea" } })).observatii2.value, "Fără gluten");
});

test("PHP-serialized and URL-encoded WordPress form data keep customer fields", () => {
  const php = 'a:2:{s:4:"name";s:3:"Ana";s:5:"phone";a:2:{s:11:"field_value";s:4:"0712";s:10:"field_type";s:4:"text";}}';
  assert.deepEqual(normalizeFormData(php), {
    name: { value: "Ana", type: "text" },
    phone: { value: "0712", type: "text" }
  });
  assert.deepEqual(normalizeFormData("name=Ana+Maria&phone=%2B40712"), {
    name: { value: "Ana Maria", type: "text" },
    phone: { value: "+40712", type: "text" }
  });
});
