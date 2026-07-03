// OS notifications (Electron routes these to Windows toasts). Only fired when
// the window isn't focused — in-app toasts cover the focused case.
export function osNotify(title: string, body: string) {
  try {
    if (typeof Notification === "undefined") return;
    if (document.hasFocus()) return;
    if (Notification.permission === "granted") {
      new Notification(title, { body: body.slice(0, 180), silent: false });
    } else if (Notification.permission !== "denied") {
      void Notification.requestPermission().then((p) => {
        if (p === "granted") new Notification(title, { body: body.slice(0, 180) });
      });
    }
  } catch {
    /* notifications unavailable — nothing to do */
  }
}
