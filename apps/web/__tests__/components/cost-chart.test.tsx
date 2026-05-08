// Phase 4 — Spec tests 20-21: CostChart inline-SVG renderer.

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import CostChart from '@/components/dashboard/CostChart';

describe('<CostChart>', () => {
  it('test 20: empty data renders the placeholder', () => {
    const { getByText } = render(<CostChart data={[]} />);
    expect(getByText(/No runs yet/i)).toBeTruthy();
  });

  it('test 21: 30-day window renders SVG with N data points', () => {
    const data = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      cost_usd: i * 0.1,
    }));
    const { container, queryAllByTestId } = render(<CostChart data={data} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('role')).toBe('img');
    const points = queryAllByTestId('cost-chart-point');
    expect(points.length).toBe(30);
    // The path should have 30 vertices.
    const path = container.querySelector('path');
    expect(path).toBeTruthy();
    expect(path?.getAttribute('d')?.split('L').length).toBe(30);
  });
});
