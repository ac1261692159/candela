import { describe, expect, it } from 'vitest';
import { eventsForAnalysisPicker } from './EventSelect';
import type { MetaEvent } from '../types/meta.types';

function event(partial: Partial<MetaEvent> & Pick<MetaEvent, 'event_key' | 'status'>): MetaEvent {
  return {
    event_type: 'report',
    availability_status: 'available',
    data_status: 'normal',
    connection_status: 'auto',
    is_deleted: false,
    project_name: 'clklogapp',
    created_at: '',
    updated_at: '',
    ...partial,
  };
}

describe('eventsForAnalysisPicker', () => {
  it('drops hidden events and keeps pending plus visible', () => {
    expect(
      eventsForAnalysisPicker([
        event({ event_key: 'hidden_one', status: 'hidden', display_name: '隐藏' }),
        event({ event_key: 'complete_novice_guidance3_click', status: 'pending' }),
        event({ event_key: 'AppLaunch', status: 'visible', display_name: '启动' }),
      ]),
    ).toEqual([
      { value: 'complete_novice_guidance3_click', label: 'complete_novice_guidance3_click' },
      { value: 'AppLaunch', label: '启动 (AppLaunch)' },
    ]);
  });
});
