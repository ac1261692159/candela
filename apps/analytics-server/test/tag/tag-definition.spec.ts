import { parseTagDefinition, validateTagName } from '../../src/modules/tag/tag-definition';

const did = {
  type: 'did_event',
  polarity: 'did',
  event: 'AppStart',
  metric: 'times',
  op: 'gt',
  value: 0,
  time: { mode: 'last_n_days', n: 7 },
};

describe('tag-definition', () => {
  it('requires at least two rules with unique values', () => {
    expect(() => parseTagDefinition({ rules: [{ value: '高活', conditions: [did] }] })).toThrow('至少两条规则');
    expect(() =>
      parseTagDefinition({
        rules: [
          { value: '高活', conditions: [did] },
          { value: '高活', conditions: [did] },
        ],
      }),
    ).toThrow('标签值重复');
  });

  it('reuses cohort condition validation and accepts optional default_value', () => {
    const def = parseTagDefinition({
      rules: [
        { value: '高活', conditions: [did] },
        { value: '低活', conditions: [did] },
      ],
      default_value: '其他',
    });
    expect(def.rules).toHaveLength(2);
    expect(def.default_value).toBe('其他');
    expect(def.rules[0].conditions[0]).toMatchObject({ type: 'did_event', event: 'AppStart' });
  });

  it('rejects empty conditions via the shared cohort validator', () => {
    expect(() =>
      parseTagDefinition({
        rules: [
          { value: '高活', conditions: [] },
          { value: '低活', conditions: [did] },
        ],
      }),
    ).toThrow();
  });

  it('validates tag name like cohort name', () => {
    expect(validateTagName('activity_level')).toBe('activity_level');
    expect(() => validateTagName('High')).toThrow();
  });
});
