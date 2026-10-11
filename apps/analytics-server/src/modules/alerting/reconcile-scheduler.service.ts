import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { appConfig } from '../../config/configuration';
import { DEFAULT_LOCALE, normalizeLocaleTag } from '../../i18n/locales';
import { serverT } from '../../i18n/messages';
import { PrismaService } from '../shared/prisma.service';
import { QualityService, type ReconcileConfigView } from '../meta/quality.service';
import { epochOfDayStart, epochOfWallClock, todayInTz, wallClockInTz } from '../time/calendar';
import { TimezoneService } from '../time/timezone.service';
import { AlertNotifyService, type NotifyContact } from './alert-notify.service';

/** 检查间隔：配置改时刻/开关后最多 5 分钟生效 */
const TICK_MS = 5 * 60_000;

/**
 * 对拍定时与告警编排（phase: clklog-data-quality-ops-v1，PRD R1-1/R1-3）。
 *
 * 为什么放在告警域：它同时需要「对拍执行」（meta 域）与「通知通道」（告警域），
 * 而 meta 域不能反向依赖告警域（QueryModule 已 imports MetaModule，会成环）。
 *
 * 运行规则：
 * - 只在 server 进程（background_workers）起定时器；ingestor 不起；
 * - 平台时区到点（默认 03:30）且**当日尚无 auto 快照**才跑（幂等：多进程/多实例不会重复）；
 * - 对拍范围默认昨日单日（低负载），失败或存在超阈偏差 → 走通知通道发给全部启用联系人。
 */
