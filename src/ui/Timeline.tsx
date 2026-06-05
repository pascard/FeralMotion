import { useCallback, useRef } from 'react';

interface Props {
  duration: number;
  start: number;
  end: number;
  current: number;
  thumbs: string[];
  onTrim: (start: number, end: number) => void;
  onSeek: (t: number) => void;
}

const MIN_LEN = 0.5;

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t % 1) * 10);
  return `${m}:${s.toString().padStart(2, '0')}.${cs}`;
}

export function Timeline({ duration, start, end, current, thumbs, onTrim, onSeek }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<'start' | 'end' | 'scrub' | null>(null);

  const ratioFromClient = useCallback((clientX: number) => {
    const el = trackRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  const onDown = (which: 'start' | 'end' | 'scrub') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = which;
    handleMove(e.clientX);
  };

  const handleMove = (clientX: number) => {
    const t = ratioFromClient(clientX) * duration;
    if (drag.current === 'start') {
      onTrim(Math.min(t, end - MIN_LEN), end);
      onSeek(Math.min(t, end - MIN_LEN));
    } else if (drag.current === 'end') {
      onTrim(start, Math.max(t, start + MIN_LEN));
      onSeek(Math.max(t, start + MIN_LEN));
    } else if (drag.current === 'scrub') {
      onSeek(Math.min(end, Math.max(start, t)));
    }
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    e.preventDefault();
    handleMove(e.clientX);
  };
  const onUp = () => {
    drag.current = null;
  };

  const pct = (t: number) => `${(t / duration) * 100}%`;

  return (
    <div className="timeline">
      <div className="timeline-times">
        <span>{fmt(start)}</span>
        <span className="timeline-dur">{fmt(end - start)} sel.</span>
        <span>{fmt(end)}</span>
      </div>
      <div
        className="timeline-track"
        ref={trackRef}
        onPointerDown={onDown('scrub')}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <div className="timeline-thumbs">
          {thumbs.map((src, i) => (
            <div key={i} className="timeline-thumb" style={{ backgroundImage: `url(${src})` }} />
          ))}
        </div>
        {/* dim outside the selection */}
        <div className="timeline-dim" style={{ left: 0, width: pct(start) }} />
        <div className="timeline-dim" style={{ right: 0, width: pct(duration - end) }} />
        {/* selection frame */}
        <div
          className="timeline-selection"
          style={{ left: pct(start), width: pct(end - start) }}
        />
        {/* handles */}
        <div
          className="timeline-handle handle-start"
          style={{ left: pct(start) }}
          onPointerDown={onDown('start')}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <span />
        </div>
        <div
          className="timeline-handle handle-end"
          style={{ left: pct(end) }}
          onPointerDown={onDown('end')}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <span />
        </div>
        {/* playhead */}
        <div className="timeline-playhead" style={{ left: pct(current) }} />
      </div>
    </div>
  );
}
