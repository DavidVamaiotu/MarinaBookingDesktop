"use strict";

const VALUE_KEYS = ["value", "field_value", "raw_value", "val", "values"];
const AGGREGATE_KEYS = new Set(["_all_", "_all_fields_"]);

function hasValueKey(field) {
  return Boolean(field && typeof field === "object" && !Array.isArray(field) && VALUE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(field, key)));
}

function formValue(field) {
  if (Array.isArray(field)) return field.map(formValue).filter((value) => value !== "").join(", ");
  if (field && typeof field === "object") {
    const key = VALUE_KEYS.find((candidate) => Object.prototype.hasOwnProperty.call(field, candidate));
    return key ? formValue(field[key]) : "";
  }
  return field ?? "";
}

function parsePhpSerialized(source) {
  let index = 0;
  const encoder = new TextEncoder();
  const expect = (value) => {
    if (!source.startsWith(value, index)) throw new Error("Invalid PHP serialization");
    index += value.length;
  };
  const readUntil = (delimiter) => {
    const end = source.indexOf(delimiter, index);
    if (end < 0) throw new Error("Invalid PHP serialization");
    const value = source.slice(index, end);
    index = end + delimiter.length;
    return value;
  };
  const read = () => {
    const type = source[index++];
    if (type === "N") { expect(";"); return null; }
    expect(":");
    if (type === "b") return readUntil(";") === "1";
    if (type === "i" || type === "d") {
      const value = Number(readUntil(";"));
      if (!Number.isFinite(value)) throw new Error("Invalid PHP number");
      return value;
    }
    if (type === "s") {
      const byteLength = Number(readUntil(":"));
      if (!Number.isInteger(byteLength) || byteLength < 0) throw new Error("Invalid PHP string length");
      expect('"');
      let end = index;
      let bytes = 0;
      while (end < source.length && bytes < byteLength) {
        const character = String.fromCodePoint(source.codePointAt(end));
        bytes += encoder.encode(character).length;
        end += character.length;
      }
      if (bytes !== byteLength || source.slice(end, end + 2) !== '";') throw new Error("Invalid PHP string");
      const value = source.slice(index, end);
      index = end + 2;
      return value;
    }
    if (type === "a") {
      const length = Number(readUntil(":"));
      if (!Number.isInteger(length) || length < 0) throw new Error("Invalid PHP array length");
      expect("{");
      const entries = [];
      for (let item = 0; item < length; item += 1) entries.push([read(), read()]);
      expect("}");
      const sequential = entries.every(([key], item) => Number.isInteger(key) && key === item);
      return sequential ? entries.map(([, value]) => value) : Object.fromEntries(entries.map(([key, value]) => [String(key), value]));
    }
    throw new Error("Unsupported PHP serialization type");
  };
  try {
    const value = read();
    return index === source.length ? value : null;
  } catch {
    return null;
  }
}

function parseUrlEncoded(source) {
  if (!/(^|&)[^=&]+=[^&]*/.test(source)) return null;
  const result = {};
  for (const [key, value] of new URLSearchParams(source)) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      result[key] = Array.isArray(result[key]) ? [...result[key], value] : [result[key], value];
    } else result[key] = value;
  }
  return Object.keys(result).length ? result : null;
}

function parsedCollection(source) {
  if (typeof source !== "string") return source;
  try { return JSON.parse(source); }
  catch {
    return parsePhpSerialized(source) ?? parseUrlEncoded(source) ?? {};
  }
}

function addField(result, name, field, { includeEmpty = true } = {}) {
  name = String(name || "").trim();
  if (!name || AGGREGATE_KEYS.has(name)) return;
  if (field && typeof field === "object" && !Array.isArray(field) && !hasValueKey(field)) return;
  const value = String(formValue(field));
  if (!includeEmpty && !value) return;
  result[name] = {
    value,
    type: String(field?.type || field?.field_type || (name.toLowerCase().startsWith("email") ? "email" : "text"))
  };
}

function collectFormData(source, result, depth = 0, aggregate = false) {
  source = parsedCollection(source);
  if (!source || depth > 3) return;
  if (Array.isArray(source)) {
    for (const field of source) addField(result, field?.name || field?.field_name || field?.key, field, { includeEmpty: !aggregate });
    return;
  }
  if (typeof source !== "object") return;
  for (const key of AGGREGATE_KEYS) {
    if (source[key]) collectFormData(source[key], result, depth + 1, true);
  }
  for (const [name, field] of Object.entries(source)) {
    if (AGGREGATE_KEYS.has(name)) continue;
    addField(result, name, field, { includeEmpty: !aggregate });
  }
}

function normalizeFormData(source) {
  const result = {};
  collectFormData(source, result);
  return result;
}

module.exports = { formValue, normalizeFormData };
