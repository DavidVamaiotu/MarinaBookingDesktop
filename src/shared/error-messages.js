(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ErrorMessages = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FALLBACK = "Acțiunea nu a putut fi finalizată. Încercați din nou.";
  const AUTHORITATIVE_CODE_RULES = [
    [/mfa_required/i, "Finalizați verificarea în doi pași în Marina înainte de a reîncerca."],
    [/password_change_required/i, "Schimbați parola contului Marina înainte de a reîncerca."],
    [/workspace_forbidden/i, "Contul conectat nu are acces la workspace-ul Marina selectat."],
    [/^forbidden$/i, "Contul conectat nu are permisiunea necesară pentru această acțiune în Marina."]
  ];
  const CODE_RULES = [
    [/marina_insufficient_permissions/i, "Utilizatorul conectat nu are permisiuni de scriere pentru trimiterea emailurilor de plată pe serverul Marina."],
    [/rate_limit|http_429/i, "Au fost trimise prea multe cereri. Aplicația va reîncerca automat."],
    [/authentication|forbidden|unauthorized|http_40[13]/i, "Autentificarea Marina a eșuat. Reconectați contul."],
    [/availability|resource.*unavailable/i, "Perioada sau spațiul selectat nu mai este disponibil."],
    [/booking_not_found|marina_booking_missing/i, "Rezervarea nu a fost găsită în Marina."],
    [/invalid_resource/i, "Spațiul selectat nu este valid."],
    [/invalid_(date|dates|range|boundary_date)/i, "Perioada rezervării nu este validă."],
    [/invalid_email|client_email_missing/i, "Adresa de email a clientului nu este validă."],
    [/payment_email_disabled/i, "Emailurile de plată sunt dezactivate în Marina."],
    [/payment_unavailable/i, "Cererile de plată nu sunt disponibile în configurația Marina."],
    [/marina_stale_version|stale.*version|http_412/i, "Rezervarea Marina a fost modificată între timp. Datele actualizate au fost încărcate; verificați din nou înainte de salvare."],
    [/payment|deposit/i, "Operația de plată nu a putut fi finalizată."],
    [/price|pricing/i, "Prețul rezervării nu a putut fi calculat sau verificat."],
    [/idempotency|write_outcome_unknown|request_in_progress/i, "Operația nu este încă confirmată de Marina. Încercați din nou după actualizare."],
    [/endpoint_changed/i, "Adresa API s-a schimbat. Verificați setările înainte de reîncercare."],
    [/network|timeout|http_5\d\d/i, "Serverul Marina nu poate fi accesat momentan. Încercați din nou."],
    [/invalid_/i, "Datele trimise către Marina nu sunt valide."],
    [/failed|unknown/i, FALLBACK]
  ];
  const MESSAGE_RULES = [
    [/insufficient.*permissions?/i, "Utilizatorul conectat nu are permisiuni de scriere pentru trimiterea emailurilor de plată pe serverul Marina."],
    [/too many requests|rate limit/i, "Au fost trimise prea multe cereri. Aplicația va reîncerca automat."],
    [/unauthorized|forbidden|not allowed|authentication required|invalid credentials/i, "Autentificarea Marina a eșuat. Reconectați contul."],
    [/booking not found|no booking exists/i, "Rezervarea nu a fost găsită în Marina."],
    [/not found/i, "Informația solicitată nu a fost găsită în Marina."],
    [/service unavailable|temporarily unavailable|bad gateway|gateway timeout|internal server error/i, "Serverul Marina este temporar indisponibil. Încercați din nou."],
    [/failed to fetch|network error|network request failed|could not connect|connection refused/i, "Serverul Marina nu poate fi accesat momentan. Verificați conexiunea."],
    [/request timed out|request timeout|timed out|timeout/i, "Cererea a expirat. Aplicația va reîncerca dacă operația este sigură."],
    [/https is required/i, "Conexiunea API trebuie să folosească HTTPS."],
    [/cannot perform an edit-safe availability check|invalid availability result/i, "Disponibilitatea nu a putut fi verificată în siguranță."],
    [/could not preserve the booking note/i, "Nota rezervării nu a putut fi păstrată în timpul editării."],
    [/could not update the booking status/i, "Statusul rezervării nu a putut fi actualizat."],
    [/could not update the booking note/i, "Nota rezervării nu a putut fi actualizată."],
    [/could not update the booking trash state/i, "Rezervarea nu a putut fi mutată în sau din gunoi."],
    [/invalid booking source/i, "Sursa rezervărilor este invalidă."],
    [/invalid availability/i, "Perioada de disponibilitate este invalidă."],
    [/must be|is invalid|could not|cannot|failed/i, FALLBACK]
  ];

  function clean(value) {
    return String(value || "")
      .replace(/^Error invoking remote method '[^']+':\s*/i, "")
      .replace(/^Error:\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isRomanian(message) {
    return /[ăâîșț]/i.test(message)
      || /\b(acțiunea|adresa|aplicația|avansul|cererea|clientului|comanda|conexiunea|datele|emailul|eroare|intervalul|nota|operația|parola|perioada|prețul|rezervarea|serverul|setările|spațiul|statusul|trebuie|verificați)\b/i.test(message)
      || /^(API-ul|Marina nu|Nu există|Se așteaptă)/i.test(message);
  }

  function message(error, fallback = FALLBACK) {
    const raw = clean(error?.message || error);
    const code = clean(error?.code);
    for (const [pattern, translated] of AUTHORITATIVE_CODE_RULES) {
      if (code && pattern.test(code)) return translated;
    }
    if (raw && isRomanian(raw)) return raw;
    for (const [pattern, translated] of CODE_RULES) {
      if (code && pattern.test(code)) return translated;
    }
    for (const [pattern, translated] of MESSAGE_RULES) {
      if (raw && pattern.test(raw)) return translated;
    }
    return clean(fallback) || FALLBACK;
  }

  return { FALLBACK, message };
});
