(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ErrorMessages = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FALLBACK = "Acțiunea nu a putut fi finalizată. Încercați din nou.";
  const CODE_RULES = [
    [/rate_limit|http_429/i, "Au fost trimise prea multe cereri. Aplicația va reîncerca automat."],
    [/authentication|forbidden|not_logged_in|nonce|required.*password|http_40[13]/i, "Autentificarea WordPress a eșuat. Verificați datele de acces."],
    [/availability|resource.*unavailable/i, "Perioada sau spațiul selectat nu mai este disponibil."],
    [/booking_not_found|external_id_not_found/i, "Rezervarea nu a fost găsită în WordPress."],
    [/invalid_resource/i, "Spațiul selectat nu este valid."],
    [/invalid_(date|dates|range|boundary_date)/i, "Perioada rezervării nu este validă."],
    [/invalid_email|client_email_missing/i, "Adresa de email a clientului nu este validă."],
    [/payment_email_disabled/i, "Emailurile de plată sunt dezactivate în WordPress."],
    [/payment_unavailable/i, "Cererile de plată nu sunt disponibile în configurația WordPress."],
    [/payment|deposit/i, "Operația de plată nu a putut fi finalizată."],
    [/price|pricing/i, "Prețul rezervării nu a putut fi calculat sau verificat."],
    [/idempotency|write_outcome_unknown|request_in_progress/i, "Operația nu este încă confirmată de WordPress. Aplicația va reîncerca în siguranță."],
    [/endpoint_changed/i, "Adresa API s-a schimbat. Verificați setările înainte de reîncercare."],
    [/network|timeout|http_5\d\d/i, "Serverul WordPress nu poate fi accesat momentan. Încercați din nou."],
    [/invalid_/i, "Datele trimise către WordPress nu sunt valide."],
    [/failed|unknown/i, FALLBACK]
  ];
  const MESSAGE_RULES = [
    [/too many requests|rate limit/i, "Au fost trimise prea multe cereri. Aplicația va reîncerca automat."],
    [/unauthorized|forbidden|not allowed|not logged in|authentication required|invalid credentials/i, "Autentificarea WordPress a eșuat. Verificați datele de acces."],
    [/booking not found|no booking exists/i, "Rezervarea nu a fost găsită în WordPress."],
    [/not found/i, "Informația solicitată nu a fost găsită în WordPress."],
    [/service unavailable|temporarily unavailable|bad gateway|gateway timeout|internal server error/i, "Serverul WordPress este temporar indisponibil. Încercați din nou."],
    [/failed to fetch|network error|network request failed|could not connect|connection refused/i, "Serverul WordPress nu poate fi accesat momentan. Verificați conexiunea."],
    [/request timed out|request timeout|timed out|timeout/i, "Cererea a expirat. Aplicația va reîncerca dacă operația este sigură."],
    [/booking calendar developer api is unavailable/i, "API-ul Booking Calendar nu este disponibil."],
    [/https is required/i, "Conexiunea API trebuie să folosească HTTPS."],
    [/valid rest nonce|application password is required/i, "Este necesară o parolă de aplicație WordPress validă."],
    [/cannot perform an edit-safe availability check|invalid availability result/i, "Disponibilitatea nu a putut fi verificată în siguranță."],
    [/cannot move bookings between resources/i, "Versiunea Booking Calendar instalată nu poate muta rezervări între spații."],
    [/could not preserve the booking note/i, "Nota rezervării nu a putut fi păstrată în timpul editării."],
    [/could not update the booking status/i, "Statusul rezervării nu a putut fi actualizat."],
    [/could not update the booking note/i, "Nota rezervării nu a putut fi actualizată."],
    [/could not update the booking trash state/i, "Rezervarea nu a putut fi mutată în sau din gunoi."],
    [/invalid booking source/i, "Sursa rezervărilor este invalidă."],
    [/invalid php serialization|unsupported php serialization|invalid php (number|string|array)/i, "Datele rezervării primite de la WordPress sunt invalide."],
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
      || /^(API-ul|WordPress nu|Nu există|Se așteaptă)/i.test(message);
  }

  function message(error, fallback = FALLBACK) {
    const raw = clean(error?.message || error);
    if (raw && isRomanian(raw)) return raw;
    const code = clean(error?.code);
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
