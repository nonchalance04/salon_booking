import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function ServiceCategoryPicker({ categories, active, onSelect }: {
  categories: string[]; active: string; onSelect: (category: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(0);
  const categoryKey = JSON.stringify(categories);
  useLayoutEffect(() => {
    const tabs = tabsRef.current;
    if (!tabs) return;
    const pills = Array.from(tabs.querySelectorAll<HTMLButtonElement>("button"));
    function measure() {
      const available = tabs!.clientWidth;
      const gap = Number.parseFloat(getComputedStyle(tabs!).columnGap) || 0;
      let used = 0;
      let count = 0;
      for (const pill of pills) {
        const next = used + (count ? gap : 0) + pill.getBoundingClientRect().width;
        if (next > available) break;
        used = next;
        count++;
      }
      setVisibleCount(count);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(tabs);
    pills.forEach(pill => observer.observe(pill));
    return () => observer.disconnect();
  }, [categoryKey]);
  useEffect(() => {
    if (!open) return;
    activeRef.current?.focus();
    function dismiss(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return <nav className="service-categories" aria-label="Service categories">
    <div className="service-category-tabs" ref={tabsRef}>{categories.map((category, index) => <button
      key={category} type="button" className={`service-category-pill ${category === active ? "active" : ""} ${index >= visibleCount ? "overflowed" : ""}`}
      aria-hidden={index >= visibleCount || undefined} tabIndex={index >= visibleCount ? -1 : undefined}
      aria-pressed={category === active} onClick={() => onSelect(category)}
    >{category}</button>)}</div>
    <div className="service-category-menu" ref={menuRef} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }} onKeyDown={event => {
      if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
    }}>
      <button ref={triggerRef} type="button" className="service-category-toggle" aria-label="All service categories"
        aria-expanded={open} aria-controls="service-category-options" onClick={() => setOpen(value => !value)}>
        <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M9 5h12M9 12h12M9 19h12" /><circle cx="3" cy="5" r="1" /><circle cx="3" cy="12" r="1" /><circle cx="3" cy="19" r="1" />
        </svg>
      </button>
      {open && <div id="service-category-options" className="service-category-popover" role="group" aria-label="All service categories">
        {categories.map(category => <button key={category} type="button" ref={category === active ? activeRef : undefined}
          aria-pressed={category === active} className={category === active ? "active" : ""}
          onClick={() => { onSelect(category); setOpen(false); triggerRef.current?.focus(); }}>{category}</button>)}
      </div>}
    </div>
  </nav>;
}
