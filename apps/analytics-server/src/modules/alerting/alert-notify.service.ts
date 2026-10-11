import { Injectable, Logger } from '@nestjs/common';
import { AlertChannelConfigService } from './channels/channel-config.service';
import { ChannelDispatcher } from './channels/channel-rate-limiter';
import { channelDescriptor, isKnownChannel } from './channels/channel-registry';
import { describeError } from './channels/http';
import type { ContactTarget, SendContext } from './channels/channel-types';

/** 发送尝试次数与退避：3 次尝试，失败间隔 1s / 2s */
export const SEND_ATTEMPTS = 3;
export const SEND_RETRY_DELAYS_MS = [1_000, 2_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface NotifyContact {
  kind: string;
  webhook_url: string;
  address: string;
  options_json?: string | null;
  name?: string;
  /** 收件人语言：系统通知按收件人语言渲染（i18n 设计 §7.1） */
  locale?: string | null;
}

export interface NotifyMessage {
  subject: string;
  /** 渲染后的正文（按通道组模板） */
  text: string;
  /** 模板变量（通用 Webhook / WhatsApp 模板参数用） */
  vars: Record<string, string>;
}

export interface EnqueueInput extends NotifyMessage {
  contact: NotifyContact;
  ruleName: string;
  /** 投递结束回调（写 alertnotification 记录） */
  onDone: (ok: boolean, error?: Error) => void | Promise<void>;
}

/**
 * 告警投递（phase: clklog-analytics-alert-channels-v1）。
 *
 * - 通道分派走注册表（channels/channel-registry.ts），不再硬编码分支；
 * - 投递前经**通道限流**（令牌桶 + 间隔 + 积压合并）——钉钉/企微/Telegram 官方都是 20 条/分钟；
 * - 每条消息带 3 次重试（退避 1s/2s），失败把**厂商原始错误**交给回调落库。
 */
@Injectable()
export class AlertNotifyService {
  private readonly logger = new Logger(AlertNotifyService.name);
  private readonly dispatcher = new ChannelDispatcher();

  constructor(private readonly configs: AlertChannelConfigService) {}

  /** 联系人通道能力位（未配置凭证的通道不可用并给出原因），供前端与健康度使用 */
  async channels(): Promise<Record<string, { available: boolean; reason: string | null }>> {
    return this.configs.capabilities();
  }

  /** 队列深度（健康度/排障用） */
  queueDepth(channelKey: string): number {
    return this.dispatcher.queueDepth(channelKey);
  }

  /** 入队投递（不阻塞检测器：限流等待在后台队列里进行） */
  enqueue(input: EnqueueInput): void {
    const kind = input.contact.kind;
    if (!isKnownChannel(kind)) {
      void input.onDone(false, new Error(`unknown_channel_${kind}`));
      return;
    }
    const descriptor = channelDescriptor(kind);
    this.dispatcher.dispatch(kind, descriptor.ratePerMinute, {
      ruleName: input.ruleName,
      text: input.text,
      send: (text) => this.sendWithRetry(input.contact, { ...input, text }),
      done: (ok, error) => input.onDone(ok, error),
    });
  }

  /** 直接投递（通道「发送测试」用）：带重试，失败抛原始错误 */
  async sendNow(contact: NotifyContact, message: NotifyMessage): Promise<void> {
    await this.sendWithRetry(contact, message);
  }

  private async sendWithRetry(contact: NotifyContact, message: NotifyMessage): Promise<void> {
    // 通道被暂停：确定性失败，**不进重试循环**（重试 3 次只是浪费与日志噪音）
    // 判定口径（requiredConfig 是否全部 muted）见 AlertChannelConfigService.isMutedForKind
    if (await this.configs.isMutedForKind(contact.kind)) throw new Error('channel_muted');
    let lastError: unknown;
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      try {
        await this.deliver(contact, message);
        if (attempt > 1) this.logger.log(`告警通知重试成功（第 ${attempt} 次尝试，通道 ${contact.kind}）`);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < SEND_ATTEMPTS) {
          this.logger.warn(
            `告警通知第 ${attempt} 次失败（通道 ${contact.kind}）：${describeError(error)}，将重试`,
          );
          await sleep(SEND_RETRY_DELAYS_MS[attempt - 1]);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async deliver(contact: NotifyContact, message: NotifyMessage): Promise<void> {
    const descriptor = channelDescriptor(contact.kind);
    const ctx: SendContext = {
      contact: toTarget(contact),
      text: message.text,
      subject: message.subject,
      vars: message.vars,
      readConfig: (key: string) => this.configs.readConfig(key),
    };
    await descriptor.send(ctx);
  }

  warnFailed(ruleCode: string, message: string): void {
    this.logger.warn(`告警通知失败 [${ruleCode}] ${message}`);
  }
}

/** Prisma 联系人行 → 通道目标（解析 options_json） */
export function toTarget(contact: NotifyContact): ContactTarget {
  let options: Record<string, unknown> = {};
  if (contact.options_json) {
    try {
      const parsed = JSON.parse(contact.options_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        options = parsed as Record<string, unknown>;
      }
    } catch {
      options = {};
    }
  }
  return {
    name: contact.name,
    kind: contact.kind,
    webhook_url: contact.webhook_url ?? '',
    address: contact.address ?? '',
    options,
  };
}
