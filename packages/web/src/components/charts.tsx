/** Dependency-free SVG charts for the admin console. */

export function Sparkline({ points, height = 148, label }: { points: number[]; height?: number; label?: string }): JSX.Element {
  const width = 560;
  const max = Math.max(1, ...points);
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const coords = points.map((value, index) => [index * step, height - 18 - (value / max) * (height - 34)] as const);
  const line = coords.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = coords.length ? `${line} L${coords[coords.length - 1]![0].toFixed(1)},${height - 14} L0,${height - 14} Z` : '';

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label ?? 'trend chart'}>
      <defs>
        <linearGradient id="chartFade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(36,215,255,0.42)" />
          <stop offset="1" stopColor="rgba(36,215,255,0)" />
        </linearGradient>
      </defs>
      <line className="axis" x1="0" y1={height - 14} x2={width} y2={height - 14} />
      <line className="axis" x1="0" y1={(height - 14) / 2} x2={width} y2={(height - 14) / 2} />
      {area ? <path className="area" d={area} /> : null}
      {line ? <path className="line" d={line} /> : null}
      {coords.map(([x, y], index) => (
        <circle className="dot" key={index} cx={x} cy={y} r={index === coords.length - 1 ? 3.4 : 1.8} />
      ))}
    </svg>
  );
}

export function BarList({
  items,
  tone = 'cyan',
  format,
}: {
  items: { name: string; value: number }[];
  tone?: 'cyan' | 'gold' | 'violet';
  format?: (value: number) => string;
}): JSX.Element {
  const max = Math.max(1, ...items.map((item) => item.value));
  if (!items.length) return <p className="tiny dim">No data yet.</p>;
  return (
    <div className="bars">
      {items.map((item) => (
        <div className="bar-row" key={item.name}>
          <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.name}
          </span>
          <span className="track">
            <span className={`fill ${tone === 'gold' ? 'gold' : tone === 'violet' ? 'violet' : ''}`} style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }} />
          </span>
          <span className="num" style={{ textAlign: 'right' }}>
            {format ? format(item.value) : item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function HourHistogram({ values }: { values: { hour: number; shots: number }[] }): JSX.Element {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, shots: values.find((v) => v.hour === hour)?.shots ?? 0 }));
  const max = Math.max(1, ...buckets.map((bucket) => bucket.shots));
  return (
    <div className="histogram" role="img" aria-label="Shots per hour">
      {buckets.map((bucket) => (
        <div
          className="histogram-col"
          key={bucket.hour}
          title={`${String(bucket.hour).padStart(2, '0')}:00 — ${bucket.shots} shots`}
        >
          <span style={{ height: `${Math.max(2, (bucket.shots / max) * 100)}%` }} />
          <i>{bucket.hour % 6 === 0 ? bucket.hour : ''}</i>
        </div>
      ))}
    </div>
  );
}
