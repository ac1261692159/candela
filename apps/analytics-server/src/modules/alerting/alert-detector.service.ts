import { Injectable, Logger, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { ClickHouseService } from '../shared/clickhouse.service';
import { appConfig } from '../../config/configuration';
import { diskUsage } from '../ops/host-metrics';
import { forecastDiskFull } from '../ops/disk-forecast';
import { AlertNotifyService } from './alert-notify.service';
import { compare, opLabel, requiredPolls, nextStreak, type Comparator } from './alert-eval';
import { AlertMetricEvalService, type MetricBrief } from './alert-metric-eval.service';
import { AlertTemplateService } from './alert-template.service';
import { channelDescriptor } from './channels/channel-registry';
import {
  formatMetricValue,
  windowLabel,
} from './alert-metric-eval';
import type { AlertChannel, AlertKind, TemplateContext } from './alert-template';
import { parseChDateTimeInTz } from '../time/calendar';
import { formatInTz } from '../time/format';
import { TimezoneService } from '../time/timezone.service';
import { ProjectTimeRegistry } from '../time/project-time-registry';
import { serverT } from '../../i18n/messages';
import { DEFAULT_LOCALE, normalizeLocaleTag } from '../../i18n/locales';
import { localizeUnit } from '../../i18n/units';

const DETECT_INTERVAL_MS = 60_000;
const DATA_DISK_PATH = '/data';
const DISK_METRIC_PREFIX = 'disk_used:';
/**
 * 磁盘外推采样窗口（天）与点数上限（有界查询，红线 4）。
 *
 * 窗口取 7 天而非更长：本机容量是**被主动治理**的（日志清理每小时跑），
 * 一次性清理会主导长窗口的拟合。2026-09-15 实测：30 天窗口斜率 **−55.76 GB/天**
 * （被 09-08 那次释放约 1 TB 的清理拉负），规则会永远判「无增长」而静默失效；
 * 同一时刻 7 天窗口为 **+6.27 GB/天**、3 天为 +6.88 GB/天，才是真实趋势。
 */
const FORECAST_WINDOW_DAYS = 7;
const FORECAST_MAX_POINTS = 2_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const FIFTEEN_MINUTES_MS = 15 * 60_000;
const THIRTY_MINUTES_MS = 30 * 60_000;

type RuleRow = {
  code: string;
  name: string;
  threshold: number;
  severity: string;
  comparator: string;
  unit: string;
  window_minutes: number;
  for_windows: number;
  repeat_minutes: number;
  notify_on_resolve: boolean;
  source: string;
  metric_id: string | null;
  window_days: number;
  /** metric（默认，跟随指标查询时间）/ rule（由本规则窗口指定）——metric-v2 */
  time_source: string;
  project_name: string | null;
};

/**
 * 告警检测（phase: clklog-analytics-alerting-v1）。
 * 60s 轮询；连续 requiredPolls 次越线才触发；飞书由 AlertNotifyService 发送。
 */
@Injectable()
export class AlertDetectorService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AlertDetectorService.name);
  private timer: NodeJS.Timeout | null = null;
  /** 重入保护：通知重试会拉长单轮耗时，避免周期叠加导致重复事件/重复通知（PRD AC-8） */
  private running = false;
  private clickhouseFailCount = 0;
  private readonly streaks = new Map<string, number>();
  /** 本轮各指标规则的指标摘要（模板变量用；不进状态机） */
  private readonly metricBriefs = new Map<string, MetricBrief>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clickhouse: ClickHouseService,
    private readonly notify: AlertNotifyService,
    private readonly metricEval: AlertMetricEvalService,
    private readonly templates: AlertTemplateService,
    // 缺省构造兜底纯单测；生产由 DI 注入（TimeModule @Global）
    private readonly timezones: TimezoneService = new TimezoneService(undefined),
    @Optional() private readonly projectTimes?: ProjectTimeRegistry,
  ) {}

  onModuleInit() {
    // ingestor 进程复用 AppModule：后台任务只在 server 侧跑，否则规则每分钟被检测两次
    // 并双倍扫描 system.query_log（CODE_HANDOVER AL-02）
    if (!appConfig.background_workers) {
      this.logger.log('告警检测未启动（非 server 进程）');
      return;
    }
    this.timer = setInterval(() => void this.detect(), DETECT_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async detect(): Promise<void> {
    if (this.running) {
      this.logger.warn('上一轮检测尚未结束，跳过本轮（防止周期叠加重复告警）');
      return;
    }
    this.running = true;
    try {
      await this.runDetect();
    } finally {
      this.running = false;
    }
  }

  private async runDetect(): Promise<void> {
    let rules: RuleRow[];
    try {
      rules = await this.prisma.alertRule.findMany({ where: { enabled: true } });
    } catch (error) {
      this.logger.warn(`告警规则读取失败: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const byCode = new Map(rules.map((rule) => [rule.code, rule]));
    await this.apply('disk_space_low', byCode, () => this.evalDiskSpace());
    await this.apply('disk_forecast_full', byCode, () => this.evalDiskForecast());
    await this.apply('data_link_stale', byCode, () => this.evalDataLinkStale());
    await this.apply('clickhouse_down', byCode, () => this.evalClickHouseDown());
    await this.apply('slow_query_spike', byCode, () => this.evalSlowQuerySpike());
    await this.apply('query_fail_rate', byCode, () => this.evalQueryFailRate());
    await this.apply('card_cache_fail', byCode, () => this.evalCardCacheFail());
    for (const rule of rules) {
      if (rule.source !== 'metric' || !rule.metric_id) continue;
      await this.apply(rule.code, byCode, async () => {
        const { value, metric } = await this.metricEval.evaluate(rule);
        if (metric) this.metricBriefs.set(rule.code, metric);
        else this.metricBriefs.delete(rule.code);
        return value;
      });
    }
  }

  private async apply(
    code: string,
    byCode: Map<string, RuleRow>,
    observe: () => Promise<number | null>,
  ): Promise<void> {
    const rule = byCode.get(code);
    if (!rule) return;
    let value: number | null;
    try {
      value = await observe();
    } catch (error) {
      this.logger.warn(`观测失败 [${code}]: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (value === null) return;
    const hit = compare(value, rule.comparator as Comparator, rule.threshold);
    const streak = nextStreak(this.streaks.get(code) ?? 0, hit);
    this.streaks.set(code, streak);
    const need = requiredPolls(rule.window_minutes, rule.for_windows);
    if (hit && streak >= need) await this.recordFiring(rule, value);
    else if (!hit) await this.recordResolved(rule);
  }

  private async recordFiring(rule: RuleRow, value: number): Promise<void> {
    try {
      const existing = await this.prisma.alertEvent.findFirst({
        where: { rule_code: rule.code, status: 'firing' },
      });
      if (existing) {
        await this.prisma.alertEvent.update({
          where: { id: existing.id },
          data: { value, last_seen_at: new Date() },
        });
        await this.maybeNotify(rule, existing.id, value, 'repeat');
        return;
      }
      const created = await this.prisma.alertEvent.create({
        data: { rule_code: rule.code, value, status: 'firing' },
      });
      this.logger.warn(`告警触发 [${rule.code}] 当前值 ${value}`);
      await this.maybeNotify(rule, created.id, value, 'fire');
    } catch (error) {
      this.logger.warn(`告警事件写入失败 [${rule.code}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async recordResolved(rule: RuleRow): Promise<void> {
    try {
      const existing = await this.prisma.alertEvent.findFirst({
        where: { rule_code: rule.code, status: 'firing' },
      });
      if (!existing) return;
      await this.prisma.alertEvent.update({
        where: { id: existing.id },
        data: { status: 'resolved', resolved_at: new Date() },
      });
      if (rule.notify_on_resolve) await this.maybeNotify(rule, existing.id, existing.value, 'resolve');
    } catch {
      // 恢复写入失败不致命
    }
  }

  private async maybeNotify(
    rule: RuleRow,
    eventId: bigint,
    value: number,
    kind: 'fire' | 'repeat' | 'resolve',
  ): Promise<void> {
    if (kind === 'repeat') {
      const last = await this.prisma.alertNotification.findFirst({
        where: { rule_code: rule.code, kind: { in: ['fire', 'repeat'] } },
        orderBy: { created_at: 'desc' },
      });
      if (last && Date.now() - last.created_at.getTime() < rule.repeat_minutes * 60_000) return;
    }
    if (await this.isMuted(rule.code)) return;
    // 多联系人：规则绑定的联系人（启用中的）逐个投递；一个都没绑 → 发给全部启用联系人
    const contacts = await this.resolveContacts(rule);
    if (contacts.length === 0) return;
    const kindCode: AlertKind = kind === 'resolve' ? 'resolve' : 'fire';
    for (const contact of contacts) {
      const group = channelDescriptor(contact.kind).group;
      // 通知语言按**收件人**：联系人自身语言 → 平台默认（i18n v1，设计文档 §7.1）
      const locale = normalizeLocaleTag(contact.locale) ?? DEFAULT_LOCALE;
      // 通知时间按收件人时区渲染（timezone-v2）：联系人 ?? 项目 ?? 平台
      const notifyTz =
        contact.timezone ??
        this.projectTimes?.timeZoneOf(rule.project_name, this.timezones.platformTz) ??
        this.timezones.platformTz;
      const vars = this.buildVars(rule, value, kind, contact.name, locale, notifyTz);
      const message = await this.templates.render(rule.project_name ?? '', kindCode, group, vars, locale);
      // 入队投递：通道限流（钉钉/企微/Telegram 官方 20 条/分钟）在队列里做，
      // 不阻塞检测器下一轮；投递结果由回调写 alertnotification（每个联系人一行）
      this.notify.enqueue({
        contact,
        ruleName: rule.name,
        subject: message.subject,
        text: message.body,
        vars: vars as Record<string, string>,
        onDone: async (ok, error) => {
          const detail = error instanceof Error ? error.message : '';
          if (ok) {
            await this.prisma.alertNotification
              .create({
                data: {
                  rule_code: rule.code,
                  event_id: eventId,
                  kind,
                  status: 'success',
                  contact_id: contact.id,
                  contact_name: contact.name,
                },
              })
              .catch(() => undefined);
            return;
          }
          this.notify.warnFailed(rule.code, detail);
          await this.prisma.alertNotification
            .create({
              data: {
                rule_code: rule.code,
                event_id: eventId,
                kind,
                status: 'fail',
                error: detail.slice(0, 500),
                contact_id: contact.id,
                contact_name: contact.name,
              },
            })
            .catch(() => undefined);
        },
      });
    }
  }

  private async isMuted(code: string): Promise<boolean> {
    const now = new Date();
    const mute = await this.prisma.alertMute.findFirst({
      where: {
        starts_at: { lte: now },
        ends_at: { gte: now },
        OR: [{ rule_code: null }, { rule_code: code }],
      },
    });
    return Boolean(mute);
  }

  /**
   * 规则的投递目标（多联系人，2026-09-16 起）：
   * 优先用规则绑定的**启用中**联系人；一个都没绑（或都被停用）时回退到「全部启用联系人」，
   * 避免规则静默不投递。停用联系人不会有任何投递。
   */
  private async resolveContacts(rule: RuleRow) {
    const links = await this.prisma.alertRuleContact.findMany({
      where: { rule_code: rule.code },
      include: { contact: true },
    });
    // 绑定行可能指向已删除的联系人（FK 级联之外的兜底），空值直接跳过
    const bound = links
      .map((link) => link.contact)
      .filter((contact): contact is NonNullable<typeof contact> => Boolean(contact) && contact.enabled);
    if (bound.length > 0) return bound;
    return this.prisma.alertContact.findMany({ where: { enabled: true } });
  }

  /**
   * 模板变量（alerting-v4）：通知内容全部来自模板渲染，这里只负责把规则/观测值摊平成占位符。
   * 缺失的变量在模板里渲染为空串，不会阻断投递。
   */
  private buildVars(
    rule: RuleRow,
    value: number,
    kind: 'fire' | 'repeat' | 'resolve',
    contactName = '',
    locale: string = DEFAULT_LOCALE,
    notifyTz?: string,
  ): TemplateContext {
    const level =
      ({
        critical: serverT(locale, 'alert.level.critical'),
        warning: serverT(locale, 'alert.level.warning'),
        info: serverT(locale, 'alert.level.info'),
      } as Record<string, string>)[rule.severity] ?? rule.severity;
    const statusCode = kind === 'resolve' ? 'resolve' : kind === 'repeat' ? 'repeat' : 'fire';
    const status = serverT(locale, `alert.status.${statusCode}`);
    const brief = this.metricBriefs.get(rule.code);
    const isPercent = brief?.kind === 'retention' && rule.unit === '%';
    // 指标自带查询时间时用指标口径文案（求值结果里带回来），否则沿用规则窗口文案
    // 中文沿用指标求值阶段算好的口径文案（含留存队列说明）；其他语言按窗口天数就地生成，
    // 避免把中文口径串带进英文通知（队列说明的完整本地化随「指标口径多语言」后续 phase）
    const windowFmt =
      locale.startsWith('zh')
        ? rule.metric_id
          ? brief?.window_label ?? windowLabel(rule.window_days ?? 1, locale)
          : `${rule.window_minutes} 分钟窗口`
        : windowLabel(rule.window_days ?? 1, locale);
    return {
      rule_name: rule.name,
      rule_code: rule.code,
      level: rule.severity,
      level_fmt: level,
      status,
      status_code: statusCode,
      value: formatMetricValue(value, rule.unit, isPercent ? 'percent' : undefined, locale),
      value_raw: String(value),
      unit: localizeUnit(rule.unit, locale),
      comparator: rule.comparator,
      comparator_fmt: opLabel(rule.comparator as Comparator),
      threshold: formatMetricValue(rule.threshold, rule.unit, isPercent ? 'percent' : undefined, locale),
      metric_name: brief ? brief.display_name || brief.name : rule.name,
      metric_kind: brief
        ? brief.kind === 'retention'
          ? serverT(locale, 'alert.kind.retention')
          : serverT(locale, 'alert.kind.event')
        : serverT(locale, 'alert.kind.builtin'),
      window_days: String(rule.window_days ?? 1),
      window_fmt: windowFmt,
      project: rule.project_name ?? '',
      time: formatInTz(new Date(), notifyTz ?? this.timezones.platformTz),
      detect_interval: `${Math.round(DETECT_INTERVAL_MS / 1000)}s`,
      contact_name: contactName,
    };
  }

  private evalDiskSpace(): Promise<number | null> {
    const disk = diskUsage(DATA_DISK_PATH);
    if (!disk) return Promise.resolve(null);
    return Promise.resolve(Math.round((disk.freeBytes / disk.totalBytes) * 1000) / 10);
  }

  /**
   * 磁盘预计用尽（phase: clklog-analytics-alerting-v3）。
   * 观测值 = 由 `disk_used:/data` 采样线性外推的「距用尽天数」。
   * 无增长 → NO_GROWTH_DAYS（不命中，可解除已有事件）；采样不足或读取失败 → null（本轮跳过，不改状态）。
   */
  private async evalDiskForecast(): Promise<number | null> {
    try {
      const since = new Date(Date.now() - FORECAST_WINDOW_DAYS * 24 * 3_600_000);
      const samples = await this.prisma.hostMetricSample.findMany({
        where: { metric_key: `${DISK_METRIC_PREFIX}${DATA_DISK_PATH}`, sampled_at: { gte: since } },
        orderBy: { sampled_at: 'asc' },
        take: FORECAST_MAX_POINTS,
      });
      const disk = diskUsage(DATA_DISK_PATH);
      if (!disk) return null;
      const result = forecastDiskFull(
        samples.map((sample) => ({ t: sample.sampled_at.getTime(), v: sample.value })),
        disk.totalBytes,
      );
      return result.daysToFull;
    } catch (error) {
      this.logger.warn(`磁盘外推观测失败: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async evalDataLinkStale(): Promise<number | null> {
    try {
      const stats = await this.clickhouse.queryDataStats();
      if (!stats.lastWriteAt) return 0;
      // CH 服务端墙钟显式按平台时区解析（ZQ-4：曾与此仓 data-mgmt 的 +Z UTC 解释双标）
      const last = parseChDateTimeInTz(stats.lastWriteAt, this.timezones.platformTz);
      if (last === null) return 0;
      return Math.round((Date.now() - last) / 60_000);
    } catch {
      return null;
    }
  }

  private async evalClickHouseDown(): Promise<number | null> {
    try {
      await this.clickhouse.queryDataStats();
      this.clickhouseFailCount = 0;
      return 0;
    } catch {
      this.clickhouseFailCount += 1;
      return this.clickhouseFailCount;
    }
  }

  private async evalSlowQuerySpike(): Promise<number | null> {
    try {
      const rows = await this.clickhouse.querySlowQueries({
        since: new Date(Date.now() - FIVE_MINUTES_MS),
        minDurationMs: 5000,
        status: 'all',
        limit: 1000,
      });
      return rows.length;
    } catch {
      return null;
    }
  }

  private async evalQueryFailRate(): Promise<number | null> {
    try {
      const rows = await this.clickhouse.querySlowQueries({
        since: new Date(Date.now() - FIFTEEN_MINUTES_MS),
        minDurationMs: 0,
        status: 'all',
        limit: 1000,
      });
      if (rows.length === 0) return 0;
      const failed = rows.filter((row) => row.type === 'ExceptionWhileProcessing').length;
      return Math.round((failed / rows.length) * 1000) / 10;
    } catch {
      return null;
    }
  }

  private async evalCardCacheFail(): Promise<number | null> {
    try {
      return await this.prisma.cardCache.count({
        where: {
          error: { not: null },
          refreshed_at: { gte: new Date(Date.now() - THIRTY_MINUTES_MS) },
        },
      });
    } catch {
      return null;
    }
  }
}
