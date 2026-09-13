'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/** The outcome of the last action, set as a short-lived cookie by the server action. */
export function Flash({ id, message }: { id?: string; message?: string }) {
  const [shown, setShown] = useState(message);
  const path = usePathname();
  const lastPath = useRef(path);

  useEffect(() => {
    setShown(message);
    if (message) document.cookie = 'pps_flash=; Max-Age=0; path=/';
  }, [id, message]);

  useEffect(() => {
    if (path !== lastPath.current) {
      lastPath.current = path;
      setShown(undefined);
    }
  }, [path]);

  if (!shown) return null;
  return (
    <div role="status" className="flash">
      <span>{shown}</span>
      <button type="button" className="flash-close" aria-label="Dismiss" onClick={() => setShown(undefined)}>
        {'×'}
      </button>
    </div>
  );
}
