import { useEffect, useRef, useState } from "react";

const isBrowser = typeof window !== "undefined";

// Body scroll lock that survives iOS Safari rubber-banding. Records current
// scroll, pins body via position:fixed, restores on release.
function lockBodyScroll() {
  if (!isBrowser) return;
  const body = document.body;
  if (body.dataset.scrollLocked === "1") return;
  const scrollY = window.scrollY;
  body.style.position = "fixed";
  body.style.top = `-${scrollY}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";
  body.dataset.scrollLocked = "1";
  body.dataset.scrollY = String(scrollY);
}
function unlockBodyScroll() {
  if (!isBrowser) return;
  const body = document.body;
  if (body.dataset.scrollLocked !== "1") return;
  const y = Number(body.dataset.scrollY || "0");
  body.style.position = "";
  body.style.top = "";
  body.style.left = "";
  body.style.right = "";
  body.style.width = "";
  delete body.dataset.scrollLocked;
  delete body.dataset.scrollY;
  window.scrollTo(0, y);
}

// Drawer state with browser history integration (Android back closes drawer),
// Esc-to-close, scroll lock, and focus return.
export function useDrawer({ pathname, triggerRef } = {}) {
  const [isOpen, setIsOpen] = useState(false);
  const wasOpenRef = useRef(false);

  // Esc to close
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // popstate (system back) closes if our history entry is gone
  useEffect(() => {
    const onPop = () => {
      const state = window.history.state;
      if (!state || state.drawer !== "open") {
        if (wasOpenRef.current) {
          setIsOpen(false);
          wasOpenRef.current = false;
          unlockBodyScroll();
        }
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Lock scroll while open, restore focus on close
  useEffect(() => {
    if (isOpen) {
      lockBodyScroll();
      wasOpenRef.current = true;
    } else {
      unlockBodyScroll();
      if (wasOpenRef.current && triggerRef && triggerRef.current) {
        triggerRef.current.focus();
      }
      wasOpenRef.current = false;
    }
    return () => {
      // unmount safety
      if (isOpen) unlockBodyScroll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Auto-close on route change without polluting history
  useEffect(() => {
    if (isOpen) {
      setIsOpen(false);
      if (window.history.state && window.history.state.drawer === "open") {
        // remove our drawer history entry quietly
        window.history.back();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  function open() {
    if (isOpen) return;
    try {
      window.history.pushState({ drawer: "open" }, "");
    } catch {
      // history API can throw in odd embeddings; non-fatal
    }
    setIsOpen(true);
  }
  function close() {
    if (!isOpen) return;
    if (window.history.state && window.history.state.drawer === "open") {
      window.history.back();
    } else {
      setIsOpen(false);
    }
  }
  function toggle() {
    isOpen ? close() : open();
  }

  return { isOpen, open, close, toggle };
}
