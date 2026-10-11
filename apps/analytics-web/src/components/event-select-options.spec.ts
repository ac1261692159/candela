import { describe, expect, it } from 'vitest';
import { mergeAnalysisEventOptions, virtualEventMatches } from './event-select-options';
import type { MetaVirtualEvent } from '../types/meta.types';

function ve(partial: Partial<MetaVirtualEvent> & { ve_id: string }): MetaVirtualEvent {
  return {
    event_key: partial.ve_id,
    display_name: '新手完成',
    status: 'visible',
    definition_json: { events: ['complete_novice_guidance3'] },
    project_name: 'clklogapp',
    created_at: '',
    updated_at: '',
    ...partial,
  };
}

describe('event-select-options', () => {
  it('keeps visible virtual events on the empty keyword list', () => {
    const merged = mergeAnalysisEventOptions(
      [{ label: '启动', value: 'AppStart' }],
      [ve({ ve_id: 've_abc123xxxx' })],
    );
    expect(merged[0]).toEqual({ value: 've_abc123xxxx', label: '新手完成（虚拟）' });
    expect(merged.map((o) => o.value)).toEqual(['ve_abc123xxxx', 'AppStart']);
  });

  it('matches virtual events by source event name', () => {
    expect(virtualEventMatches(ve({ ve_id: 've_abc123xxxx' }), 'complete_novice_guidance3')).toBe(true);
    expect(virtualEventMatches(ve({ ve_id: 've_abc123xxxx' }), 'nope')).toBe(false);
    expect(virtualEventMatches(ve({ ve_id: 've_abc123xxxx', status: 'hidden' }), '')).toBe(false);
  });
});
