'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/** Re-fetches the server components every `seconds` while the tab is visible. The indicator reflects real state. */
export function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter(); const [paused, setPaused] = useState(false); const [at, setAt] = useState('');
  useEffect(() => {
    setAt(new Date().toISOString().slice(11, 19));
    const id = setInterval(() => { if (document.visibilityState === 'visible' && !paused) { router.refresh(); setAt(new Date().toISOString().slice(11, 19)); } }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds, paused]);
  return <button className="live" onClick={() => setPaused((p) => !p)} style={{ background: 'none', border: 0, cursor: 'pointer', font: 'inherit' }} title="Click to pause/resume">{paused ? <span>⏸ paused</span> : <><i /> live · {at} UTC</>}</button>;
}
