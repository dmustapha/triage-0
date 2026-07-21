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

  var SEV_NOTE = {
    EMERGENCY: "Refer now",
    URGENT: "Treat now and follow up",
    ROUTINE: "Home care",
    SELF_CARE: "Self-care advice",
    UNKNOWN: "No matching guideline"
  };

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
            $("case").value = j.text.trim();
            $("status").textContent = j.perf
              ? ("heard in " + (j.perf.durationMs / 1000).toFixed(1) + " s · on this device")
              : "heard, on this device";
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
      cite.querySelector(".src").textContent = c.doc + ", page " + c.page + ". Found in the guidelines on this device.";
      return;
    }
    box.innerHTML =
      '<div class="cite">' +
        '<span class="from">' + ICON.guide + "From the WHO " + (c.protocol ? esc(c.protocol) + " " : "") + "guideline</span>" +
        '<span class="q">"' + esc(c.section) + '"</span>' +
        '<span class="src">' + esc(c.doc) + ", page " + esc(String(c.page)) + ". Found in the guidelines on this device.</span>" +
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
      ? '<span class="conf conf--' + esc(conf) + '" title="The model\'s self-reported confidence in this classification">' + esc(conf) + " confidence</span>"
      : "";
    var dx = (classification && sev !== "UNKNOWN")
      ? '<div class="dx"><span class="dx-label">Classification</span><span class="dx-name">' + esc(classification) + "</span>" + confChip + '<span class="dx-hint">1 of 27 WHO classes</span></div>'
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
        '<div class="sev-note">' + (SEV_NOTE[sev] || "") + "</div>" +
      "</div>" +
      banner +
      dx +
      (card.reasoning ? '<div class="why">' + esc(card.reasoning) + "</div>" : "") +
      '<div class="action">' + esc(card.action) + "</div>" +
      (flags ? '<ul class="flags">' + flags + "</ul>" : "") +
      (sev !== "UNKNOWN" ? '<div id="planWrap" class="plan-pending" role="status" aria-live="polite">Preparing the full management plan</div>' : "") +
      '<div class="hear">' +
        '<button class="btn btn--ghost" id="speak" type="button" title="Read the guidance aloud — spoken on this device, no cloud.">' + ICON.speaker + "Listen to this</button>" +
        '<span id="ttsStatus" class="status"></span>' +
      "</div>" +
      '<div id="audioWrap"></div>';
    $("speak").onclick = function () { speak(card.action); };
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
      parts.push(pgroup("Medicines", meds));
    }
    parts.push(listGroup("Supportive care", plan && plan.supportive, "item"));
    parts.push(listGroup("Home care", plan && plan.home_care, "advice"));
    parts.push(listGroup("Return immediately if", plan && plan.return_now, "sign"));
    if (plan && plan.follow_up) {
      var fuInner = '<div class="prow"><span class="ptext">' + esc(plan.follow_up.when) + "</span>" + citeMini(plan.follow_up.citation) + "</div>";
      if (plan.follow_up.detail) fuInner += '<div class="prow-detail">At the visit: ' + esc(plan.follow_up.detail) + "</div>";
      parts.push(pgroup("Follow-up", fuInner));
    }
    if (plan && plan.referral) parts.push(pgroup("Referral", prow(plan.referral.criterion, plan.referral.citation)));
    parts = parts.filter(Boolean);
    if (!parts.length) { wrap.innerHTML = ""; wrap.className = ""; return; }
    wrap.className = "";
    wrap.innerHTML =
      '<div class="plan">' +
        '<div class="plan-head">' + ICON.guide + "Management plan</div>" +
        parts.join("") +
        '<div class="plan-foot">Every line is taken verbatim from the WHO guidelines on this device. Doses are the WHO weight-band amounts; confirm the child’s weight.</div>' +
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
  function renderStage(d) {
    var box = $("plSteps");
    if (!box || !d || !d.key) return;
    markActiveDone();
    var li = document.createElement("li");
    li.className = "pl-step is-active";
    li.setAttribute("data-key", String(d.key));
    li.innerHTML =
      '<span class="pl-ic" aria-hidden="true"></span>' +
      '<span class="pl-label">' + esc(d.label || d.key) + "</span>" +
      (d.detail ? '<span class="pl-detail">' + esc(d.detail) + "</span>" : "");
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
      renderStage(d);
    } else if (ev === "citation") {
      renderCitation(d);
      $("reasonLabel").textContent = "Reading the matched guideline";
    } else if (ev === "first_token") {
      $("hTtft").textContent = (d.ttftMs / 1000).toFixed(1) + " s";
      // H-1 staged status: the model has started producing its assessment.
      $("reasonLabel").textContent = "Reasoning through the protocol";
    } else if (ev === "reasoning") {
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
    } else if (ev === "abstain") {
      gotTerminal = true;
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
    $("reasonLabel").textContent = "Searching the guidelines";
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

  // ---- listen -> /tts ----
  var lastTtsUrl = null;
  var ttsBusy = false;
  async function speak(text) {
    // M-6: debounce. The @qvac engine is single-job — a second /tts fired while the first is in flight makes
    // the engine throw "Stale job replaced by new run". Ignore re-entrant clicks and disable the button until
    // this read finishes, so a fast double-tap can never break the current speech.
    if (ttsBusy) return;
    ttsBusy = true;
    var btn = $("speak");
    if (btn) btn.disabled = true;
    var st = $("ttsStatus");
    st.textContent = "Reading it aloud";
    try {
      var r = await fetch("/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text })
      });
      if (!r.ok) { st.textContent = "Could not read that aloud."; return; }
      var blob = await r.blob();
      // Free the previous object URL before making a new one, so repeated listens do not leak.
      if (lastTtsUrl) { URL.revokeObjectURL(lastTtsUrl); lastTtsUrl = null; }
      var url = URL.createObjectURL(blob);
      lastTtsUrl = url;
      $("audioWrap").innerHTML = "";
      var audio = document.createElement("audio");
      audio.controls = true;
      audio.autoplay = true;
      audio.src = url;
      audio.onerror = function () { st.textContent = "Could not play that audio."; };
      $("audioWrap").appendChild(audio);
      var perf = r.headers.get("X-Perf");
      st.textContent = perf
        ? ("spoken in " + (JSON.parse(perf).durationMs / 1000).toFixed(1) + " s · on this device")
        : "read aloud on this device";
    } catch (e) {
      st.textContent = "Could not read that aloud.";
    } finally {
      ttsBusy = false;
      if (btn) btn.disabled = false;
    }
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
