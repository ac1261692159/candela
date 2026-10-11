import { assertCardDisplay, parseStoredDisplay } from '../../src/modules/report/card-display';

describe('card-display', () => {
  it('accepts a typed view and rejects extra keys', () => {
    expect(assertCardDisplay('retention', { view: 'people_table' })).toEqual({ view: 'people_table' });
    expect(() => assertCardDisplay('retention', { view: 'nth_trend', extra: 1 })).toThrow(/非法键/);
    expect(() => assertCardDisplay('retention', { view: 'line' })).toThrow(/不合法/);
    expect(() => assertCardDisplay('text', { view: 'table' })).toThrow(/不支持/);
  });

  it('treats blank or invalid stored json as missing', () => {
    expect(parseStoredDisplay(null)).toBeNull();
    expect(parseStoredDisplay('{')).toBeNull();
    expect(parseStoredDisplay(JSON.stringify({ view: 'rate_table' }))).toEqual({ view: 'rate_table' });
  });
});
