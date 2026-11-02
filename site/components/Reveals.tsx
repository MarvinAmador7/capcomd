"use client";

// Scroll entrances, once per element: [data-reveal] elements rise in as they enter (CSS does the motion, and only
// under prefers-reduced-motion: no-preference; phones skip it). Content is visible without this script.
import { useEffect } from "react";

export function Reveals() {
  useEffect(() => {
    // Entrances are styled only from here on, so content never waits for this script.
    document.documentElement.classList.add("reveal");
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.05 });
    document.querySelectorAll("[data-reveal]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return null;
}
