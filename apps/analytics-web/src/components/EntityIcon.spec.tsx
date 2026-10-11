// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EntityIcon, type EntityIconType } from './EntityIcon';

const ALL_TYPES: EntityIconType[] = [
  'event',
  'virtual-event',
  'event-property',
  'user-property',
  'metric',
  'dashboard',
  'card',
  'cohort',
  'tag',
  'subject',
  'api-key',
];

describe('EntityIcon', () => {
  it('renders an icon for every entity type', () => {
    for (const type of ALL_TYPES) {
      const { container } = render(<EntityIcon type={type} />);
      expect(container.querySelector('span[role="img"]'), `type=${type}`).toBeTruthy();
    }
  });

  it('applies default size and style overrides', () => {
    const { container } = render(<EntityIcon type="event" size={18} style={{ color: 'red' }} />);
    const icon = container.querySelector('span[role="img"]');
    expect(icon?.getAttribute('style')).toContain('font-size: 18px');
    expect(icon?.getAttribute('style')).toContain('color: red');
  });

  it('distinguishes virtual-event from event', () => {
    const event = render(<EntityIcon type="event" />);
    const virtual = render(<EntityIcon type="virtual-event" />);
    const eventSvg = event.container.querySelector('span[role="img"]')?.innerHTML;
    const virtualSvg = virtual.container.querySelector('span[role="img"]')?.innerHTML;
    expect(eventSvg).not.toBe(virtualSvg);
  });
});
