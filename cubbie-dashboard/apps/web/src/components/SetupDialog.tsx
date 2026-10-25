import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function SetupDialog({ children, onClose, onDelete }: { children: ReactNode; onClose: () => void; onDelete?: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.body.style.overflow;
    const opener = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => { dialog.close(); document.body.style.overflow = previous; opener?.focus(); };
  }, []);
  return createPortal(<dialog ref={ref} className="setup-dialog" aria-label="Connect your project" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="setup-dialog-tools"><button type="button" onClick={onClose}>← Go back</button><div><button type="button" className="danger" disabled={!onDelete} title={onDelete ? 'Disconnect without deleting project history' : 'No connection to delete'} onClick={onDelete}>Delete connection</button><button type="button" onClick={onClose} aria-label="Close setup">✕</button></div></div>
    {children}
  </dialog>, document.body);
}
