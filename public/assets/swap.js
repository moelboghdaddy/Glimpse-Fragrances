/* Glimpse — hover / press-and-hold image reveal.
   Desktop: hovering the product reveals the "with notes" image (pure CSS, see .swap-img-wrap rules).
   Touch: the reveal only happens if the finger is held down (a long press), so a quick tap
   still behaves like a normal tap (e.g. following the product link). */
(function () {
  var LONG_PRESS_MS = 450;
  var pressTimer = null;
  var suppressClickTarget = null; // the link/element whose next click should be swallowed

  function activate(wrap) { wrap.classList.add('is-active'); }
  function deactivate(wrap) { wrap.classList.remove('is-active'); }

  document.addEventListener('touchstart', function (e) {
    var wrap = e.target.closest('.swap-img-wrap');
    if (!wrap) return;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(function () {
      activate(wrap);
      suppressClickTarget = wrap.closest('a') || wrap;
    }, LONG_PRESS_MS);
  }, { passive: true });

  function endPress(e) {
    var wrap = e.target.closest('.swap-img-wrap');
    clearTimeout(pressTimer);
    if (wrap) {
      // brief pause before hiding so the reveal doesn't vanish the instant the finger lifts
      setTimeout(function () { deactivate(wrap); }, 250);
    }
  }
  document.addEventListener('touchend', endPress, { passive: true });
  document.addEventListener('touchcancel', endPress, { passive: true });
  document.addEventListener('touchmove', function () {
    // a moving finger means scrolling, not holding — cancel the pending long-press
    clearTimeout(pressTimer);
  }, { passive: true });

  // If the press turned into a long-press reveal, swallow the tap-through click
  // that mobile browsers fire afterwards, so the link isn't followed by accident.
  document.addEventListener('click', function (e) {
    if (suppressClickTarget && (suppressClickTarget === e.target || suppressClickTarget.contains(e.target))) {
      e.preventDefault();
      suppressClickTarget = null;
    }
  }, true);
})();
