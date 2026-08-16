"use strict";

const BookingFields = require("./booking-fields");

function fieldValue(field) {
  if (Array.isArray(field)) return field.map(fieldValue).filter((value) => value !== "").join(", ");
  if (field && typeof field === "object") {
    const valueKey = ["value", "field_value", "raw_value", "val", "values"].find((key) => Object.prototype.hasOwnProperty.call(field, key));
    return valueKey ? fieldValue(field[valueKey]) : "";
  }
  return field ?? "";
}

function formValue(formData, ...aliases) {
  const entries = Object.entries(formData || {});
  const match = entries.find(([name, field]) => BookingFields.matchesName(name, ...aliases) && String(fieldValue(field)).trim() !== "")
    || entries.find(([name]) => BookingFields.matchesName(name, ...aliases));
  return String(fieldValue(match?.[1]) || "").trim();
}

function customFieldsFromFormData(formData) {
  const result = {};
  for (const [name, field] of Object.entries(formData || {})) {
    if (BookingFields.matchesName(name, "firstName", "lastName", "email", "phone", "adults", "children")) continue;
    const value = String(fieldValue(field)).trim();
    if (value) result[String(name)] = value;
  }
  return result;
}

function customerFromFormData(formData) {
  return {
    first_name: formValue(formData, "firstName"),
    last_name: formValue(formData, "lastName"),
    email: formValue(formData, "email"),
    phone: formValue(formData, "phone"),
    address: {},
    custom_fields: customFieldsFromFormData(formData)
  };
}

module.exports = { customerFromFormData, customFieldsFromFormData, fieldValue, formValue };