@Injectable()
export class ReconcileSchedulerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ReconcileSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly quality: QualityService,
    private readonly prisma: PrismaService,
    private readonly notify: AlertNotifyService,
    private readonly timezones: TimezoneService = new TimezoneService(undefined),
  ) {}

  onModuleInit(): void {
    if (!appConfig.background_workers) {
      this.logger.log('对拍定时未启动（非 server 进程）');
      return;
    }
    this.timer = setInterval(() => void this.tick().catch(() => undefined), TICK_MS);
    this.timer.unref();
    this.logger.log('对拍定时已启动（每 5 分钟检查一次，到点跑昨日单日对拍）');
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 一次检查（可被手动调用，便于测试与排障）。
   * @returns 本次是否真的跑了对拍及原因
   */
  async tick(now: Date = new Date()): Promise<{ ran: boolean; reason: string }> {
    if (this.running) return { ran: false, reason: 'running' };
    const config = await this.quality.configView();
    if (!config.enabled) return { ran: false, reason: 'disabled' };
    if (!this.due(now, config)) return { ran: false, reason: 'not_due' };
    if (await this.ranToday(now, config)) return { ran: false, reason: 'already_ran' };
    this.running = true;
    try {
      await this.runAndNotify(now);
      return { ran: true, reason: 'ok' };
    } finally {
      this.running = false;
    }
  }

  /** 到点判定：平台时区当前壁钟 ≥ 配置时刻 */
  private due(now: Date, config: ReconcileConfigView): boolean {
    const wall = wallClockInTz(this.timezones.platformTz, now.getTime());
    const [hour, minute] = config.run_at.split(':').map((part) => parseInt(part, 10));
    return wall.hour * 60 + wall.minute >= hour * 60 + minute;
  }

  /** 当日幂等：今天（平台时区）已经有 auto 快照就不再跑 */
  private async ranToday(now: Date, config: ReconcileConfigView): Promise<boolean> {
    const today = todayInTz(this.timezones.platformTz, now);
    const [hour, minute] = config.run_at.split(':').map((part) => parseInt(part, 10));
    const runAtMs = epochOfWallClock(
      this.timezones.platformTz,
      parseInt(today.slice(0, 4), 10),
      parseInt(today.slice(5, 7), 10),
      parseInt(today.slice(8, 10), 10),
      hour,
      minute,
      0,
    );
    // 兜底：若 run_at 参数异常导致 epoch 计算失败，退化为「平台日起点」
    const since = Number.isFinite(runAtMs) ? new Date(runAtMs) : new Date(epochOfDayStart(this.timezones.platformTz, today));
    const count = await this.prisma.reconcileSnapshot.count({
      where: { trigger: 'auto', ran_at: { gte: since } },
    });
    return count > 0;
  }

  /**
   * 跑一次昨日对拍；失败或超阈偏差 → 通知全部启用联系人。
   * `now` 可注入：范围按「该时刻的平台日历」推导（测试与补跑都靠它）。
   */
  async runAndNotify(now: Date = new Date()): Promise<{ has_alert: boolean; report_path: string | null }> {
    const yesterday = todayInTz(this.timezones.platformTz, new Date(now.getTime() - 86_400_000));
    try {
      const result = await this.quality.reconcile({
        project: DEFAULT_PROJECT,
        from: yesterday,
        to: yesterday,
        trigger: 'auto',
      });
      const failed = result.summary.has_alert;
      if (failed) {
        const alertDays = result.daily.items.filter((item) => item.status === 'ALERT');
        await this.notifyContacts((locale) => {
          const lines = [
            serverT(locale, 'reconcile.notify.lineProject', { project: DEFAULT_PROJECT }),
            serverT(locale, 'reconcile.notify.lineRange', { from: result.range.from, to: result.range.to }),
            serverT(locale, 'reconcile.notify.lineThreshold', { threshold: result.threshold_pct, days: alertDays.length }),
            ...alertDays.slice(0, 5).map((item) =>
              serverT(locale, 'reconcile.notify.lineDay', {
                date: item.date,
                sa: item.sa_cnt,
                raw: item.raw_cnt,
                deviation: item.deviation_pct,
              }),
            ),
          ];
          if (result.report_path) lines.push(serverT(locale, 'reconcile.notify.lineReport', { path: result.report_path }));
          return {
            subject: serverT(locale, 'reconcile.notify.dayAlertSubject', {
              date: yesterday,
              threshold: result.threshold_pct,
            }),
            text: lines.join('\n'),
          };
        });
      }
      return { has_alert: failed, report_path: result.report_path };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`自动对拍失败：${message}`);
      await this.notifyContacts((locale) => ({
        subject: serverT(locale, 'reconcile.notify.failedSubject', { date: yesterday }),
        text: [
          serverT(locale, 'reconcile.notify.lineProject', { project: DEFAULT_PROJECT }),
          serverT(locale, 'reconcile.notify.lineRange', { from: yesterday, to: yesterday }),
          serverT(locale, 'reconcile.notify.lineReason', { reason: message.slice(0, 300) }),
        ].join('\n'),
      }));
      throw error;
    }
  }

  /** 发给全部启用联系人（系统通知，不走规则模板；按收件人语言渲染；失败只记日志） */
  private async notifyContacts(build: (locale: string) => { subject: string; text: string }): Promise<void> {
    const contacts = (await this.prisma.alertContact.findMany({ where: { enabled: true } })) as unknown as NotifyContact[];
    if (contacts.length === 0) {
      this.logger.warn(`对拍通知无人可发（没有启用中的联系人）：${build(DEFAULT_LOCALE).subject}`);
      return;
    }
    await Promise.all(
      contacts.map((contact) => {
        const { subject, text } = build(normalizeLocaleTag(contact.locale) ?? DEFAULT_LOCALE);
        return this.notify
          .sendNow(contact, { subject, text, vars: { text, title: subject } })
          .catch((error) =>
            this.logger.warn(
              `对拍通知发送失败（${contact.kind}/${contact.name ?? contact.address}）：${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
      }),
    );
  }
}

/** 对拍归属项目（与告警域一致：单项目部署，clklogapp） */
const DEFAULT_PROJECT = 'clklogapp';
