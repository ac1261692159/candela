import { assertHarnessDsl, pageSchema } from './analysis-tool-policy';
import { DslValidatorService } from '../query/dsl-validator.service';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Harness analysis contracts', () => {
  it('validates the actual tool examples with the production DSL validator', () => {
    const examples = JSON.parse(readFileSync(resolve(__dirname, '../../../../analytics-harness-host/plugins/analytics-tools/analysis-cases.json'), 'utf8'));
    const validator = new DslValidatorService();
    validator.validateEventQuery({ ...examples.event, project: 'fixture' });
    validator.validateFunnelQuery({ ...examples.funnel, project: 'fixture' });
    validator.validateRetentionQuery({ ...examples.retention, project: 'fixture' });
    expect(validator.capabilities().analysis_methods).toContain('sum');
  });

  it('rejects identity fields and the known unsafe user property path at any nesting level', () => {
    expect(() => assertHarnessDsl({ filters: { items: [{ scope: 'user', prop: 'account_balance' }] } })).toThrow('user_property_query_unavailable');
    expect(() => assertHarnessDsl({ groups: [{ prop: 'distinct_id' }] })).toThrow('identity');
    expect(() => assertHarnessDsl({ metrics: [{ analysis: 'sum', prop: 'amount' }] })).not.toThrow();
  });

  it('finds matches beyond item 100 and pages before output pruning', () => {
    const events = Array.from({ length: 151 }, (_, i) => ({ event_key: `e_${i}` }));
    expect(pageSchema({ events }, 'e_150', 1).events).toEqual([{ event_key: 'e_150' }]);
    const page = pageSchema({ events }, '', 3);
    expect(page.events).toHaveLength(50);
    expect(page.pagination.events).toEqual({ total: 151, page: 3, next_page: 4 });
    expect(() => pageSchema({ events }, '', -1)).toThrow('schema_page_invalid');
  });
});
