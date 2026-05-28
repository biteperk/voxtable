// Service Worker registration + online/offline state hook.
//
// We register the SW eagerly so the next reload survives a WiFi drop. The
// app uses navigator.onLine for the UI banner; the SW handles the fetch
// fallback transparently.

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // Avoid registering during `vite dev` so HMR isn't intercepted.
  if (import.meta.env.DEV) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) => console.error("SW register failed", err));
  });
}

export function subscribeOnlineStatus(callback) {
  const update = () => callback(navigator.onLine);
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
  return () => {
    window.removeEventListener("online", update);
    window.removeEventListener("offline", update);
  };
}
