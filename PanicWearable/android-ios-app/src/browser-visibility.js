export const BROWSER_PAUSE_DELAY_MS = 1_500;

// iOS browser device sheets can briefly hide the page. Stop local recording
// immediately, but preserve the physical connection during a short sheet change.
export function watchBrowserVisibility(document, { onHidden, onVisible, onPause }, {
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (timer) => clearTimeout(timer),
} = {}) {
  let pending = null;
  const changed = () => {
    if (pending !== null) cancel(pending);
    pending = null;
    if (document.hidden) {
      onHidden();
      pending = schedule(() => {
        pending = null;
        if (document.hidden) onPause();
      }, BROWSER_PAUSE_DELAY_MS);
    } else {
      onVisible();
    }
  };
  document.addEventListener('visibilitychange', changed);
  return () => {
    if (pending !== null) cancel(pending);
    document.removeEventListener('visibilitychange', changed);
  };
}
