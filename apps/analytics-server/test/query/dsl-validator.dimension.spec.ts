import { DomainError } from '../../src/i18n/domain-error';
import { DslValidatorService } from '../../src/modules/query/dsl-validator.service';

/** i18n v1：同步抛错断言统一为「DomainError + HTTP 状态 + 机器码」 */
function expectDomainError(fn: () => unknown, errorCode: string, status = 400) {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DomainError);
  expect(thrown).toMatchObject({ status, errorCode });
}

describe('DslValidatorService dimension property names', () => {
  const service = new DslValidatorService();

  it('accepts {prop}@{field} and #event_*@{field}', () => {
    expect(() => service.validatePropKey('goods_id@goods_name')).not.toThrow();
    expect(() => service.validatePropKey('#event_name@owner')).not.toThrow();
    expect(() => service.validatePropKey('#event_time@campaign')).not.toThrow();
  });

  it('still accepts ordinary property keys', () => {
    expect(() => service.validatePropKey('goods_id')).not.toThrow();
    expect(() => service.validatePropKey('$lib')).not.toThrow();
  });

  it('rejects injection characters and malformed @ names without widening the generic regex', () => {
    expectDomainError(() => service.validatePropKey("goods_id@x');drop"), 'analysis.dsl.propInvalid');
    expectDomainError(() => service.validatePropKey('goods_id@goods name'), 'analysis.dsl.propInvalid');
    expectDomainError(() => service.validatePropKey('goods_id@@name'), 'analysis.dsl.propInvalid');
    expectDomainError(() => service.validatePropKey(`goods_id@${'a'.repeat(60)}`), 'analysis.dsl.propInvalid');
  });
});
