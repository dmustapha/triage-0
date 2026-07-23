// triage.js · the Triage-0 tool logic, extracted from the original inline script.
// The wiring contract is unchanged: same element IDs, same /transcribe + /triage (SSE) + /tts calls,
// same citation-first event order. Only the rendered markup was restyled to the Guided design (no emoji,
// friendly clinician copy, severity carried by a labelled badge). Plain vanilla JS, no build step.
(function () {
  var $ = function (id) { return document.getElementById(id); };

  // Inline SVG icons (no emoji in a clinical tool). Decorative: aria-hidden so screen
  // readers skip the path noise; the surrounding text carries the meaning.
  var ICON = {
    speaker: '<svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 8a5 5 0 0 1 0 8"/></svg>',
    guide: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 4h11l3 3v13H5z"/><path d="M9 9h7M9 13h7M9 17h4"/></svg>',
    alert: '<svg aria-hidden="true" class="sev-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 8v5M12 16.5v.5"/><path d="M10.3 3.8 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z"/></svg>',
    check: '<svg aria-hidden="true" class="sev-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
    rec: '<svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/></svg>',
    stop: '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    checkSm: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
    shield: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    chip: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3"/></svg>'
  };

  // ---- i18n: the whole flow from the case downwards renders in the case's language (en/fr/es) ----
  // The UI language is set from the detected language (the `detect` stage event / card.source_language),
  // so a French case shows French chrome, reasoning and audio. Templates use {placeholder} substitution.
  var I18N = {
    en: {
      langName: { en: "English", fr: "French", es: "Spanish" },
      reason_search: "Searching the guidelines", reason_read: "Reading the matched guideline", reason_think: "Reasoning through the protocol",
      st_detect: "Detected {lang}", st_translate_in: "Translated case → English", st_retrieve: "Searched {n} WHO passages",
      st_reason: "Reasoning on-device", st_classify: "Classified: {cls}", st_translate_out: "Translated output → {lang}", st_plan: "Built WHO management plan",
      d_langdetect: "on-device langdetect", d_nmt_in: "on-device Bergamot NMT", d_retrieval: "semantic retrieval", d_medpsy: "MedPsy 1.7B · GPU", d_classes: "1 of 27 WHO classes", d_nmt_out: "on-device NMT", d_grounded: "grounded in the cited protocol",
      cite_from: "From the WHO {protocol} guideline", cite_from_generic: "From the WHO guideline", cite_src: "{doc}, page {page}. Found in the guidelines on this device.",
      classification: "Classification", classes_hint: "1 of 27 WHO classes", conf_high: "high confidence", conf_medium: "medium confidence", conf_low: "low confidence",
      plan_pending: "Preparing the full management plan", plan_head: "Management plan", plan_meds: "Medicines", plan_supportive: "Supportive care", plan_home: "Home care", plan_return: "Return immediately if", plan_followup: "Follow-up", plan_referral: "Referral", plan_at_visit: "At the visit: {detail}",
      plan_foot: "Every line is taken verbatim from the WHO guidelines on this device. Doses are the WHO weight-band amounts; confirm the child’s weight.",
      sev_EMERGENCY: "Refer now", sev_URGENT: "Treat now and follow up", sev_ROUTINE: "Home care", sev_SELF_CARE: "Self-care advice", sev_UNKNOWN: "No matching guideline",
      abstain_msg: "This didn't match a WHO protocol. Triage-0 covers under-5 childhood illness and mental health for any age — check the description fits (the person's age and the signs you see), then rephrase or tap Speak again. If it is a real case outside this scope, escalate to a clinician.",
      audio_preparing: "Preparing the spoken guidance…", audio_listen: "Listen to the guidance", audio_ready: "Spoken guidance ready", audio_ready_s: "Spoken guidance ready · {s} s on this device", audio_fail: "Couldn't prepare the audio.", step2: "What the guideline says",
    },
    fr: {
      langName: { en: "anglais", fr: "français", es: "espagnol" },
      reason_search: "Recherche dans les protocoles", reason_read: "Lecture du protocole correspondant", reason_think: "Raisonnement selon le protocole",
      st_detect: "Langue détectée : {lang}", st_translate_in: "Cas traduit en anglais", st_retrieve: "{n} passages OMS consultés",
      st_reason: "Raisonnement sur l'appareil", st_classify: "Classé : {cls}", st_translate_out: "Résultat traduit en {lang}", st_plan: "Plan de prise en charge OMS établi",
      d_langdetect: "détection sur l'appareil", d_nmt_in: "NMT Bergamot sur l'appareil", d_retrieval: "recherche sémantique", d_medpsy: "MedPsy 1.7B · GPU", d_classes: "1 sur 27 classes OMS", d_nmt_out: "NMT sur l'appareil", d_grounded: "fondé sur le protocole cité",
      cite_from: "D'après le guide OMS {protocol}", cite_from_generic: "D'après le guide OMS", cite_src: "{doc}, page {page}. Trouvé dans les protocoles sur cet appareil.",
      classification: "Classification", classes_hint: "1 sur 27 classes OMS", conf_high: "confiance élevée", conf_medium: "confiance moyenne", conf_low: "confiance faible",
      plan_pending: "Préparation du plan de prise en charge", plan_head: "Plan de prise en charge", plan_meds: "Médicaments", plan_supportive: "Soins de soutien", plan_home: "Soins à domicile", plan_return: "Revenir immédiatement si", plan_followup: "Suivi", plan_referral: "Orientation", plan_at_visit: "À la visite : {detail}",
      plan_foot: "Chaque ligne est tirée textuellement des protocoles OMS sur cet appareil. Les doses sont les quantités OMS par tranche de poids ; confirmez le poids de l'enfant.",
      sev_EMERGENCY: "Orienter maintenant", sev_URGENT: "Traiter maintenant et suivre", sev_ROUTINE: "Soins à domicile", sev_SELF_CARE: "Conseils d'autosoins", sev_UNKNOWN: "Aucun protocole correspondant",
      abstain_msg: "Cela ne correspond à aucun protocole OMS. Triage-0 couvre les maladies de l'enfant de moins de 5 ans et la santé mentale à tout âge — vérifiez que la description correspond (l'âge de la personne et les signes observés), puis reformulez ou appuyez à nouveau sur Parler. S'il s'agit d'un vrai cas hors de ce champ, orientez vers un clinicien.",
      audio_preparing: "Préparation de la lecture vocale…", audio_listen: "Écouter les consignes", audio_ready: "Lecture vocale prête", audio_ready_s: "Lecture vocale prête · {s} s sur cet appareil", audio_fail: "Impossible de préparer l'audio.", step2: "Ce que dit le protocole",
    },
    es: {
      langName: { en: "inglés", fr: "francés", es: "español" },
      reason_search: "Buscando en los protocolos", reason_read: "Leyendo el protocolo correspondiente", reason_think: "Razonando según el protocolo",
      st_detect: "Idioma detectado: {lang}", st_translate_in: "Caso traducido al inglés", st_retrieve: "{n} pasajes de la OMS consultados",
      st_reason: "Razonando en el dispositivo", st_classify: "Clasificado: {cls}", st_translate_out: "Resultado traducido al {lang}", st_plan: "Plan de manejo de la OMS elaborado",
      d_langdetect: "detección en el dispositivo", d_nmt_in: "NMT Bergamot en el dispositivo", d_retrieval: "búsqueda semántica", d_medpsy: "MedPsy 1.7B · GPU", d_classes: "1 de 27 clases de la OMS", d_nmt_out: "NMT en el dispositivo", d_grounded: "basado en el protocolo citado",
      cite_from: "Del manual de la OMS {protocol}", cite_from_generic: "Del manual de la OMS", cite_src: "{doc}, página {page}. Encontrado en los protocolos de este dispositivo.",
      classification: "Clasificación", classes_hint: "1 de 27 clases de la OMS", conf_high: "confianza alta", conf_medium: "confianza media", conf_low: "confianza baja",
      plan_pending: "Preparando el plan de manejo", plan_head: "Plan de manejo", plan_meds: "Medicamentos", plan_supportive: "Cuidados de apoyo", plan_home: "Cuidados en casa", plan_return: "Vuelva de inmediato si", plan_followup: "Seguimiento", plan_referral: "Derivación", plan_at_visit: "En la visita: {detail}",
      plan_foot: "Cada línea está tomada textualmente de los protocolos de la OMS en este dispositivo. Las dosis son las cantidades de la OMS por franja de peso; confirme el peso del niño.",
      sev_EMERGENCY: "Derivar ahora", sev_URGENT: "Tratar ahora y dar seguimiento", sev_ROUTINE: "Cuidados en casa", sev_SELF_CARE: "Consejos de autocuidado", sev_UNKNOWN: "Ningún protocolo correspondiente",
      abstain_msg: "Esto no coincide con ningún protocolo de la OMS. Triage-0 cubre las enfermedades de menores de 5 años y la salud mental a cualquier edad — verifique que la descripción encaje (la edad de la persona y los signos que observa), luego reformule o pulse Hablar de nuevo. Si es un caso real fuera de este alcance, derive a un clínico.",
      audio_preparing: "Preparando la lectura en voz alta…", audio_listen: "Escuchar las indicaciones", audio_ready: "Lectura lista", audio_ready_s: "Lectura lista · {s} s en este dispositivo", audio_fail: "No se pudo preparar el audio.", step2: "Lo que dice el protocolo",
    },
  };
  var uiLang = "en";
  function t(key, params) {
    var dict = I18N[uiLang] || I18N.en;
    var s = dict[key] != null ? dict[key] : (I18N.en[key] != null ? I18N.en[key] : key);
    if (params) for (var k in params) s = s.split("{" + k + "}").join(params[k]);
    return s;
  }
  function langName(code) { return (I18N[uiLang] && I18N[uiLang].langName[code]) || code; }
  function setUiLang(code) { if (I18N[code]) uiLang = code; }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---- guidelines loaded count (for the live readout) + empty-store setup banner (H-7) ----
  fetch("/health").then(function (r) { return r.json(); }).then(function (h) {
    if ($("hChunks")) $("hChunks").textContent = h.chunks != null ? h.chunks : "·";

    // Header badge: drive it from the SERVER's egress guard, not navigator.onLine. `navigator.onLine`
    // reports network REACHABILITY (a judge on wifi sees "Online", which wrongly implies cloud use); the
    // real guarantee is that the server's egress guard is armed + strict with 0 violations this session.
    var eg = h.egress || {};
    var net = $("net");
    if (net && eg.armed) {
      var btxt = net.querySelector(".badge-txt");
      if (btxt) btxt.textContent = "On-device";
      net.classList.add("is-offline");   // accent styling = the confident, guaranteed state
      net.classList.remove("is-online");
      net.dataset.egress = "1";           // claim the badge so net.js won't repaint it (see net.js)
      net.title = "On-device only. Egress guard armed" + (eg.strict ? " (strict)" : "") +
        " — network calls this session: " + (eg.violations || 0) + " blocked.";
    }

    // On-device proof chips: the egress guarantee + the resident model, both read from /health.
    var proof = $("odProof");
    if (proof) {
      var chips = [];
      if (eg.armed) {
        chips.push(
          '<span class="od-chip od-chip--seal">' + ICON.shield +
          "Network calls this session: " + (eg.violations || 0) +
          (eg.strict ? " &middot; egress blocked (strict)" : "") + "</span>"
        );
      }
      if (h.medpsy) {
        chips.push('<span class="od-chip">' + ICON.chip + "MedPsy " + esc(String(h.medpsy).toUpperCase()) + " &middot; runs on this Mac</span>");
      }
      if (chips.length) { proof.innerHTML = chips.join(""); proof.hidden = false; }
    }

    // The RAG store is not ready if no chunks are loaded (citation map missing) OR the native vector store
    // returned no hits on the startup self-test (ragLive===false — store wiped). Either way every triage
    // would abstain, so surface a loud, actionable banner instead of letting it look like intended behavior.
    var banner = $("setupBanner");
    if (banner && (h.chunks === 0 || h.ragLive === false)) {
      banner.innerHTML =
        "<strong>Setup needed.</strong> The WHO guideline store is empty, so every case will abstain. " +
        "Run <code>npm run ingest</code> in the project folder, then restart the server.";
      banner.classList.remove("hidden");
    }
  }).catch(function () {});

  // ---- audio helpers: resample any recording to 16 kHz mono WAV ----
  // Whisper (the STT model) expects 16 kHz mono; browsers capture at 44.1/48 kHz and the @qvac SDK does
  // NOT resample, so a raw recording transcribes to garbage (or empty for webm/opus). Decode the blob with
  // the browser's own audio stack and re-render at 16 kHz mono, then hand /transcribe a clean WAV it reads
  // correctly. Portable: decodeAudioData handles Chrome's webm/opus AND Safari's mp4/aac, so this also
  // normalises the container across browsers. No server dependency (no ffmpeg needed on the host).
  function encodeWav16(float32, sampleRate) {
    var len = float32.length;
    var buf = new ArrayBuffer(44 + len * 2);
    var view = new DataView(buf);
    var ws = function (o, s) { for (var i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); view.setUint32(4, 36 + len * 2, true); ws(8, "WAVE");
    ws(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ws(36, "data"); view.setUint32(40, len * 2, true);
    var o = 44;
    for (var i = 0; i < len; i++) { var s = Math.max(-1, Math.min(1, float32[i])); view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
    return new Blob([view], { type: "audio/wav" });
  }
  async function blobTo16kWav(blob) {
    var AC = window.AudioContext || window["webkitAudioContext"];
    var ctx = new AC();
    try {
      var decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      var rate = 16000;
      var frames = Math.max(1, Math.ceil(decoded.duration * rate));
      var off = new OfflineAudioContext(1, frames, rate);
      var src = off.createBufferSource();
      src.buffer = decoded;
      src.connect(off.destination);
      src.start();
      var rendered = await off.startRendering();
      return encodeWav16(rendered.getChannelData(0), rate);
    } finally {
      try { ctx.close(); } catch (e) {}
    }
  }

  // ---- language example chips: one tap fills a real case (advertises the multilingual pipeline) ----
  var seedRow = $("seeds");
  if (seedRow) {
    seedRow.querySelectorAll(".seed").forEach(function (b) {
      b.addEventListener("click", function () {
        var t = b.getAttribute("data-fill") || "";
        var ta = $("case");
        if (ta) { ta.value = t; ta.focus(); }
        if ($("status")) $("status").textContent = "";
      });
    });
  }

  // ---- record -> /transcribe ----
  var mediaRec = null, chunks = [];
  if ($("rec")) $("rec").onclick = async function () {
    if (mediaRec && mediaRec.state === "recording") { mediaRec.stop(); return; }
    // Feature-detect: some browsers (and insecure origins) have neither. Fail to typing, not to a throw.
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      $("status").textContent = "Recording is not available here. Type the case instead.";
      return;
    }
    var stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      mediaRec = new MediaRecorder(stream);
      mediaRec.ondataavailable = function (e) { chunks.push(e.data); };
      mediaRec.onstop = async function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        $("rec").classList.remove("is-recording");
        $("rec").innerHTML = ICON.rec + "Speak";
        $("status").textContent = "Listening to what you said";
        var raw = new Blob(chunks, { type: mediaRec.mimeType || "audio/webm" });
        var fd = new FormData();
        // Resample to 16 kHz mono so whisper reads it (the SDK won't). Fall back to the raw blob if the
        // browser cannot decode it, so a decode quirk degrades to "try again" rather than a hard throw.
        try { fd.append("audio", await blobTo16kWav(raw), "case.wav"); }
        catch (rex) { fd.append("audio", raw, "case.webm"); }
        try {
          var r = await fetch("/transcribe", { method: "POST", body: fd });
          if (!r.ok) {
            var emsg = "That recording was too long. Try a shorter case.";
            try { var ej = await r.json(); if (ej && ej.error) emsg = ej.error; } catch (e2) {}
            $("status").textContent = emsg;
            return;
          }
          var j = await r.json();
          // M-6: an empty/whitespace transcript (silence, noise, or a too-short clip) must NOT look like a
          // successful "heard in Xs" with a blank box — nudge the user to retry or type instead.
          if (j.text && j.text.trim()) {
            var heard = j.text.trim();
            $("case").value = heard;
            // Nudge if the transcript is suspiciously thin (a clipped/short recording) — otherwise it would
            // silently route to an abstain and the worker would blame the tool, not the incomplete capture.
            var words = heard.split(/\s+/).filter(Boolean).length;
            if (words < 4) {
              $("status").textContent = "That sounded brief — check the text below or tap Speak again.";
            } else {
              $("status").textContent = j.perf
                ? ("heard in " + (j.perf.durationMs / 1000).toFixed(1) + " s · on this device")
                : "heard, on this device";
            }
          } else {
            $("status").textContent = "Didn't catch that — try speaking again, or type the case.";
          }
        } catch (e) { $("status").textContent = "Could not hear that. Type the case instead."; }
      };
      mediaRec.start();
      $("rec").classList.add("is-recording");
      $("rec").innerHTML = ICON.stop + "Stop";
      $("status").textContent = "Listening. Tap stop when done.";
    } catch (e) {
      // Stop any mic track we managed to acquire so the mic light does not stay on.
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      $("status").textContent = "Microphone is off. Type the case instead.";
    }
  };

  // ---- render ----
  function renderCitation(c) {
    var box = $("citationBox");
    box.classList.remove("hidden");
    // The card pass (SSE "card") calls this a SECOND time to refine the early raw-chunk citation to the
    // classification-correct one. If a citation is already shown, update its text IN PLACE — replacing the
    // whole innerHTML would recreate the .cite node and replay its cite-in entrance animation ~20s later,
    // a visible flicker (Phase-7 rehearsal). Keeping the node stable swaps the text with no re-animation.
    var cite = box.querySelector(".cite");
    if (cite) {
      cite.querySelector(".q").textContent = '"' + c.section + '"';
      cite.querySelector(".src").textContent = t("cite_src", { doc: c.doc, page: c.page });
      return;
    }
    var fromTxt = c.protocol ? t("cite_from", { protocol: esc(c.protocol) }) : t("cite_from_generic");
    box.innerHTML =
      '<div class="cite">' +
        '<span class="from">' + ICON.guide + fromTxt + "</span>" +
        '<span class="q">"' + esc(c.section) + '"</span>' +
        '<span class="src">' + t("cite_src", { doc: esc(c.doc), page: esc(String(c.page)) }) + "</span>" +
      "</div>";
  }

  function renderCard(card, classification) {
    finishStages();
    $("reasoningWrap").classList.add("hidden");
    $("card").classList.remove("hidden");
    var sev = card.severity;
    var ico = (sev === "ROUTINE" || sev === "SELF_CARE") ? ICON.check : ICON.alert;
    var flags = (card.red_flags || []).map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("");
    // Clinical order: Severity (how urgent) -> Classification (what it is) -> Why -> Action -> Management.
    // The WHO classification is shown as "Classification" (not "Diagnosis"): IMCI/mhGAP produce a
    // protocol classification, and the tool is decision-SUPPORT, not a diagnoser (see the disclaimer).
    // 1D: the model's self-reported confidence (already in the payload — previously dropped). Neutral
    // styling; high gets the single accent, medium/low stay muted (severity remains the only loud colour).
    var conf = card.confidence;
    var confChip = (conf && sev !== "UNKNOWN")
      ? '<span class="conf conf--' + esc(conf) + '" title="The model\'s self-reported confidence in this classification">' + esc(t("conf_" + conf)) + "</span>"
      : "";
    var dx = (classification && sev !== "UNKNOWN")
      ? '<div class="dx"><span class="dx-label">' + t("classification") + '</span><span class="dx-name">' + esc(classification) + "</span>" + confChip + '<span class="dx-hint">' + t("classes_hint") + "</span></div>"
      : "";
    // Phase 4: non-English cases are routed via an on-device English translation and the card is translated
    // back. Flag it so the worker knows the text is machine-translated while the WHO citation stays English.
    var TR_BANNER = {
      fr: "Traduit du français — texte non textuel ; citation OMS en anglais",
      es: "Traducido del español — texto no textual ; cita OMS en inglés",
    };
    var banner = card.translated
      ? '<div class="tr-banner" role="note">' + esc(TR_BANNER[card.source_language] || "Translated — not verbatim WHO; citation in English") + "</div>"
      : "";
    $("card").innerHTML =
      '<div class="verdict">' +
        '<div class="sev ' + sev + '">' + ico + sev + "</div>" +
        '<div class="sev-note">' + t("sev_" + sev) + "</div>" +
      "</div>" +
      banner +
      dx +
      (sev !== "UNKNOWN" && card.reasoning ? '<div class="why">' + esc(card.reasoning) + "</div>" : "") +
      '<div class="action">' + (sev === "UNKNOWN" ? t("abstain_msg") : esc(card.action)) + "</div>" +
      (flags ? '<ul class="flags">' + flags + "</ul>" : "") +
      (sev !== "UNKNOWN" ? '<div id="planWrap" class="plan-pending" role="status" aria-live="polite">' + t("plan_pending") + "</div>" : "") +
      // Spoken guidance is prepared in the BACKGROUND once the full plan lands (see prepareGuidanceAudio):
      // synthesize the whole management, then reveal a play button when the COMPLETE audio is ready. No
      // autoplay of a partial clip — the worker presses play on finished audio.
      (sev !== "UNKNOWN"
        ? '<div class="hear"><span class="spin" aria-hidden="true"></span><span id="ttsStatus" class="status">' + t("audio_preparing") + "</span></div><div id=\"audioWrap\"></div>"
        : "");
    lastCard = card;
    // On a small screen the verdict can land below the fold once the reasoning box has grown;
    // bring the card into view so the severity is the first thing the worker sees.
    if (window.matchMedia && window.matchMedia("(max-width:560px)").matches) {
      $("card").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // ---- management plan (Task #22) ----
  // Each line is grounded + cited server-side; the renderer only lays it out. Empty groups are skipped,
  // so a partial plan (some components missing) renders gracefully with no empty headings.
  function shortDoc(doc) {
    // "WHO IMCI Chart Booklet (2014)" -> "WHO IMCI"; "WHO mhGAP Intervention Guide v2.0" -> "WHO mhGAP".
    return String(doc).split(/\s+/).slice(0, 2).join(" ");
  }
  function citeMini(c) {
    if (!c) return "";
    return '<span class="cmini">' + esc(shortDoc(c.doc)) + " p." + esc(String(c.page)) + "</span>";
  }
  function pgroup(title, inner) {
    return '<div class="pgroup"><h4>' + esc(title) + "</h4>" + inner + "</div>";
  }
  function prow(text, c) {
    return '<div class="prow"><span class="ptext">' + esc(text) + "</span>" + citeMini(c) + "</div>";
  }
  function listGroup(title, arr, field) {
    if (!arr || !arr.length) return "";
    return pgroup(title, arr.map(function (x) { return prow(x[field], x.citation); }).join(""));
  }
  function doseTable(bands) {
    if (!bands || !bands.length) return "";
    return '<table class="dose"><thead><tr><th>Age / weight</th><th>Dose</th></tr></thead><tbody>' +
      bands.map(function (b) {
        return '<tr><td class="dose-band">' + esc(b.band) + '</td><td class="dose-amt">' + esc(b.dose) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }
  function renderPlan(plan) {
    var wrap = $("planWrap");
    if (!wrap) return;
    var parts = [];
    if (plan && plan.medicines && plan.medicines.length) {
      var meds = plan.medicines.map(function (m) {
        var head = '<div class="med-top"><span class="med-name">' + esc(m.name) + "</span>" + citeMini(m.citation) + "</div>";
        var sub = [];
        if (m.strength) sub.push(esc(m.strength));
        if (m.frequency) sub.push(esc(m.frequency));
        if (m.duration) sub.push(esc(m.duration));
        var subHtml = sub.length ? '<div class="med-sub">' + sub.join(" &middot; ") + "</div>" : "";
        // Real per-weight-band dosing table; fall back to the legacy "By weight band" line only if no bands.
        var detail = (m.bands && m.bands.length) ? doseTable(m.bands) : (m.dose ? '<div class="med-sub">Dose: ' + esc(m.dose) + "</div>" : "");
        return '<div class="med">' + head + subHtml + detail + "</div>";
      }).join("");
      parts.push(pgroup(t("plan_meds"), meds));
    }
    parts.push(listGroup(t("plan_supportive"), plan && plan.supportive, "item"));
    parts.push(listGroup(t("plan_home"), plan && plan.home_care, "advice"));
    parts.push(listGroup(t("plan_return"), plan && plan.return_now, "sign"));
    if (plan && plan.follow_up) {
      var fuInner = '<div class="prow"><span class="ptext">' + esc(plan.follow_up.when) + "</span>" + citeMini(plan.follow_up.citation) + "</div>";
      if (plan.follow_up.detail) fuInner += '<div class="prow-detail">' + t("plan_at_visit", { detail: esc(plan.follow_up.detail) }) + "</div>";
      parts.push(pgroup(t("plan_followup"), fuInner));
    }
    if (plan && plan.referral) parts.push(pgroup(t("plan_referral"), prow(plan.referral.criterion, plan.referral.citation)));
    parts = parts.filter(Boolean);
    if (!parts.length) { wrap.innerHTML = ""; wrap.className = ""; return; }
    wrap.className = "";
    wrap.innerHTML =
      '<div class="plan">' +
        '<div class="plan-head">' + ICON.guide + t("plan_head") + "</div>" +
        parts.join("") +
        '<div class="plan-foot">' + t("plan_foot") + "</div>" +
      "</div>";
  }

  // ---- on-device pipeline readout ----
  // Each SSE `stage` event is a REAL step the server just ran. Advancing the checklist marks the prior
  // active step done (a check) and appends the new one as active (a spinner). Truthful by construction:
  // a row exists only because its step actually executed on this device. Ignored if the list is absent.
  function markActiveDone() {
    var box = $("plSteps");
    if (!box) return;
    var active = box.querySelector(".pl-step.is-active");
    if (active) {
      active.className = "pl-step is-done";
      var ic = active.querySelector(".pl-ic");
      if (ic) ic.innerHTML = ICON.checkSm;
    }
  }
  // Build the stage label/detail in the case's language from the event's key + data (lang/count/cls),
  // falling back to the backend's English label if a template is missing.
  function stageLabel(d) {
    switch (d.key) {
      case "detect": return t("st_detect", { lang: langName(d.lang || uiLang) });
      case "translate_in": return t("st_translate_in");
      case "retrieve": return t("st_retrieve", { n: d.count != null ? d.count : "" });
      case "reason": return t("st_reason");
      case "classify": return t("st_classify", { cls: d.cls || "" });
      case "translate_out": return t("st_translate_out", { lang: langName(d.lang || uiLang) });
      case "plan": return t("st_plan");
      default: return d.label || d.key;
    }
  }
  var STAGE_DETAIL = { detect: "d_langdetect", translate_in: "d_nmt_in", retrieve: "d_retrieval", reason: "d_medpsy", classify: "d_classes", translate_out: "d_nmt_out", plan: "d_grounded" };
  function renderStage(d) {
    var box = $("plSteps");
    if (!box || !d || !d.key) return;
    markActiveDone();
    var li = document.createElement("li");
    li.className = "pl-step is-active";
    li.setAttribute("data-key", String(d.key));
    var detail = STAGE_DETAIL[d.key] ? t(STAGE_DETAIL[d.key]) : (d.detail || "");
    li.innerHTML =
      '<span class="pl-ic" aria-hidden="true"></span>' +
      '<span class="pl-label">' + esc(stageLabel(d)) + "</span>" +
      (detail ? '<span class="pl-detail">' + esc(detail) + "</span>" : "");
    box.appendChild(li);
  }
  // On a terminal frame, close out the last spinning step so the readout never freezes mid-spin.
  function finishStages() { markActiveDone(); }

  function handleEvent(block) {
    // SSE comment frames (keep-alives) start with ":". Ignore them, they carry no event.
    if (block.charAt(0) === ":") return;
    var ev = (block.match(/^event: (.*)$/m) || [])[1];
    var dataLine = (block.match(/^data: (.*)$/m) || [])[1];
    if (!ev || !dataLine) return;
    var d;
    // A malformed frame must be skipped, not kill the whole stream.
    try { d = JSON.parse(dataLine); } catch (e) { return; }
    if (ev === "stage") {
      // The detect stage sets the whole flow's language, so every later stage + the card localize.
      if (d.key === "detect" && d.lang) {
        setUiLang(d.lang);
        var h2 = $("h-guideline"); if (h2) h2.textContent = t("step2");
        $("reasonLabel").textContent = t("reason_search");
      }
      renderStage(d);
    } else if (ev === "citation") {
      renderCitation(d);
      $("reasonLabel").textContent = t("reason_read");
    } else if (ev === "first_token") {
      $("hTtft").textContent = (d.ttftMs / 1000).toFixed(1) + " s";
      // H-1 staged status: the model has started producing its assessment.
      $("reasonLabel").textContent = t("reason_think");
    } else if (ev === "reasoning") {
      // The model reasons in English internally. For a non-English case we DON'T stream that English text
      // (it would break the "everything in the case's language" flow) — the localized pipeline readout shows
      // progress and the card's translated "why" carries the reasoning in the case's language.
      if (uiLang !== "en") return;
      var r = $("reasoning");
      // Only autoscroll if the worker is already near the bottom, so reading back does not get yanked.
      var atBottom = r.scrollHeight - r.scrollTop - r.clientHeight < 40;
      r.textContent += d.delta.replace(/<\/?think>/g, "");
      if (atBottom) r.scrollTop = r.scrollHeight;
    } else if (ev === "card") {
      gotTerminal = true;
      renderCard(d.card, d.classification);
      // Replace the early (raw-chunk) citation with the card's clean, classification-correct citation.
      if (d.card && d.card.protocol_citation && d.card.protocol_citation.section) renderCitation({
        section: d.card.protocol_citation.section, doc: d.card.protocol_citation.doc, page: d.card.protocol_citation.page,
      });
      if (d.perf) {
        if (d.perf.ttftMs != null) $("hTtft").textContent = (d.perf.ttftMs / 1000).toFixed(1) + " s";
        $("hTps").textContent = d.perf.tokensPerSec != null ? Number(d.perf.tokensPerSec).toFixed(1) : "·";
        $("hDev").textContent = (d.perf.backendDevice || "·").toUpperCase();
      }
    } else if (ev === "plan") {
      renderPlan(d.plan);
      // Full plan is in — synthesize the whole spoken guidance in the background now.
      if (lastCard && lastCard.severity !== "UNKNOWN") prepareGuidanceAudio(lastCard, d.plan);
    } else if (ev === "abstain") {
      gotTerminal = true;
      // Render even an abstain in the case's language (the detect stage also set this; belt-and-suspenders).
      if (d.lang) setUiLang(d.lang);
      finishStages();
      renderCard(d.card);
    } else if (ev === "error") {
      gotTerminal = true;
      $("err").textContent = d.error;
      $("reasoningWrap").classList.add("hidden");
    }
  }
  // Set true when a terminal frame (card/abstain/error) arrives, so we can tell a clean
  // finish from a stream that closed early and left a blank card.
  var gotTerminal = false;

  // ---- H-1: reasoning wait-timer ----
  // On-device reasoning takes seconds; a live elapsed counter reassures the worker the tool is working
  // (not hung) while the model thinks, and the reasonLabel carries the stage. Decorative — aria-hidden.
  var _rtInt = null, _rtT0 = 0;
  function startReasonTimer() {
    _rtT0 = Date.now();
    var t = $("reasonTimer");
    if (t) t.textContent = "";
    if (_rtInt) clearInterval(_rtInt);
    _rtInt = setInterval(function () {
      if (t) t.textContent = "· " + Math.floor((Date.now() - _rtT0) / 1000) + "s";
    }, 250);
  }
  function stopReasonTimer() {
    if (_rtInt) { clearInterval(_rtInt); _rtInt = null; }
    var t = $("reasonTimer");
    if (t) t.textContent = "";
  }

  // ---- assess -> /triage (SSE) ----
  // H-2: an AbortController lets the worker Stop an in-flight assessment; the Get-guidance button toggles
  // to a Stop button for the duration (mirrors the mic Speak/Stop toggle) and aborts the fetch on click.
  var assessCtl = null;
  async function runAssess() {
    var caseText = $("case").value.trim();
    if (!caseText) { $("status").textContent = "Describe or record a case first."; $("case").focus(); return; }
    // Re-entrancy guard: a run is already in flight (assessCtl set). The keyboard path (Ctrl/Cmd+Enter)
    // bypasses the button, so without this a second run would overwrite assessCtl + the shared timer
    // interval (stopping the live one) and start a second /triage the single-job engine only queues.
    if (assessCtl) return;
    gotTerminal = false;
    assessCtl = new AbortController();
    // Toggle the button into Stop mode (kept enabled so the worker can abort). Restored in `finally`.
    var assessLabel = $("assess").innerHTML;
    $("assess").innerHTML = ICON.stop + "Stop";
    $("assess").classList.add("is-stopping");
    $("assess").onclick = function () { if (assessCtl) assessCtl.abort(); };
    $("status").textContent = "";
    $("result").classList.remove("hidden");
    $("result").setAttribute("aria-busy", "true");
    $("citationBox").classList.add("hidden");
    $("card").classList.add("hidden");
    $("err").textContent = "";
    $("reasoningWrap").classList.remove("hidden");
    $("reasoning").textContent = "";
    if ($("plSteps")) $("plSteps").innerHTML = "";
    audioReqId++; lastCard = null; // drop any spoken guidance still cooking for a previous case
    uiLang = "en"; // reset until the detect stage sets the case's language
    $("reasonLabel").textContent = t("reason_search");
    $("hTtft").textContent = "·"; $("hTps").textContent = "·"; $("hDev").textContent = "·";
    startReasonTimer();
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
    var buf = "";
    try {
      var r = await fetch("/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseText: caseText }),
        signal: assessCtl.signal
      });
      // Guard before reading the stream: a non-2xx or bodyless response has no readable stream.
      if (!r.ok || !r.body) {
        var msg = "Could not get guidance (" + r.status + ").";
        try { var j = await r.json(); if (j && j.error) msg = j.error; } catch (e) {}
        throw new Error(msg);
      }
      var reader = r.body.getReader();
      var dec = new TextDecoder();
      for (;;) {
        var res = await reader.read();
        if (res.done) break;
        buf += dec.decode(res.value, { stream: true });
        var i;
        while ((i = buf.indexOf("\n\n")) >= 0) { handleEvent(buf.slice(0, i)); buf = buf.slice(i + 2); }
      }
      // Stream closed cleanly but no card/abstain/error arrived: do not leave a silent blank card.
      if (!gotTerminal) {
        $("err").textContent = "The guidance did not finish. Try again.";
        $("reasoningWrap").classList.add("hidden");
      }
    } catch (e) {
      // H-2: a worker-initiated Stop aborts the fetch → AbortError. That is not a failure; show a calm
      // "Stopped." and clear the reasoning box rather than an error.
      if (e && e.name === "AbortError") {
        $("status").textContent = "Stopped.";
        $("err").textContent = "";
        // If a card already rendered, drop its still-pending plan placeholder so it does not hang.
        var pw = $("planWrap");
        if (pw && /plan-pending/.test(pw.className)) { pw.textContent = ""; pw.className = ""; }
      } else {
        $("err").textContent = "Could not get guidance. " + e.message;
      }
      $("reasoningWrap").classList.add("hidden");
    } finally {
      // Restore the button + timer in finally so a Stop or a mid-stream interruption never leaves the
      // button stuck in Stop mode or the timer running.
      stopReasonTimer();
      $("assess").disabled = false;
      $("assess").innerHTML = assessLabel;
      $("assess").classList.remove("is-stopping");
      $("assess").onclick = runAssess;
      assessCtl = null;
      $("result").removeAttribute("aria-busy");
    }
  }
  if ($("assess")) $("assess").onclick = runAssess;
  // Ctrl/Cmd+Enter from the case box submits, the way a clinician expects.
  if ($("case")) $("case").addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runAssess(); }
  });

  // ---- spoken guidance: synthesized in the BACKGROUND, revealed complete ----
  // Rather than a click that reads one line and can cut off, we synthesize the WHOLE management once the
  // plan lands, keep it "cooking" in the background, and only surface a play button when the COMPLETE audio
  // is ready. The worker then presses play (no autoplay of a partial clip). The engine is single-job, so
  // this TTS runs after the triage inference has finished and serializes behind any new request.
  var lastCard = null;
  var lastTtsUrl = null;
  var audioReqId = 0; // guards against a stale case's audio landing over a newer one

  // Assemble a natural spoken script from the card + plan. Both are already in the case's language
  // (translated server-side), so the TEXT is language-correct; the VOICE follows the `lang` we pass.
  function planToSpeech(card, plan) {
    var parts = [];
    if (card.severity) parts.push(t("sev_" + card.severity) + ".");
    if (card.action) parts.push(card.action);
    if (plan) {
      if (plan.medicines && plan.medicines.length) {
        var meds = plan.medicines.map(function (m) {
          return m.name + (m.strength ? ", " + m.strength : (m.dose ? ", " + m.dose : ""));
        }).join(". ");
        parts.push(t("plan_meds") + ": " + meds + ".");
      }
      if (plan.supportive && plan.supportive.length) {
        parts.push(t("plan_supportive") + ": " + plan.supportive.map(function (x) { return x.item; }).join("; ") + ".");
      }
      if (plan.return_now && plan.return_now.length) {
        parts.push(t("plan_return") + ": " + plan.return_now.map(function (x) { return x.sign; }).join("; ") + ".");
      }
      if (plan.follow_up && plan.follow_up.when) parts.push(t("plan_followup") + ": " + plan.follow_up.when + ".");
    }
    var text = parts.join(" ").replace(/\s+/g, " ").trim();
    // The server caps /tts at 1000 chars; trim on a sentence boundary so we never cut a word mid-way.
    if (text.length > 1000) { text = text.slice(0, 1000); text = text.slice(0, text.lastIndexOf(". ") + 1) || text; }
    return text;
  }

  function prepareGuidanceAudio(card, plan) {
    var st = $("ttsStatus");
    var wrap = $("audioWrap");
    var text = planToSpeech(card, plan);
    if (!text || !wrap) return;
    var reqId = ++audioReqId;
    if (st) st.textContent = t("audio_preparing");
    fetch("/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, lang: card.source_language || "en" }),
    }).then(function (r) {
      if (!r.ok) throw new Error("tts " + r.status);
      var perf = r.headers.get("X-Perf");
      return r.blob().then(function (blob) { return { blob: blob, perf: perf }; });
    }).then(function (res) {
      // A newer case started while this was cooking — drop this stale audio.
      if (reqId !== audioReqId) return;
      if (lastTtsUrl) { URL.revokeObjectURL(lastTtsUrl); lastTtsUrl = null; }
      var url = URL.createObjectURL(res.blob);
      lastTtsUrl = url;
      wrap.innerHTML = "";
      var audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "auto";
      audio.src = url;
      audio.style.display = "block";
      audio.style.marginTop = "12px";
      audio.style.width = "100%";
      wrap.appendChild(audio);
      // The play button appears only now that the COMPLETE audio is ready.
      var btn = document.createElement("button");
      btn.className = "btn btn--ghost";
      btn.type = "button";
      btn.title = "Play the spoken guidance — synthesized on this device.";
      btn.innerHTML = ICON.speaker + t("audio_listen");
      btn.onclick = function () { audio.play().catch(function () {}); };
      wrap.insertBefore(btn, audio);
      var secs = res.perf ? (JSON.parse(res.perf).durationMs / 1000).toFixed(1) : null;
      if (st) st.textContent = secs ? t("audio_ready_s", { s: secs }) : t("audio_ready");
      var spin = st && st.previousElementSibling;
      if (spin && /spin/.test(spin.className)) spin.style.display = "none";
    }).catch(function () {
      if (reqId !== audioReqId) return;
      if (st) st.textContent = t("audio_fail");
      var spin = st && st.previousElementSibling;
      if (spin && /spin/.test(spin.className)) spin.style.display = "none";
    });
  }

  // Test hook (browser-safe: `module` is undefined in the browser, so this is a no-op there and the
  // app wiring above runs unchanged). Lets jsdom unit tests exercise the pure render/parse logic.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      esc: esc,
      renderCitation: renderCitation,
      renderCard: renderCard,
      renderPlan: renderPlan,
      renderStage: renderStage,
      doseTable: doseTable,
      handleEvent: handleEvent,
      shortDoc: shortDoc,
      citeMini: citeMini,
      // Exported for the jsdom Stop/timer test (H-1/H-2). These drive the /triage flow, so the test can
      // stub fetch + AbortController and assert the abort path, staged label, and timer lifecycle.
      runAssess: runAssess,
      startReasonTimer: startReasonTimer,
      stopReasonTimer: stopReasonTimer,
    };
  }
})();
