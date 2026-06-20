// net.js - the offline badge, shared by every page.
// navigator.onLine is a client-side check with zero server egress. The product works either way;
// the badge just tells the worker whether a network happens to be reachable.
(function () {
  function paintNet() {
    var el = document.getElementById("net");
    if (!el) return;
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
