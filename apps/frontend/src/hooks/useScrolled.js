import { useEffect, useRef, useState } from "react";

// Toggle .is-scrolled on a sentinel intersection so the top bar can show a
// hairline + slight blur lift only when content is underneath.
export function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  const sentinelRef = useRef(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    const io = new IntersectionObserver(
      ([entry]) => setScrolled(!entry.isIntersecting),
      { threshold: 0 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { scrolled, sentinelRef };
}
