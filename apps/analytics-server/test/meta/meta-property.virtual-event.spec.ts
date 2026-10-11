import { MetaPropertyService } from '../../src/modules/meta/meta-property.service';

describe('MetaPropertyService.getEventProperties', () => {
  it('unions source-event properties when the key is a virtual event', async () => {
    const repository = {
      findEventProperties: jest
        .fn()
        .mockResolvedValueOnce([{ prop_key: 'channel' }, { prop_key: 'os' }])
        .mockResolvedValueOnce([{ prop_key: 'os' }, { prop_key: 'amount' }]),
    };
    const virtualEvents = {
      findDefinition: jest.fn().mockResolvedValue({ events: ['AppStart', 'Pay'] }),
    };
    const service = new MetaPropertyService(repository as never, virtualEvents as never);
    const merged = await service.getEventProperties('ve_abc123xxxx', 'clklogapp');
    expect(virtualEvents.findDefinition).toHaveBeenCalledWith('ve_abc123xxxx', 'clklogapp');
    expect(repository.findEventProperties).toHaveBeenCalledWith('AppStart', 'clklogapp');
    expect(repository.findEventProperties).toHaveBeenCalledWith('Pay', 'clklogapp');
    expect(merged.map((prop) => prop.prop_key)).toEqual(['channel', 'os', 'amount']);
  });
});
