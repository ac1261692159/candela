/**
 * 元数据选择器守卫清单（phase: clklog-analytics-rbac-v3 §5）。
 *
 * 分析师持 `meta.picker.view` 而非 `meta.view`：只有清单内的只读 handler 允许这枚码，
 * 治理面（Debug / 数据质量 / 数据表管理 / 属性详情等）必须保持在 `meta.view`。
 * 本用例锁死清单，新增调用方须先在设计文档 §5 登记再改断言。
 */
// 控制器经 service 顶层加载 clickhouse.service → YAML 配置（需要 APP_CONFIG_PATH 与真实密钥），
// CI 无密钥，按仓库既有约定隔离 configuration，只留本用例需要的字段。
jest.mock('../../config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { REQUIRE_PERMISSION_KEY } from '../iam/require-permission';
import { MetaEventController } from './meta-event.controller';
import { MetaPropertyController } from './meta-property.controller';
import { MetaVirtualEventController } from './meta-virtual-event.controller';
import { MetaVirtualPropertyController } from './meta-virtual-property.controller';
import { MetaEventAttributeController } from './meta-event-attribute.controller';
import { MetaSavedMetricController } from './meta-saved-metric.controller';
import { DebugController } from './debug.controller';
import { QualityController } from './quality.controller';
import { DatatableController } from '../datatable/datatable.controller';

const VIEW = 'meta.view';
const PICKER = 'meta.picker.view';

function handlerCodes(controller: { prototype: object }, method: string): string[] | undefined {
  const fn = (controller.prototype as Record<string, unknown>)[method];
  return fn ? (Reflect.getMetadata(REQUIRE_PERMISSION_KEY, fn) as string[] | undefined) : undefined;
}

function classCodes(controller: object): string[] | undefined {
  return Reflect.getMetadata(REQUIRE_PERMISSION_KEY, controller) as string[] | undefined;
}

/** 设计文档 §5 的 8 条选择器只读接口 */
const PICKER_HANDLERS: Array<[{ prototype: object }, string]> = [
  [MetaEventController, 'list'],
  [MetaPropertyController, 'getEventProperties'],
  [MetaPropertyController, 'getUserProperties'],
  [MetaVirtualEventController, 'list'],
  [MetaVirtualPropertyController, 'list'],
  [MetaEventAttributeController, 'list'],
  [DatatableController, 'dimensionProperties'],
  [DatatableController, 'labels'],
];

describe('元数据选择器守卫清单（rbac-v3）', () => {
  it.each(PICKER_HANDLERS)('选择器读接口 %p.%s 接受 meta.view 与 meta.picker.view', (controller, method) => {
    expect(handlerCodes(controller, method)).toEqual([VIEW, PICKER]);
  });

  it('治理面 handler 不携带 meta.picker.view', () => {
    // 同为元数据模块，但属治理：写接口、属性详情（EventAttributesPage 用）
    expect(handlerCodes(MetaEventController, 'update')).toEqual(['meta.edit']);
    expect(handlerCodes(MetaEventController, 'refreshStats')).toEqual(['meta.edit']);
    expect(handlerCodes(MetaEventAttributeController, 'detail')).toBeUndefined();
    expect(classCodes(MetaEventAttributeController)).toEqual([VIEW]);
    // 指标：读走 metric.view，写走 metric.edit_own
    expect(handlerCodes(MetaSavedMetricController, 'list')).toBeUndefined();
    expect(handlerCodes(MetaSavedMetricController, 'delete')).toEqual(['metric.edit_own']);
  });

  it('数据质量 / Debug / 数据表管理整体留在 meta.view', () => {
    expect(classCodes(QualityController)).toEqual([VIEW]);
    expect(classCodes(DebugController)).toEqual([VIEW]);
    expect(classCodes(DatatableController)).toEqual([VIEW]);
    expect(handlerCodes(DatatableController, 'list')).toBeUndefined();
    expect(handlerCodes(DatatableController, 'detail')).toBeUndefined();
    expect(handlerCodes(DatatableController, 'usage')).toBeUndefined();
  });
});
