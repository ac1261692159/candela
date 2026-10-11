import { describe, expect, it } from 'vitest';
import type { QueryColumn } from '../../types/dsl.types';
import { resultToCsv } from './result-csv';

describe('resultToCsv', () => {
  it('writes mapped columns as display name plus raw value', () => {
    const columns: QueryColumn[] = [
      { key: 'g_0', title: '商品ID', value_map: { SGD1: 'Feather Arc' }, value_map_title: '商品名称' },
      { key: 'm_0', title: '次数' },
    ];
    const csv = resultToCsv(columns, [{ g_0: 'SGD1', m_0: 3 }]);
    expect(csv).toBe('商品ID（商品名称）,商品ID（原始值）,次数\nFeather Arc,SGD1,3');
  });
});
