// Inline-SVG cost chart — Phase 4 server component. No chart library
// (~80 LOC budget). Receives daily aggregates for the last 30 days.

export interface DailyCost {
  date: string;       // 'YYYY-MM-DD'
  cost_usd: number;   // sum for that day
}

interface Props {
  data: DailyCost[];
  width?: number;
  height?: number;
}

export default function CostChart({ data, width = 600, height = 160 }: Props): React.ReactElement {
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm opacity-50 border border-dashed border-white/20 rounded"
        style={{ width, height }}
      >
        No runs yet — once you upload a run, cost will chart here.
      </div>
    );
  }

  const padding = 24;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const max = Math.max(...data.map((d) => d.cost_usd), 0.01);
  const points = data.map((d, i) => {
    const x = padding + (i / Math.max(data.length - 1, 1)) * innerW;
    const y = padding + innerH - (d.cost_usd / max) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const pathD = points.length === 1
    ? `M ${points[0]} L ${points[0]}`
    : `M ${points.join(' L ')}`;

  return (
    <svg
      role="img"
      aria-label={`Cost chart, ${data.length} days, max $${max.toFixed(4)}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="border border-white/10 rounded bg-black/20"
    >
      {/* Y-axis label */}
      <text x={4} y={padding} className="text-xs" fill="currentColor" opacity="0.5">
        ${max.toFixed(2)}
      </text>
      <text x={4} y={height - 4} className="text-xs" fill="currentColor" opacity="0.5">
        $0
      </text>
      {/* Path */}
      <path
        d={pathD}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        opacity={0.8}
      />
      {/* Data points */}
      {data.map((d, i) => {
        const x = padding + (i / Math.max(data.length - 1, 1)) * innerW;
        const y = padding + innerH - (d.cost_usd / max) * innerH;
        return (
          <circle
            key={d.date}
            cx={x}
            cy={y}
            r={2.5}
            fill="currentColor"
            opacity={0.9}
            data-testid="cost-chart-point"
          >
            <title>
              {d.date}: ${d.cost_usd.toFixed(4)}
            </title>
          </circle>
        );
      })}
    </svg>
  );
}
