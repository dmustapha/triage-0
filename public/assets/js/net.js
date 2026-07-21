// net.js - the offline badge, shared by every page.
// navigator.onLine is a client-side check with zero server egress. The product works either way;
// the badge just tells the worker whether a network happens to be reachable.
(function () {
  function paintNet() {
    var el = document.getElementById("net");
    if (!el) return;
    // The app page owns this badge with the SERVER's egress-guard truth (armed/strict/violations from
    // /health) — a stronger, honest signal than client reachability. When it has claimed the badge
    // (data-egress="1"), leave it alone so a stray online/offline event can't repaint over the proof.
    if (el.dataset.egress === "1") return;
    var off = !navigator.onLine;
    var txt = el.querySelector(".badge-txt") || el; // update the label, keep the pip dot
    txt.textContent = off ? "Offline" : "Online";
    el.classList.toggle("is-offline", off);
    el.classList.toggle("is-online", !off);
  }
  window.addEventListener("online", paintNet);
  window.addEventListener("offline", paintNet);
  paintNet();
})();
