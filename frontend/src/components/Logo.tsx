import React from 'react';

/**
 * Project Hub logo mark: a rounded tile with three ascending bars —
 * Capture. Build. Ship.
 *
 * Colours resolve through theme tokens (`--accent` / `--accent-contrast`), so
 * the mark stays legible in every theme. `variant="plain"` drops the tile and
 * draws only the bars in `currentColor` for monochrome contexts. The static
 * source of the mark lives at frontend/public/logo.svg (and favicon.svg).
 */
export function Logo({
  size = 26,
  variant = 'tile',
  className,
  title = 'Project Hub'
}: {
  size?: number;
  variant?: 'tile' | 'plain';
  className?: string;
  title?: string;
}) {
  const common: React.SVGProps<SVGSVGElement> = {
    width: size,
    height: size,
    viewBox: '0 0 32 32',
    className,
    role: 'img',
    'aria-label': title
  };

  if (variant === 'plain') {
    return (
      <svg {...common} fill="none">
        <rect x="8" y="9" width="8" height="3" rx="1.5" fill="currentColor" />
        <rect x="8" y="14.5" width="12" height="3" rx="1.5" fill="currentColor" />
        <rect x="8" y="20" width="16" height="3" rx="1.5" fill="currentColor" />
      </svg>
    );
  }

  return (
    <svg {...common} fill="none">
      <rect x="2" y="2" width="28" height="28" rx="8" fill="var(--accent)" />
      <rect x="8" y="9" width="8" height="3" rx="1.5" fill="var(--accent-contrast)" />
      <rect x="8" y="14.5" width="12" height="3" rx="1.5" fill="var(--accent-contrast)" />
      <rect x="8" y="20" width="16" height="3" rx="1.5" fill="var(--accent-contrast)" />
    </svg>
  );
}
