/** Medidor de nivel vertical: peak lineal 0..1+ y marcador de RMS opcional. */

import './widgets.css';

export function LevelMeter({
  peak,
  rms,
  height = 160,
}: {
  peak: number;
  /** RMS lineal; pinta una línea dentro del medidor. */
  rms?: number;
  height?: number;
}) {
  const pct = Math.min(1, peak) * 100;
  const hot = peak > 0.89; // ≈ -1 dB
  const clip = peak >= 0.999;
  return (
    <div className="meter" style={{ height }}>
      <div
        className={`meter-fill${hot ? ' hot' : ''}${clip ? ' clip' : ''}`}
        style={{ height: `${pct}%` }}
      />
      {rms !== undefined && rms > 0.001 && (
        <div className="meter-rms" style={{ bottom: `${Math.min(1, rms) * 100}%` }} />
      )}
    </div>
  );
}
