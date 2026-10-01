import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './help-hint.css';

let closeActiveHint: (() => void) | undefined;

/** A brief, non-interactive explanation beside its control, including inside dialogs. */
export function HelpHint({ label, children, id: suppliedId }: { label: string; children: ReactNode; id?: string }) {
  const generatedId = useId(), id = suppliedId ?? `help-${generatedId}`;
  const trigger = useRef<HTMLButtonElement>(null), content = useRef<HTMLSpanElement>(null);
  const hovered = useRef(false), focused = useRef(false), pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const cancelClose = () => { clearTimeout(closeTimer.current); };
  const dismiss = () => { cancelClose(); pinned.current = false; setOpen(false); };
  const enter = () => { cancelClose(); hovered.current = true; setOpen(true); };
  const leave = () => {
    hovered.current = false;
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!hovered.current && !focused.current && !pinned.current) setOpen(false);
    }, 120);
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current || !content.current) return;
    const popup = content.current;
    // Native top-layer placement avoids clipping and the inert background of modal dialogs.
    popup.showPopover();
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      if (anchor.bottom < 0 || anchor.top > window.innerHeight) { setOpen(false); return; }
      const bounds = popup.getBoundingClientRect(), margin = 8;
      const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - bounds.width - margin));
      const below = anchor.bottom + margin;
      const top = below + bounds.height <= window.innerHeight - margin ? below : Math.max(margin, anchor.top - bounds.height - margin);
      setPosition({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      if (popup.matches(':popover-open')) popup.hidePopover();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    closeActiveHint?.();
    closeActiveHint = dismiss;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); dismiss();
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !content.current?.contains(event.target)) dismiss();
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('pointerdown', outside, true);
    return () => {
      if (closeActiveHint === dismiss) closeActiveHint = undefined;
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [open]);
  useEffect(() => () => { clearTimeout(closeTimer.current); }, []);

  return <span className="help-hint">
    <button ref={trigger} type="button" className="help-hint-button" aria-label={label} aria-describedby={id} aria-expanded={open}
      onPointerEnter={event => { if (event.pointerType !== 'touch') enter(); }} onPointerLeave={leave}
      onFocus={() => { cancelClose(); focused.current = true; setOpen(true); }}
      onBlur={() => { focused.current = false; if (!hovered.current && !pinned.current) setOpen(false); }}
      onClick={() => { pinned.current = !pinned.current; cancelClose(); setOpen(pinned.current); }}>?</button>
    <span ref={content} id={id} className="help-hint-content" role="tooltip" popover="manual" style={position}
      onPointerEnter={enter} onPointerLeave={leave}>{children}</span>
  </span>;
}
