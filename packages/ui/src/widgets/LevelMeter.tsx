/** Medidor de nivel vertical (peak lineal 0..1+, ámbar cerca de 0 dB). */

import './widgets.css';

export function LevelMeter({ peak, height = 160 }: { peak: number; height?: number }) {
  const pct = Math.min(1, peak) * 100;
  const hot = peak > 0.89; // ≈ -1 dB
  const clip = peak >= 0.999;
  return (
    <div className="meter" style={{ height }}>
      <div
        className={`meter-fill${hot ? ' hot' : ''}${clip ? ' clip' : ''}`}
        style={{ height: `${pct}%` }}
      />
    </div>
  );
}
