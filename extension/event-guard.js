/**
 * Blocks page-script-generated DOM events from driving companion-owned controls.
 *
 * Chrome content scripts run in an isolated JavaScript world, but both worlds still share
 * the page DOM. ChatGPT page JavaScript can therefore find a `.clf-*` element and dispatch
 * click/input/keyboard events at it. Those events are not user gestures (`isTrusted === false`).
 * Capture them before they reach content.js's control handlers so page code can observe or
 * rearrange its own DOM without gaining the ability to toggle local settings, start/cancel
 * compaction, or save a Goal objective.
 *
 * A real user event remains untouched. This is deliberately a separate content script loaded
 * before content.js: the security invariant is centralised and cannot be accidentally omitted
 * from one newly-added privileged button handler.
 */
(() => {
  const CONTROL_EVENTS = ['click', 'dblclick', 'keydown', 'keyup', 'input', 'change', 'submit'];

  const companionOwnedPath = (event) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    return path.some((node) => {
      const classes = node && node.nodeType === 1 ? node.classList : null;
      if (!classes) return false;
      for (const name of classes) {
        if (name.startsWith('clf-')) return true;
      }
      return false;
    });
  };

  const guard = (event) => {
    if (event.isTrusted || !companionOwnedPath(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  for (const type of CONTROL_EVENTS) document.addEventListener(type, guard, true);
})();
