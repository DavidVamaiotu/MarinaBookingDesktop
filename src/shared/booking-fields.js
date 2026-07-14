(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BookingFields = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const GROUPS = Object.freeze({
    firstName: ["name", "firstname", "first_name", "given_name", "prenume"],
    lastName: ["secondname", "lastname", "last_name", "surname", "family_name", "nume"],
    email: ["email", "email_address", "emailaddress", "mail"],
    phone: ["phone", "phone_number", "phonenumber", "telephone", "tel", "mobile", "telefon"],
    adults: ["visitors", "adults", "adult", "numar_adulti", "numaradulti"],
    children: ["children", "kids", "child", "numar_copii", "numarcopii"],
    details: ["details", "detail", "detalii", "observations", "observation", "observatii", "observatie", "comments", "comment", "message", "mesaj", "mentions", "mentiuni", "special_requests", "specialrequests", "customer_note", "customer_notes"]
  });
  const OUTBOUND_CANONICAL_NAMES = Object.freeze({
    firstName: "name",
    lastName: "secondname",
    email: "email",
    phone: "phone",
    adults: "visitors",
    children: "children"
  });
  const MAX_FORM_FIELDS = 80;

  function normalizeName(name) {
    return String(name || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function normalizedAliases(names) {
    return new Set(names.flatMap((name) => GROUPS[name] || [name]).map(normalizeName));
  }

  function matchesName(name, ...aliases) {
    const normalized = normalizeName(name);
    const accepted = normalizedAliases(aliases);
    if (accepted.has(normalized)) return true;
    const withoutResourceSuffix = normalized.replace(/\d+$/, "");
    return withoutResourceSuffix !== normalized && accepted.has(withoutResourceSuffix);
  }

  function entries(booking, ...aliases) {
    return Object.entries(booking?.formData || {}).filter(([name]) => matchesName(name, ...aliases));
  }

  function entry(booking, ...aliases) {
    const matches = entries(booking, ...aliases);
    return matches.find(([, field]) => String(field?.value ?? "").trim()) || matches[0] || null;
  }

  function value(booking, ...aliases) {
    const match = entry(booking, ...aliases);
    return String(match?.[1]?.value ?? "").trim();
  }

  function assign(formData, canonicalName, aliases, nextValue, defaultType = "text") {
    const recognized = Object.keys(formData || {}).filter((name) => matchesName(name, canonicalName, ...aliases));
    const targets = recognized.length ? recognized : [canonicalName];
    for (const name of targets) {
      formData[name] = {
        ...(formData[name] || {}),
        value: String(nextValue ?? ""),
        type: formData[name]?.type || defaultType
      };
    }
    return formData;
  }

  function withoutResourceSuffix(name, resourceId) {
    const value = String(name || "").trim();
    const suffix = Number.isInteger(Number(resourceId)) && Number(resourceId) > 0 ? String(Number(resourceId)) : "";
    return suffix && value.endsWith(suffix) && value.length > suffix.length ? value.slice(0, -suffix.length) : value;
  }

  function outboundFieldName(name, sourceResourceId) {
    const unsuffixed = withoutResourceSuffix(name, sourceResourceId);
    for (const [group, canonicalName] of Object.entries(OUTBOUND_CANONICAL_NAMES)) {
      if (matchesName(unsuffixed, group)) return canonicalName;
    }
    return unsuffixed;
  }

  function fieldHasValue(field) {
    return String(field?.value ?? "").length > 0;
  }

  function preferOutboundField(current, candidate, candidateExact) {
    if (!current) return candidate;
    if (!fieldHasValue(current.field) && fieldHasValue(candidate)) return candidate;
    if (candidateExact && !current.exact && fieldHasValue(candidate)) return candidate;
    return current.field;
  }

  function prepareFormData(formData, sourceResourceId, { maxFields = MAX_FORM_FIELDS } = {}) {
    const prepared = {};
    const origins = new Map();
    for (const [originalName, originalField] of Object.entries(formData || {})) {
      if (!originalField || typeof originalField !== "object" || Array.isArray(originalField)) continue;
      const name = outboundFieldName(originalName, sourceResourceId);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) {
        throw Object.assign(new TypeError(`Câmpul formularului „${originalName}” are un nume invalid.`), { code: "invalid_form_field_name", permanent: true });
      }
      const field = { value: String(originalField.value ?? ""), type: String(originalField.type || "text") };
      const canonical = Object.values(OUTBOUND_CANONICAL_NAMES).includes(name);
      if (!canonical && !fieldHasValue(field)) continue;
      const current = origins.get(name);
      const exact = originalName === name;
      const preferred = preferOutboundField(current, field, exact);
      prepared[name] = preferred;
      origins.set(name, { exact: preferred === field ? exact : current?.exact, field: preferred });
    }
    const count = Object.keys(prepared).length;
    if (!count) {
      throw Object.assign(new TypeError("Rezervarea nu conține date de formular care pot fi salvate."), { code: "empty_form_data", permanent: true, fieldCount: 0 });
    }
    if (count > maxFields) {
      throw Object.assign(new TypeError(`Rezervarea conține ${count} câmpuri completate; limita acceptată este ${maxFields}.`), { code: "form_data_too_many_fields", permanent: true, fieldCount: count, maxFields });
    }
    return prepared;
  }

  function isDetailsField(name, field = {}) {
    if (matchesName(name, "details")) return true;
    return /^(textarea|multiline|textareafield)$/.test(normalizeName(field?.type));
  }

  function detailsValue(booking) {
    const named = value(booking, "details");
    if (named) return named;
    const match = Object.entries(booking?.formData || {}).find(([name, field]) => isDetailsField(name, field) && String(field?.value ?? "").trim());
    return String(match?.[1]?.value ?? "").trim();
  }

  return { GROUPS, MAX_FORM_FIELDS, assign, detailsValue, entries, entry, isDetailsField, matchesName, normalizeName, prepareFormData, value, withoutResourceSuffix };
});
