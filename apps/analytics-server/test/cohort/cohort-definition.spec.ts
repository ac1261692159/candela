import {
  parseCsvUids,
  resolveConditionTime,
  substituteSqlPartDates,
  validateDefinition,
  validateCohortName,
} from '../../src/modules/cohort/cohort-definition';

describe('cohort-definition', () => {
  it('accepts default did_event sentence', () => {
    const def = validateDefinition('condition', {
      conditions: [
        {
          type: 'did_event',
          polarity: 'did',
          event: 'AppStart',
          metric: 'times',
          op: 'gt',
          value: 0,
          time: { mode: 'last_n_days', n: 7 },
        },
      ],
    });
    expect(def.conditions).toHaveLength(1);
  });

  it('rejects empty conditions', () => {
    expect(() => validateDefinition('condition', { conditions: [] })).toThrow();
  });

  it('requires sequence of at least two events', () => {
    expect(() =>
      validateDefinition('condition', {
        conditions: [{ type: 'sequence', polarity: 'did', events: ['A'], time: { mode: 'last_n_days', n: 7 } }],
      }),
    ).toThrow();
  });

  it('validates cohort name', () => {
    expect(validateCohortName('high_vip')).toBe('high_vip');
    expect(() => validateCohortName('High')).toThrow();
  });

  it('resolves last_n_days against compute day exclusive of today', () => {
    expect(resolveConditionTime({ mode: 'last_n_days', n: 7 }, '2026-09-05')).toEqual({
      start: '2026-08-29',
      end: '2026-09-04',
    });
  });

  it('parses csv uids and skips header', () => {
    expect(parseCsvUids('uid\na\nb\na\n')).toEqual(['a', 'b']);
  });

  it('accepts sql cohort definition and substitutes PartDate against compute day', () => {
    const def = validateDefinition('sql', {
      sql_text:
        "SELECT distinct_id AS uid FROM sa_events WHERE stat_date BETWEEN ${PartDate:start} AND ${PartDate:end}",
      time_params: [
        { name: 'start', mode: 'last_n_days', n: 7, bound: 'start' },
        { name: 'end', mode: 'last_n_days', n: 7, bound: 'end' },
      ],
    });
    const sql = substituteSqlPartDates(def as never, '2026-09-05');
    expect(sql).toContain('2026-08-29');
    expect(sql).toContain('2026-09-04');
  });

  it('rejects undeclared SQL placeholders', () => {
    expect(() =>
      validateDefinition('sql', {
        sql_text: 'SELECT uid FROM sa_events WHERE stat_date = ${PartDate:missing}',
        time_params: [],
      }),
    ).toThrow();
  });
});
