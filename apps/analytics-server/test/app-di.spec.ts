/**
 * 模块装配守卫（DI 图）。
 *
 * 背景（quality-ops-v1 R1 生产事故）：`ReconcileSchedulerService` 注入 `QualityService`，
 * 但 `AlertingModule` 当时没导入 `MetaModule`。各文件的单测自己建 provider，看不到这层，
 * 缺陷一路走到生产：进程启动即崩、supervisor 反复重启（AC-5 之外的代价）。
 *
 * 为什么不用 `Test.createTestingModule({ imports: [AppModule] })` 全量编译：
 * 仓库里存在模块间相互导入（cohort/tag/query 等），在 jest 的加载顺序下
 * `TestingInjector` 会拿到尚未求值的模块元类（`metatype is not a function`），
 * 与运行时（main.ts 的加载顺序）不一致，做不成稳定的闸门。
 * 这里改为**静态断言 imports 元数据**：精确编码本次事故的形态（跨域注入必须有 imports），
 * 稳定、快、没有假红。真正的运行时闸门是发版后的 `supervisorctl status` 与启动日志。
 */
jest.mock('../src/config/configuration', () => ({
  appConfig: {
    background_workers: false,
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    clickhouse: { write: { host: '127.0.0.1', port: 8123 }, readonly: { host: '127.0.0.1', port: 8123 } },
    reconcile: { reportDir: '/tmp/clklog-reconcile-di-spec' },
  },
}));

import { AlertingModule } from '../src/modules/alerting/alerting.module';
import { MetaModule } from '../src/modules/meta/meta.module';
import { OpsModule } from '../src/modules/ops/ops.module';
import { ReconcileSchedulerService } from '../src/modules/alerting/reconcile-scheduler.service';
import { QualityService } from '../src/modules/meta/quality.service';
import { RetentionService } from '../src/modules/ops/retention.service';

const importsOf = (mod: unknown): unknown[] => (Reflect.getMetadata('imports', mod as object) as unknown[]) ?? [];
const providersOf = (mod: unknown): unknown[] => (Reflect.getMetadata('providers', mod as object) as unknown[]) ?? [];
const exportsOf = (mod: unknown): unknown[] => (Reflect.getMetadata('exports', mod as object) as unknown[]) ?? [];

describe('模块装配守卫', () => {
  it('告警域注入了对拍服务 → 必须 import MetaModule（回放 R1 事故）', () => {
    expect(providersOf(AlertingModule)).toContain(ReconcileSchedulerService);
    expect(importsOf(AlertingModule)).toContain(MetaModule);
  });

  it('运维域注入了对拍与保留策略服务 → MetaModule 必须在 imports', () => {
    expect(providersOf(OpsModule)).toContain(RetentionService);
    expect(importsOf(OpsModule)).toContain(MetaModule);
  });

  it('meta 域导出对拍服务，且不反向依赖告警域（避免成环）', () => {
    expect(providersOf(MetaModule)).toContain(QualityService);
    expect(exportsOf(MetaModule)).toContain(QualityService);
    // 反向依赖检查：meta 的 imports 里不该出现 alerting / query 的环
    const metaImports = importsOf(MetaModule);
    expect(metaImports.some((m) => (m as { name?: string })?.name === 'AlertingModule')).toBe(false);
  });
});
