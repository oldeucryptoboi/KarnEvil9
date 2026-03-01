"use client";

/**
 * Reusable pure CSS/SVG chart components for the live metrics panel.
 * No external chart libraries — all rendering is done with SVG and Tailwind CSS.
 */

/* ── Shared types ──────────────────────────────────────────────────── */

export interface DataPoint {
  label: string;
  value: number;
}

/* ── Empty state placeholder ───────────────────────────────────────── */

function EmptyState({ message }: { message?: string }) {
  return (
    <div className="flex items-center justify-center h-full min-h-[120px] text-sm text-[var(--muted)]">
      {message ?? "No data yet"}
    </div>
  );
}

/* ── SVG Vertical Bar Chart (histogram-style) ──────────────────────── */

export interface BarChartProps {
  data: DataPoint[];
  label: string;
  color?: string;
  maxHeight?: number;
  /** Show value on hover tooltip via SVG <title> */
  showTooltips?: boolean;
}

export function BarChart({
  data,
  label,
  color = "#3b82f6",
  maxHeight = 160,
  showTooltips = true,
}: BarChartProps) {
  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="text-sm font-semibold mb-3">{label}</h3>
        <EmptyState />
      </div>
    );
  }

  const maxValue = Math.max(...data.map((d) => d.value), 1);
  const padding = { top: 8, right: 8, bottom: 24, left: 8 };
  const chartWidth = Math.max(data.length * 14, 200);
  const chartHeight = maxHeight;
  const innerWidth = chartWidth - padding.left - padding.right;
  const innerHeight = chartHeight - padding.top - padding.bottom;
  const barWidth = Math.max(Math.min(innerWidth / data.length - 2, 20), 4);
  const gap = (innerWidth - barWidth * data.length) / Math.max(data.length - 1, 1);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <h3 className="text-sm font-semibold mb-3">{label}</h3>
      <div className="overflow-x-auto">
        <svg
          width={chartWidth}
          height={chartHeight}
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="block"
        >
          {/* Horizontal grid lines */}
          {[0.25, 0.5, 0.75, 1].map((frac) => {
            const y = padding.top + innerHeight * (1 - frac);
            return (
              <line
                key={frac}
                x1={padding.left}
                y1={y}
                x2={chartWidth - padding.right}
                y2={y}
                stroke="var(--border)"
                strokeWidth="0.5"
                strokeDasharray="4 4"
              />
            );
          })}

          {/* Bars */}
          {data.map((d, i) => {
            const barH = Math.max((d.value / maxValue) * innerHeight, 1);
            const x = padding.left + i * (barWidth + gap);
            const y = padding.top + innerHeight - barH;

            return (
              <g key={i}>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={barH}
                  rx={Math.min(barWidth / 4, 3)}
                  fill={color}
                  opacity={0.75}
                  className="transition-all duration-300"
                >
                  {showTooltips && (
                    <title>{`${d.label}: ${d.value.toFixed(d.value < 10 ? 1 : 0)}`}</title>
                  )}
                </rect>
              </g>
            );
          })}

          {/* Baseline */}
          <line
            x1={padding.left}
            y1={padding.top + innerHeight}
            x2={chartWidth - padding.right}
            y2={padding.top + innerHeight}
            stroke="var(--border)"
            strokeWidth="1"
          />
        </svg>
      </div>
    </div>
  );
}

/* ── Horizontal Bar Chart ──────────────────────────────────────────── */

export interface HBarChartProps {
  data: DataPoint[];
  label: string;
  colors?: string[];
  maxHeight?: number;
}

const DEFAULT_PALETTE = [
  "#3b82f6",
  "#8b5cf6",
  "#22c55e",
  "#f59e0b",
  "#ec4899",
  "#06b6d4",
  "#f97316",
  "#14b8a6",
];

