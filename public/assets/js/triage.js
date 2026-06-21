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
    stop: '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
  };

  var SEEDS = [
    { label: "Child, cough and fast breathing", text: "2-year-old, cough for 3 days, chest indrawing, breathing 52 a minute, alert and drinking, no danger signs." },
    { label: "Child, very unwell", text: "11-month-old, cough, now lethargic and unable to drink, breathing 60 a minute with chest indrawing and stridor while calm." },
    { label: "Adult, low mood", text: "Adult with low mood, loss of interest, poor sleep and appetite for the past three weeks." }
  ];

  var SEV_NOTE = {
    EMERGENCY: "Refer now",
    URGENT: "Treat now and follow up",
    ROUTINE: "Home care",
    SELF_CARE: "Self-care advice",
    UNKNOWN: "No matching guideline"
  };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---- example chips ----
  var seedsEl = $("seeds");
  if (seedsEl) {
    SEEDS.forEach(function (s) {
      var b = document.createElement("button");
      b.className = "chip";
      b.type = "button";
      b.textContent = s.label;
      b.onclick = function () { $("case").value = s.text; $("case").focus(); };
      seedsEl.appendChild(b);
    });
  }

  // ---- guidelines loaded count (for the live readout) ----
  fetch("/health").then(function (r) { return r.json(); }).then(function (h) {
    if ($("hChunks")) $("hChunks").textContent = h.chunks != null ? h.chunks : "·";
  }).catch(function () {});

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
        var blob = new Blob(chunks, { type: mediaRec.mimeType || "audio/webm" });
        var fd = new FormData();
        fd.append("audio", blob, "case.webm");
        try {
          var r = await fetch("/transcribe", { method: "POST", body: fd });
          if (!r.ok) {
            var emsg = "That recording was too long. Try a shorter case.";
            try { var ej = await r.json(); if (ej && ej.error) emsg = ej.error; } catch (e2) {}
            $("status").textContent = emsg;
            return;
          }
          var j = await r.json();
          if (j.text) $("case").value = j.text.trim();
          $("status").textContent = j.perf ? ("heard in " + (j.perf.durationMs / 1000).toFixed(1) + " s") : "";
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
    $("citationBox").classList.remove("hidden");
    $("citationBox").innerHTML =
      '<div class="cite">' +
        '<span class="from">' + ICON.guide + 'From the WHO guide</span>' +
        '<span class="q">"' + esc(c.section) + '"</span>' +
        '<span class="src">' + esc(c.doc) + ", page " + esc(String(c.page)) + ". Found in the guidelines on this device.</span>" +
      "</div>";
  }

  function renderCard(card) {
    $("reasoningWrap").classList.add("hidden");
    $("card").classList.remove("hidden");
    var sev = card.severity;
    var ico = (sev === "ROUTINE" || sev === "SELF_CARE") ? ICON.check : ICON.alert;
    var flags = (card.red_flags || []).map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("");
    $("card").innerHTML =
      '<div class="verdict">' +
        '<div class="sev ' + sev + '">' + ico + sev + "</div>" +
        '<div class="sev-note">' + (SEV_NOTE[sev] || "") + "</div>" +
      "</div>" +
      '<div class="action">' + esc(card.action) + "</div>" +
      (card.reasoning ? '<div class="why">' + esc(card.reasoning) + "</div>" : "") +
      (flags ? '<ul class="flags">' + flags + "</ul>" : "") +
      (sev !== "UNKNOWN" ? '<div id="planWrap" class="plan-pending" role="status" aria-live="polite">Preparing the full management plan</div>' : "") +
      '<div class="hear">' +
        '<button class="btn btn--ghost" id="speak" type="button">' + ICON.speaker + "Listen to this</button>" +
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
  function renderPlan(plan) {
    var wrap = $("planWrap");
    if (!wrap) return;
    var parts = [];
    if (plan && plan.medicines && plan.medicines.length) {
      var meds = plan.medicines.map(function (m) {
        var sub = [];
        if (m.dose) sub.push("Dose: " + esc(m.dose));
        var fd = [m.frequency, m.duration].filter(Boolean).map(esc).join(", ");
        if (fd) sub.push(fd);
        return '<div class="med"><div class="med-top"><span class="med-name">' + esc(m.name) + "</span>" + citeMini(m.citation) + "</div>" +
          (sub.length ? '<div class="med-sub">' + sub.join(" &middot; ") + "</div>" : "") + "</div>";
      }).join("");
      parts.push(pgroup("Medicines", meds));
    }
    parts.push(listGroup("Supportive care", plan && plan.supportive, "item"));
    parts.push(listGroup("Home care", plan && plan.home_care, "advice"));
    parts.push(listGroup("Return immediately if", plan && plan.return_now, "sign"));
    if (plan && plan.follow_up) parts.push(pgroup("Follow-up", prow(plan.follow_up.when, plan.follow_up.citation)));
    if (plan && plan.referral) parts.push(pgroup("Referral", prow(plan.referral.criterion, plan.referral.citation)));
    parts = parts.filter(Boolean);
    if (!parts.length) { wrap.innerHTML = ""; wrap.className = ""; return; }
    wrap.className = "";
    wrap.innerHTML =
      '<div class="plan">' +
        '<div class="plan-head">' + ICON.guide + "Management plan</div>" +
        parts.join("") +
        '<div class="plan-foot">Every line is taken from the WHO guidelines on this device. Dosing follows the weight-band chart, not a fixed amount.</div>' +
      "</div>";
  }

  function handleEvent(block) {
    // SSE comment frames (keep-alives) start with ":". Ignore them, they carry no event.
    if (block.charAt(0) === ":") return;
    var ev = (block.match(/^event: (.*)$/m) || [])[1];
    var dataLine = (block.match(/^data: (.*)$/m) || [])[1];
    if (!ev || !dataLine) return;
    var d;
    // A malformed frame must be skipped, not kill the whole stream.
    try { d = JSON.parse(dataLine); } catch (e) { return; }
    if (ev === "citation") {
      renderCitation(d);
      $("reasonLabel").textContent = "Reading the matched guideline";
    } else if (ev === "first_token") {
      $("hTtft").textContent = (d.ttftMs / 1000).toFixed(1) + " s";
    } else if (ev === "reasoning") {
      var r = $("reasoning");
      // Only autoscroll if the worker is already near the bottom, so reading back does not get yanked.
      var atBottom = r.scrollHeight - r.scrollTop - r.clientHeight < 40;
      r.textContent += d.delta.replace(/<\/?think>/g, "");
      if (atBottom) r.scrollTop = r.scrollHeight;
    } else if (ev === "card") {
      gotTerminal = true;
      renderCard(d.card);
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

  // ---- assess -> /triage (SSE) ----
  async function runAssess() {
    var caseText = $("case").value.trim();
    if (!caseText) { $("status").textContent = "Describe or record a case first."; $("case").focus(); return; }
    gotTerminal = false;
    $("assess").disabled = true;
    var assessLabel = $("assess").innerHTML;
    $("assess").textContent = "Working...";
    $("status").textContent = "";
    $("result").classList.remove("hidden");
    $("result").setAttribute("aria-busy", "true");
    $("citationBox").classList.add("hidden");
    $("card").classList.add("hidden");
    $("err").textContent = "";
    $("reasoningWrap").classList.remove("hidden");
    $("reasoning").textContent = "";
    $("reasonLabel").textContent = "Searching the guidelines";
    $("hTtft").textContent = "·"; $("hTps").textContent = "·"; $("hDev").textContent = "·";
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
    var buf = "";
    try {
      var r = await fetch("/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseText: caseText })
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
      $("err").textContent = "Could not get guidance. " + e.message;
      $("reasoningWrap").classList.add("hidden");
    } finally {
      // Re-enable in finally so a mid-stream interruption never leaves the button dead.
      $("assess").disabled = false;
      $("assess").innerHTML = assessLabel;
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
  async function speak(text) {
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
      st.textContent = perf ? ("spoken in " + (JSON.parse(perf).durationMs / 1000).toFixed(1) + " s") : "";
    } catch (e) {
      st.textContent = "Could not read that aloud.";
    }
  }
})();
