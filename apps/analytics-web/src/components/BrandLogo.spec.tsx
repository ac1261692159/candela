// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandLogo } from './BrandLogo';

describe('BrandLogo', () => {
  it('renders the mark variant as an svg with default brand color', () => {
    const { container } = render(<BrandLogo variant="mark" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('width')).toBe('24');
    expect(svg?.getAttribute('height')).toBe('24');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    // jsdom 将 hex 归一化为 rgb
    expect(svg?.getAttribute('style')).toContain('rgb(22, 119, 255)');
  });

  it('applies size and color props to the mark', () => {
    const { container } = render(<BrandLogo variant="mark" size={20} color="#123456" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('20');
    expect(svg?.getAttribute('height')).toBe('20');
    expect(svg?.getAttribute('style')).toContain('rgb(18, 52, 86)');
  });

  it('renders the full variant with wordmark text', () => {
    const { container, getByText } = render(<BrandLogo variant="full" />);
    expect(getByText('Candela')).toBeTruthy();
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('passes aria-label as an img role on the wrapper', () => {
    const { getByRole } = render(<BrandLogo variant="mark" aria-label="Candela 分析平台" />);
    expect(getByRole('img', { name: 'Candela 分析平台' })).toBeTruthy();
  });
});