export function HBarChart({
  data,
  label,
  colors = DEFAULT_PALETTE,
  maxHeight: _maxHeight,
}: HBarChartProps) {
  void _maxHeight; // reserved for future use

  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="text-sm font-semibold mb-3">{label}</h3>
        <EmptyState />
      </div>
    );
  }

  const maxValue = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <h3 className="text-sm font-semibold mb-3">{label}</h3>
      <div className="space-y-2">
        {data.map((d, i) => {
          const pct = Math.max((d.value / maxValue) * 100, 1);
          const barColor = colors[i % colors.length]!;

          return (
            <div key={d.label} className="flex items-center gap-3">
              <span className="text-xs text-[var(--muted)] font-mono w-28 truncate text-right shrink-0">
                {d.label}
              </span>
              <div className="flex-1 h-5 rounded bg-white/[0.04] overflow-hidden">
                <div
                  className="h-full rounded transition-all duration-500 ease-out"
                  style={{
                    width: `${pct}%`,
                    backgroundColor: barColor,
                    opacity: 0.7,
                  }}
                />
              </div>
              <span className="text-xs font-mono font-medium w-16 text-right shrink-0">
                {d.value >= 1000
                  ? `${(d.value / 1000).toFixed(1)}K`
                  : d.value.toFixed(d.value < 10 ? 1 : 0)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── SVG Donut Chart ───────────────────────────────────────────────── */

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

export interface DonutChartProps {
  segments: DonutSegment[];
  label: string;
  /** Diameter in pixels */
  size?: number;
}

export function DonutChart({
  segments,
  label,
  size = 120,
}: DonutChartProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  if (total === 0) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="text-sm font-semibold mb-3">{label}</h3>
        <EmptyState />
      </div>
    );
  }

  const radius = 40;
  const strokeWidth = 12;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  // Build segment offsets
  let accumulatedOffset = 0;
  const renderedSegments = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const fraction = s.value / total;
      const dashLength = fraction * circumference;
      const dashGap = circumference - dashLength;
      const offset = -accumulatedOffset;
      accumulatedOffset += dashLength;

      return { ...s, dashLength, dashGap, offset, fraction };
    });

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <h3 className="text-sm font-semibold mb-3">{label}</h3>
      <div className="flex items-center gap-6">
        {/* SVG donut */}
        <div className="relative shrink-0" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            {/* Background ring */}
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="var(--border)"
              strokeWidth={strokeWidth}
            />
            {/* Segments */}
            {renderedSegments.map((seg) => (
              <circle
                key={seg.label}
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke={seg.color}
                strokeWidth={strokeWidth}
                strokeDasharray={`${seg.dashLength} ${seg.dashGap}`}
                strokeDashoffset={seg.offset}
                strokeLinecap="butt"
                transform={`rotate(-90 ${center} ${center})`}
                className="transition-all duration-500"
              >
                <title>{`${seg.label}: ${seg.value} (${(seg.fraction * 100).toFixed(1)}%)`}</title>
              </circle>
            ))}
          </svg>
          {/* Center label */}
          <div
            className="absolute inset-0 flex flex-col items-center justify-center"
          >
            <span className="text-xs font-mono font-semibold leading-tight">
              {total >= 1000 ? `${(total / 1000).toFixed(1)}K` : total}
            </span>
            <span className="text-[10px] text-[var(--muted)]">total</span>
          </div>
        </div>

        {/* Legend */}
        <div className="space-y-1.5 min-w-0">
          {renderedSegments.map((seg) => (
            <div key={seg.label} className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-sm shrink-0"
                style={{ backgroundColor: seg.color }}
              />
              <span className="text-xs text-[var(--muted)] truncate">
                {seg.label}
              </span>
              <span className="text-xs font-mono font-medium ml-auto whitespace-nowrap">
                {seg.value} ({(seg.fraction * 100).toFixed(1)}%)
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── SVG Line Chart ────────────────────────────────────────────────── */

export interface LineChartProps {
  data: DataPoint[];
  label: string;
  color?: string;
  maxHeight?: number;
  /** Show the area fill below the line */
  showArea?: boolean;
  /** Unit suffix for y-axis values */
  unit?: string;
}

export function LineChart({
  data,
  label,
  color = "#3b82f6",
  maxHeight = 160,
  showArea = true,
  unit = "",
}: LineChartProps) {
  if (data.length < 2) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="text-sm font-semibold mb-3">{label}</h3>
        <EmptyState message={data.length === 1 ? "Waiting for more data..." : "No data yet"} />
      </div>
    );
  }

  const chartWidth = 400;
  const chartHeight = maxHeight;
  const padding = { top: 12, right: 12, bottom: 28, left: 40 };
  const innerWidth = chartWidth - padding.left - padding.right;
  const innerHeight = chartHeight - padding.top - padding.bottom;

  const values = data.map((d) => d.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || 1;

  const scaleX = (i: number) =>
    padding.left + (i / (data.length - 1)) * innerWidth;
  const scaleY = (v: number) =>
    padding.top + innerHeight - ((v - minValue) / range) * innerHeight;

  const linePath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${scaleX(i).toFixed(1)} ${scaleY(d.value).toFixed(1)}`)
    .join(" ");

  const areaPath = `${linePath} L ${scaleX(data.length - 1).toFixed(1)} ${(padding.top + innerHeight).toFixed(1)} L ${scaleX(0).toFixed(1)} ${(padding.top + innerHeight).toFixed(1)} Z`;

  // Y-axis labels (3 ticks)
  const yTicks = [0, 0.5, 1].map((frac) => {
    const val = minValue + frac * range;
    return {
      y: scaleY(val),
      label: val >= 1000 ? `${(val / 1000).toFixed(1)}K` : val.toFixed(val < 10 ? 1 : 0),
    };
  });

  // X-axis labels (first, middle, last)
  const xLabels = [0, Math.floor(data.length / 2), data.length - 1].map(
    (i) => ({
      x: scaleX(i),
      label: data[i]!.label,
    }),
  );

  const lastPoint = data[data.length - 1]!;
  const lastX = scaleX(data.length - 1);
  const lastY = scaleY(lastPoint.value);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">{label}</h3>
        <span className="text-xs font-mono text-[var(--muted)]">
          latest: {lastPoint.value.toFixed(lastPoint.value < 10 ? 1 : 0)}{unit}
        </span>
      </div>
      <div className="overflow-x-auto">
        <svg
          width={chartWidth}
          height={chartHeight}
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="block w-full"
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <linearGradient id={`area-gradient-${label.replace(/\s+/g, "-")}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.3" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Horizontal grid lines */}
          {yTicks.map((tick, i) => (
            <g key={i}>
              <line
                x1={padding.left}
                y1={tick.y}
                x2={chartWidth - padding.right}
                y2={tick.y}
                stroke="var(--border)"
                strokeWidth="0.5"
                strokeDasharray="4 4"
              />
              <text
                x={padding.left - 4}
                y={tick.y + 3}
                textAnchor="end"
                fill="var(--muted)"
                fontSize="9"
                fontFamily="monospace"
              >
                {tick.label}
              </text>
            </g>
          ))}

          {/* X-axis labels */}
          {xLabels.map((xl, i) => (
            <text
              key={i}
              x={xl.x}
              y={chartHeight - 4}
              textAnchor="middle"
              fill="var(--muted)"
              fontSize="9"
              fontFamily="monospace"
            >
              {xl.label}
            </text>
          ))}

          {/* Area fill */}
          {showArea && (
            <path
              d={areaPath}
              fill={`url(#area-gradient-${label.replace(/\s+/g, "-")})`}
              className="transition-all duration-300"
            />
          )}

          {/* Line */}
          <path
            d={linePath}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="transition-all duration-300"
          />

          {/* Data point dots (last 5 and the most recent) */}
          {data.slice(-5).map((d, i) => {
            const idx = data.length - 5 + i;
            if (idx < 0) return null;
            const cx = scaleX(idx);
            const cy = scaleY(d.value);
            return (
              <circle
                key={idx}
                cx={cx}
                cy={cy}
                r={idx === data.length - 1 ? 3.5 : 2}
                fill={color}
                opacity={idx === data.length - 1 ? 1 : 0.6}
              >
                <title>{`${d.label}: ${d.value.toFixed(1)}${unit}`}</title>
              </circle>
            );
          })}

          {/* Pulsing dot on latest point */}
          <circle
            cx={lastX}
            cy={lastY}
            r="6"
            fill={color}
            opacity="0.2"
          >
            <animate
              attributeName="r"
              values="4;8;4"
              dur="2s"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0.3;0.05;0.3"
              dur="2s"
              repeatCount="indefinite"
            />
          </circle>
        </svg>
      </div>
    </div>
  );
}
