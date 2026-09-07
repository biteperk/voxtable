import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { Icon } from "../Icon";

/**
 * Success and failure must not look identical. The admin rendered both through
 * `className="menu-error admin-notice"`, so "Bindings saved." and "That didn't
 * work" arrived in the same red-bordered box.
 *
 * `action` exists for the Undo on destructive operations: a toast that can put
 * something back is the difference between a scary button and a safe one.
 */
const ToastContext = createContext(null);

let nextId = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    ({ tone = "ok", message, action, timeout = tone === "danger" ? 8000 : 4000 }) => {
      const id = (nextId += 1);
      setToasts((list) => [...list, { id, tone, message, action }]);
      // An action needs time to be used, so an Undo toast lingers.
      const ms = action ? Math.max(timeout, 30000) : timeout;
      if (ms > 0) setTimeout(() => dismiss(id), ms);
      return id;
    },
    [dismiss]
  );

  const value = useMemo(
    () => ({
      push,
      dismiss,
      success: (message, opts) => push({ tone: "ok", message, ...opts }),
      error: (message, opts) => push({ tone: "danger", message, ...opts })
    }),
    [push, dismiss]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.length > 0 ? (
        <div className="adm-toasts" role="region" aria-label="Notifications">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`adm-toast is-${t.tone}`}
              role={t.tone === "danger" ? "alert" : "status"}
            >
              <Icon name={t.tone === "danger" ? "error" : "check_circle"} />
              <span className="adm-toast-body">{t.message}</span>
              {t.action ? (
                <button
                  type="button"
                  className="ghost-button adm-toast-action"
                  onClick={() => {
                    dismiss(t.id);
                    t.action.onAct();
                  }}
                >
                  {t.action.label}
                </button>
              ) : null}
              <button type="button" className="adm-table-sort" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

/** Returns a no-op shim outside a provider so a panel can never crash on it. */
export function useToast() {
  return (
    useContext(ToastContext) ?? {
      push: () => {},
      dismiss: () => {},
      success: () => {},
      error: () => {}
    }
  );
}
