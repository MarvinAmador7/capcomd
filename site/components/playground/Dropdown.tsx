"use client";

// A compact property dropdown in the style of a design tool's inspector: a small label, a trigger with the current
// value's icon and a chevron, and a listbox menu (WAI-ARIA APG select-only combobox pattern, simplified to a button
// plus listbox): arrow keys, Home / End, type-ahead, Enter / Space to pick, Escape or Tab to close, focus back on the
// trigger. Icons are decorative; the option names carry the meaning.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

export interface Option<T extends string> { value: T; label: string; icon: string }

export function Dropdown<T extends string>({ label, value, options, onChange, align = "left", placeholder }: {
  label: string; value: T | null; options: Option<T>[]; onChange: (v: T) => void; align?: "left" | "right"; placeholder?: { label: string; icon: string };
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const current = options.find((o) => o.value === value);
  const shown = current ?? placeholder ?? options[0]!;

  const openAt = (i: number) => { setActive(Math.max(0, i)); setOpen(true); };
  const close = (focus = true) => { setOpen(false); if (focus) btn.current?.focus(); };
  const pick = (i: number) => { onChange(options[i]!.value); close(); };
  useEffect(() => { if (open) list.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !btn.current?.contains(t)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); openAt(e.key === "ArrowUp" ? Math.max(0, selectedIndex - 1) : selectedIndex); }
  };
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const last = options.length - 1;
    const go = (i: number) => { e.preventDefault(); setActive(Math.min(last, Math.max(0, i))); };
    if (e.key === "ArrowDown") go(active + 1);
    else if (e.key === "ArrowUp") go(active - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(last);
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(active); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") close(false);
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const now = Date.now(), t = typed.current;
      t.text = now - t.at < 600 ? t.text + e.key.toLowerCase() : e.key.toLowerCase(); t.at = now;
      const i = options.findIndex((o) => o.label.toLowerCase().startsWith(t.text));
      if (i >= 0) go(i);
    }
  };

  return (
    <div className="dd">
      <span className="dd__label" id={`${id}-l`}>{label}</span>
      <button ref={btn} type="button" className="dd__btn" id={`${id}-b`} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-m`}
        aria-labelledby={`${id}-l ${id}-b`} onClick={() => (open ? close() : openAt(selectedIndex))} onKeyDown={onButtonKey}>
        <span className="dd__icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: shown.icon }} />
        <span className="dd__value">{current ? current.label : placeholder?.label ?? shown.label}</span>
        <svg className="dd__chev" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <ul ref={list} className={`dd__menu dd__menu--${align}`} id={`${id}-m`} role="listbox" aria-labelledby={`${id}-l`} tabIndex={-1} hidden={!open}
        aria-activedescendant={open ? `${id}-o${active}` : undefined} onKeyDown={onListKey}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget !== btn.current) close(false); }}>
        {options.map((o, i) => (
          <li key={o.value} id={`${id}-o${i}`} role="option" aria-selected={o.value === value} className={i === active ? "is-active" : undefined}
            onPointerMove={() => setActive(i)} onClick={() => pick(i)}>
            <span className="dd__icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: o.icon }} />
            <span className="dd__value">{o.label}</span>
            <svg className="dd__check" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.4 4.8 9 10 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </li>
        ))}
      </ul>
    </div>
  );
}
