import { HttpException } from '@nestjs/common';
import { HarnessGatewayService } from './harness-gateway.service';
import { EventEmitter } from 'events';
import http = require('http');

describe('HarnessGatewayService model guardrails', () => {
  const provider = {
    adapter: 'openai_compatible',
    display_name: 'Test Provider',
    base_url: 'https://provider.example/v1',
    protocol: 'openai-completions',
    configured_by: 'config',
    resolved_api_key: 'not-exposed-to-test-output',
    models: [
      {
        id: 'model-a',
        display_name: 'Model A',
        reasoning_efforts: ['off', 'high'],
        default_reasoning_effort: 'high',
      },
    ],
  };
  const paths = {
    harnessConfig: jest.fn(() => ({ runtime: { max_tokens: 4096 } })),
  };
  const service = new HarnessGatewayService(
    { get: jest.fn() } as never,
    paths as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const internal = service as unknown as {
    validateModelRequest: (
      providerConfig: typeof provider,
      body: Record<string, unknown>,
      endpoint: string,
    ) => void;
    acquireModelPermit: (runtimeId: string) => () => void;
  };

  it('enforces the configured model, reasoning effort and output-token ceiling', () => {
    const body: Record<string, unknown> = {
      model: 'model-a',
      reasoning_effort: 'high',
      max_tokens: 100_000,
    };
    internal.validateModelRequest(provider, body, '/chat/completions');
    expect(body.max_tokens).toBe(4096);

    expect(() => internal.validateModelRequest(provider, {
      model: 'model-a',
      reasoning_effort: 'unsupported',
    }, '/chat/completions')).toThrow(HttpException);
    expect(() => internal.validateModelRequest(provider, {
      model: 'model-b',
    }, '/chat/completions')).toThrow('model_not_allowed');
  });

  it('limits concurrent calls independently for each runtime', () => {
    const releaseFirst = internal.acquireModelPermit('air_runtime_a');
    const releaseSecond = internal.acquireModelPermit('air_runtime_a');
    expect(() => internal.acquireModelPermit('air_runtime_a')).toThrow(
      'model_concurrency_limit_exceeded',
    );
    const releaseOther = internal.acquireModelPermit('air_runtime_b');

    releaseFirst();
    const releaseThird = internal.acquireModelPermit('air_runtime_a');
    releaseSecond();
    releaseThird();
    releaseOther();
  });

  it('maps OpenAI developer roles to system for DeepSeek-compatible chat bodies', () => {
    const body: Record<string, unknown> = {
      model: 'model-a',
      messages: [
        { role: 'developer', content: 'persona' },
        { role: 'user', content: 'hi' },
      ],
    };
    internal.validateModelRequest(provider, body, '/chat/completions');
    expect(body.messages).toEqual([
      { role: 'system', content: 'persona' },
      { role: 'user', content: 'hi' },
    ]);
  });
});

describe('Harness model request deadline', () => {
  it('terminates a request even when no socket timeout event arrives', async () => {
    jest.useFakeTimers();
    const upstream = new EventEmitter() as EventEmitter & { end: jest.Mock; destroy: jest.Mock };
    upstream.end = jest.fn();
    upstream.destroy = jest.fn((error) => { upstream.emit('error', error); upstream.emit('close'); });
    const request = jest.spyOn(http, 'request').mockReturnValue(upstream as never);
    try {
      const service = new HarnessGatewayService({} as never,
        { harnessConfig: () => ({ runtime: { max_tokens: 4096 } }) } as never,
        {} as never, {} as never,
        { provider: () => ({
          base_url: 'http://fixture.test', resolved_api_key: 'synthetic', protocol: 'openai-completions',
          models: [{ id: 'm', display_name: 'M', reasoning_efforts: ['off'], default_reasoning_effort: 'off' }],
        }) } as never);
      const internal = service as any;
      internal.readJson = async () => ({ model: 'm' });
      const response = new EventEmitter();
      const pending = internal.proxyModel({ method: 'POST', headers: {} }, response, { runtimeId: 'fixture' }, '/model/fixture/chat/completions');
      const assertion = expect(pending).rejects.toThrow('model_deadline_exceeded');
      await Promise.resolve();
      expect(request).toHaveBeenCalled();
      jest.advanceTimersByTime(600_000);
      await assertion;
      expect(upstream.destroy).toHaveBeenCalledTimes(1);
    } finally { request.mockRestore(); jest.useRealTimers(); }
  });
});

describe('Harness analysis project binding', () => {
  it.each(['event', 'funnel', 'retention'])('forces the runtime project for %s', async (page) => {
    const service = new HarnessGatewayService({} as never, {} as never, {} as never, {} as never, {} as never) as any;
    service.authorize = async () => ({ project: 'authorized' });
    service.readJson = async () => ({ project: 'injected', metrics: [] });
    service.internalApi = jest.fn().mockResolvedValue({ rows: [] });
    service.sendJson = jest.fn();
    await service.route({ method: 'POST', url: `/tools/query/${page}` }, {});
    expect(service.internalApi).toHaveBeenCalledWith({ project: 'authorized' }, 'POST', `/sa/api/query/${page}`,
      expect.objectContaining({ project: 'authorized' }));
  });
});
