// 必须在 import DTO（class-validator 装饰器）之前 polyfill reflect-metadata（同 test/ops/disk-trend.dto.spec.ts）
import 'reflect-metadata';

/**
 * 通道实现单测（phase: clklog-analytics-alert-channels-v1）。
 *
 * 覆盖「最容易写错且最贵」的几处：钉钉加签、飞书业务错误码、长度截断、通用 Webhook 模板、
 * 加解密与掩码、限流与合并。都不打真实网络。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    alerting: {
      smtp: { host: '', port: 465, user: '', pass: '', from: '', secure: true },
      sms: { secretId: '', secretKey: '', sdkAppId: '', signName: '', templateId: '', region: 'ap-guangzhou' },
    },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { createHmac } from 'crypto';
import {
  dingtalkSignedUrl,
  feishuSignature,
  validateDingtalk,
} from '../../src/modules/alerting/channels/senders/sender-chat-webhook';
import { jsonEscapeText, renderBodyTemplate, validateGenericWebhook } from '../../src/modules/alerting/channels/senders/sender-generic-webhook';
import { validateTelegram } from '../../src/modules/alerting/channels/senders/sender-telegram';
import { validateEmailContact } from '../../src/modules/alerting/channels/senders/sender-email';
import { smsSummary, validateSmsContact } from '../../src/modules/alerting/channels/senders/sender-sms';
import { templateParams, validateWhatsApp } from '../../src/modules/alerting/channels/senders/sender-whatsapp';
import { clampText } from '../../src/modules/alerting/channels/http';
import { decryptSecret, encryptSecret, maskSecret } from '../../src/modules/alerting/channels/channel-crypto';
import { ChannelDispatcher, buildDigestText } from '../../src/modules/alerting/channels/channel-rate-limiter';
import { CHANNELS, CHANNEL_KEYS, channelsByGroup } from '../../src/modules/alerting/channels/channel-registry';
import { CONFIG_CHANNELS } from '../../src/modules/alerting/channels/channel-registry';
import { CONFIG_SCHEMAS, validateConfigInput } from '../../src/modules/alerting/channels/channel-config-schema';
import { AlertChannelConfigService } from '../../src/modules/alerting/channels/channel-config.service';
import type { SendContext } from '../../src/modules/alerting/channels/channel-types';
import { PreviewTemplateDto } from '../../src/modules/alerting/dto/alerting.dto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

const CTX = {
  contact: { kind: 'webhook', webhook_url: 'https://example.com/hook', address: '', options: {} },
  text: '【警告】慢查询次数突增',
  subject: '主题',
  vars: { rule_name: '慢查询次数突增', status: '触发', value: '42', unit: '次', project: 'clklogapp' },
  readConfig: async () => null,
};

describe('飞书加签（与钉钉互为镜像：别抄错）', () => {
  it('签名字符串当 key、对空串 HmacSHA256、Base64；时间戳为秒', () => {
    // 期望值由官方文档算法用 Python hmac/hashlib 独立算出（两套实现互证）
    expect(feishuSignature('demo-secret-abc', '1599360473')).toBe(
      '+Gk9cV/0R/yNAnWHidIKYJHRaQYGiozmDW9M48JsoVo=',
    );
  });

  it('钉钉与飞书的构造互不相同（key/msg 互换，混用必然被厂商拒）', () => {
    const secret = 'SECabcdef0123456789';
    const timestamp = '1758000000';
    const dingtalkStyle = createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(Buffer.from(`${timestamp}\n${secret}`, 'utf8'))
      .digest('base64');
    expect(feishuSignature(secret, timestamp)).not.toBe(dingtalkStyle);
  });

  it('换密钥或换时间戳签名都会变；结果是 32 字节的 base64', () => {
    const base = feishuSignature('demo-secret-abc', '1599360473');
    expect(feishuSignature('other-secret-abc', '1599360473')).not.toBe(base);
    expect(feishuSignature('demo-secret-abc', '1599360474')).not.toBe(base);
    expect(Buffer.from(base, 'base64')).toHaveLength(32);
  });
});

describe('钉钉加签（官方算法 + 两个权威实现交叉确认）', () => {
  it('timestamp 毫秒 + \\n + secret 做 HmacSHA256 → base64 → URL 编码', () => {
    const secret = 'SECabcdef0123456789';
    const now = 1758000000000;
    const url = dingtalkSignedUrl('https://oapi.dingtalk.com/robot/send?access_token=abc', secret, now);

    const expected = createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(Buffer.from(`${now}\n${secret}`, 'utf8'))
      .digest('base64');
    expect(url).toContain(`timestamp=${now}`);
    expect(url).toContain(`sign=${encodeURIComponent(expected)}`);
    expect(url).toContain('access_token=abc&timestamp=');
  });

  it('已有查询串时用 & 追加（不覆盖既有参数）', () => {
    const url = dingtalkSignedUrl('https://oapi.dingtalk.com/robot/send?access_token=t', 'SEC12345678', 1);
    expect(url.split('&')[0]).toContain('access_token=t');
  });

  it('联系人校验：URL 形态 + 加签密钥长度', () => {
    expect(validateDingtalk({ kind: 'dingtalk', webhook_url: '', address: '', options: {} })?.message).toContain(
      'Webhook',
    );
    expect(
      validateDingtalk({
        kind: 'dingtalk',
        webhook_url: 'https://example.com/hook',
        address: '',
        options: {},
      })?.message,
    ).toContain('钉钉机器人');
    expect(
      validateDingtalk({
        kind: 'dingtalk',
        webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=x',
        address: '',
        options: { secret: 'short' },
      })?.message,
    ).toContain('过短');
    expect(
      validateDingtalk({
        kind: 'dingtalk',
        webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=x',
        address: '',
        options: { secret: 'SEC0123456789abcdef' },
      }),
    ).toBeNull();
  });
});

describe('通用 Webhook（body 模板）', () => {
  it('默认模板输出 JSON 且正文被转义', () => {
    const body = renderBodyTemplate('', {
      ...CTX,
      text: '第一行\n第二行 "引号"',
    } as Parameters<typeof renderBodyTemplate>[1]);
    expect(JSON.parse(body)).toEqual({ text: '第一行\n第二行 "引号"' });
  });

  it('自定义模板可用 {{.text}} 与 {{.text_json}} 组合', () => {
    const body = renderBodyTemplate('{"msg":"{{.rule_name}}: {{.text_json}}"}', {
      ...CTX,
      text: 'a"b',
    } as Parameters<typeof renderBodyTemplate>[1]);
    expect(JSON.parse(body)).toEqual({ msg: '慢查询次数突增: a\"b' });
  });

  it('模板语法错误在保存联系人时被拦下', () => {
    expect(
      validateGenericWebhook({
        kind: 'webhook',
        webhook_url: 'https://example.com/hook',
        address: '',
        options: { body_template: '{{if eq .a "b"}}未闭合' },
      })?.message,
    ).toContain('body 模板语法错误');
  });

  it('请求头必须是合法 JSON', () => {
    expect(
      validateGenericWebhook({
        kind: 'webhook',
        webhook_url: 'https://example.com/hook',
        address: '',
        options: { headers: '{not json' },
      })?.message,
    ).toContain('请求头');
  });

  it('jsonEscapeText 不含外层引号', () => {
    expect(jsonEscapeText('a"b')).toBe('a\\"b');
  });
});

describe('其它通道的联系人校验与截断', () => {
  it('Telegram 需要数字 chat_id', () => {
    expect(
      validateTelegram({ kind: 'telegram', webhook_url: '', address: 'abc', options: {} })?.message,
    ).toContain('chat_id');
    expect(validateTelegram({ kind: 'telegram', webhook_url: '', address: '-1001234567890', options: {} })).toBeNull();
  });

  it('邮件 / 短信 / WhatsApp 校验', () => {
    expect(validateEmailContact({ kind: 'email', webhook_url: '', address: 'bad', options: {} })?.message).toContain(
      '格式',
    );
    expect(validateEmailContact({ kind: 'email', webhook_url: '', address: 'a@b.com', options: {} })).toBeNull();
    expect(validateSmsContact({ kind: 'sms', webhook_url: '', address: '13800138000', options: {} })).toBeNull();
    expect(
      validateSmsContact({ kind: 'sms', webhook_url: '', address: '13800138000', options: { provider: 'sms_foo' } })
        ?.message,
    ).toContain('厂商');
    expect(validateWhatsApp({ kind: 'whatsapp', webhook_url: '', address: '8613800138000', options: {} })).toBeNull();
  });


  it('短信摘要只取首行并截断 40 字', () => {
    expect(smsSummary('【警告】触发 规则名\n当前值：42次', 40)).toBe('【警告】触发 规则名');
    expect(smsSummary('x'.repeat(80), 40)).toHaveLength(40);
  });

  it('WhatsApp 模板参数顺序固定（规则/当前值/条件/项目）', () => {
    const params = templateParams(
      { status: '触发', rule_name: '规则', value: '42', unit: '次', comparator_fmt: '大于', threshold: '10', project: 'clklogapp' },
      4,
    );
    expect(params).toEqual(['触发 规则', '42次', '大于 10次', 'clklogapp']);
    expect(templateParams({ rule_name: 'x' }, 9)).toHaveLength(4);
  });

  it('长度截断保留尾部提示', () => {
    const clamped = clampText('a'.repeat(100), 20);
    expect(clamped).toHaveLength(20);
    expect(clamped.endsWith('（已截断）')).toBe(true);
  });
});

describe('凭证加密与掩码', () => {
  const key = Buffer.alloc(32, 7);

  it('加解密往返一致，且同一明文两次密文不同（随机 IV）', () => {
    const first = encryptSecret('super-secret', key);
    const second = encryptSecret('super-secret', key);
    expect(first).not.toBe(second);
    expect(decryptSecret(first, key)).toBe('super-secret');
    expect(first.split(':')).toHaveLength(4);
    expect(first.startsWith('v1:')).toBe(true);
  });

  it('换密钥解密失败（GCM 认证标签生效）', () => {
    const cipher = encryptSecret('x', key);
    expect(() => decryptSecret(cipher, Buffer.alloc(32, 9))).toThrow();
  });

  it('掩码只留末 4 位', () => {
    expect(maskSecret('abcdefghijkl')).toBe('••••ijkl');
    expect(maskSecret('short')).toBe('••••');
    expect(maskSecret('')).toBe('（未配置）');
  });
});

describe('限流与合并', () => {
  it('间隔生效：三条依次发送，起始时刻拉开', async () => {
    const sent: number[] = [];
    let now = 0;
    const dispatcher = new ChannelDispatcher({
      mergeThreshold: 10,
      coalesceMs: 0,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });
    for (let i = 0; i < 3; i += 1) {
      dispatcher.dispatch('dingtalk', 20, {
        ruleName: `r${i}`,
        text: `t${i}`,
        send: async () => {
          sent.push(now);
        },
        done: () => undefined,
      });
    }
    await dispatcher.idle('dingtalk');
    expect(sent).toHaveLength(3);
    // 20/分钟 → 3000ms 间隔
    expect(sent[1] - sent[0]).toBeGreaterThanOrEqual(3000);
    expect(sent[2] - sent[1]).toBeGreaterThanOrEqual(3000);
  });

  it('积压达到阈值时合并成一条摘要', async () => {
    const messages: string[] = [];
    let now = 0;
    const dispatcher = new ChannelDispatcher({
      mergeThreshold: 3,
      coalesceMs: 0,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });
    const done = jest.fn();
    for (let i = 0; i < 5; i += 1) {
      dispatcher.dispatch('wecom', 20, {
        ruleName: `规则${i}`,
        text: `正文${i}`,
        send: async (text) => {
          messages.push(text);
        },
        done,
      });
    }
    await dispatcher.idle('wecom');
    // 首条在 drain 启动时已单独发出，其余 4 条被合并为一条摘要
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe('正文0');
    expect(messages[1]).toContain('本轮 4 条告警');
    expect(messages[1]).toContain('规则4');
    expect(done).toHaveBeenCalledTimes(5);
    expect(done).toHaveBeenCalledWith(true);
  });

  it('摘要文本列出前 N 条规则名与剩余数量', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      ruleName: `规则${i}`,
      text: '',
      send: async () => undefined,
      done: () => undefined,
    }));
    const text = buildDigestText(items, 5);
    expect(text).toContain('本轮 8 条告警');
    expect(text).toContain('规则0');
    expect(text).toContain('另有 3 条');
  });

  it('发送失败时回调收到错误（不吞异常）', async () => {
    const dispatcher = new ChannelDispatcher({ mergeThreshold: 10, coalesceMs: 0, sleep: async () => undefined });
    const done = jest.fn();
    dispatcher.dispatch('feishu_webhook', 60, {
      ruleName: 'r',
      text: 't',
      send: async () => {
        throw new Error('feishu_http_400');
      },
      done,
    });
    await dispatcher.idle('feishu_webhook');
    expect(done).toHaveBeenCalledWith(false, expect.objectContaining({ message: 'feishu_http_400' }));
  });
});

describe('通道注册表完整性', () => {
  it('每个通道都有 label / group / 校验 / 发送实现与正限流', () => {
    for (const key of CHANNEL_KEYS) {
      const descriptor = CHANNELS[key];
      expect(descriptor.key).toBe(key);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(['chat', 'email', 'sms']).toContain(descriptor.group);
      expect(descriptor.ratePerMinute).toBeGreaterThan(0);
      expect(typeof descriptor.validateContact).toBe('function');
      expect(typeof descriptor.send).toBe('function');
      expect(descriptor.contactFields.length).toBeGreaterThan(0);
    }
  });

  it('覆盖 PRD 首发清单（增补 v1.2 已删 Slack/Discord/Teams/ntfy/Gotify）', () => {
    for (const key of [
      'feishu_webhook',
      'dingtalk',
      'wecom',
      'telegram',
      'webhook',
      'email',
      'sms',
      'whatsapp',
    ]) {
      expect(CHANNEL_KEYS).toContain(key);
    }
  });

  it('钉钉/企微/Telegram 限流取官方 20 条/分钟', () => {
    expect(CHANNELS.dingtalk.ratePerMinute).toBe(20);
    expect(CHANNELS.wecom.ratePerMinute).toBe(20);
    expect(CHANNELS.telegram.ratePerMinute).toBe(20);
  });

  it('通道组与配置 schema 都能被前端消费', () => {
    const groups = channelsByGroup();
    expect(groups.map((item) => item.group)).toEqual(['chat', 'email', 'sms']);
    expect(groups[0].channels.length).toBeGreaterThan(5);
    for (const key of CONFIG_CHANNELS) {
      expect(CONFIG_SCHEMAS[key]).toBeDefined();
      expect(CONFIG_SCHEMAS[key].fields.length + CONFIG_SCHEMAS[key].secretFields.length).toBeGreaterThan(0);
    }
  });
});

/**
 * 回归：模板通道改「通道组」后，DTO 的 @IsIn 白名单没跟着改，
 * 预览/保存会被 400 拦下（`channel must be one of … feishu_webhook, email, sms`）——用户实测报过。
 */
describe('模板 DTO 的通道组白名单', () => {
  const build = (channel: string) =>
    plainToInstance(PreviewTemplateDto, { kind: 'fire', channel, body: '【测试】' });

  it('接受通道组 chat / email / sms', () => {
    for (const channel of ['chat', 'email', 'sms']) {
      expect(validateSync(build(channel))).toHaveLength(0);
    }
  });

  it('不再接受旧的具体通道名（避免与「通道组」语义混淆）', () => {
    for (const channel of ['feishu_webhook', 'dingtalk', 'telegram']) {
      expect(validateSync(build(channel)).length).toBeGreaterThan(0);
    }
  });
});

/**
 * 通道测试消息本地化（i18n v1）：正文 / 通道名 / 变量 / detail 都按**操作者**语言渲染，
 * 中文逐字不变（与迁移前的硬编码文案一致）。
 */
describe('通道测试消息本地化（i18n v1）', () => {
  const service = () =>
    new AlertChannelConfigService(
      { alertChannelConfig: { findUnique: async () => null } } as never,
      { write: async () => undefined } as never,
    );

  it('中文逐字不变；英文正文、通道名、变量与 detail 全英文', async () => {
    const original = CHANNELS.webhook.send;
    const sent: SendContext[] = [];
    CHANNELS.webhook.send = (async (ctx: SendContext) => {
      sent.push(ctx);
    }) as unknown as typeof CHANNELS.webhook.send;
    try {
      const target = { webhook_url: 'https://example.com/hook' };

      const zhResult = await service().test('webhook', target, 'admin', 'zh-CN');
      const zhCtx = sent[0];
      expect(zhCtx.text).toMatch(/^【测试】ClkLog 告警通道连通性测试\n通道：通用 Webhook\n时间：/);
      expect(zhCtx.subject).toBe('ClkLog 告警通道测试（通用 Webhook）');
      expect(zhCtx.vars).toMatchObject({
        rule_name: '通道连通性测试',
        status: '触发',
        status_code: 'fire',
        level_fmt: '提示',
        unit: '次',
      });
      expect(zhResult).toEqual({ ok: true, detail: '已发出测试消息' });

      const enResult = await service().test('webhook', target, 'admin', 'en-US');
      const enCtx = sent[1];
      expect(enCtx.text).toMatch(/^\[Test\] ClkLog alert channel connectivity test\nChannel: Generic Webhook\nTime: /);
      expect(enCtx.subject).toBe('ClkLog alert channel test (Generic Webhook)');
      expect(enCtx.vars).toMatchObject({
        rule_name: 'Channel connectivity test',
        status: 'Triggered',
        status_code: 'fire',
        level_fmt: 'Info',
        unit: 'times',
      });
      expect(enResult).toEqual({ ok: true, detail: 'Test message sent' });
      expect(JSON.stringify({ ...enCtx, readConfig: undefined })).not.toMatch(/[\u4e00-\u9fff]/);
    } finally {
      CHANNELS.webhook.send = original;
    }
  });

  it('未传 locale 时保持中文兜底（老调用方行为不变）', async () => {
    const original = CHANNELS.webhook.send;
    const sent: SendContext[] = [];
    CHANNELS.webhook.send = (async (ctx: SendContext) => {
      sent.push(ctx);
    }) as unknown as typeof CHANNELS.webhook.send;
    try {
      const result = await service().test('webhook', { webhook_url: 'https://example.com/hook' }, 'admin');
      expect(sent[0].text).toContain('通道：通用 Webhook');
      expect(result.detail).toBe('已发出测试消息');
    } finally {
      CHANNELS.webhook.send = original;
    }
  });
});

/**
 * 表头「?」的逐步配置方法（2026-10-09 追加）：
 * 只有「漏一步就报错、而报错看不出所以然」的通道才写 help；中文兜底与资源键必须成对，
 * 否则前端要么不显示「?」，要么 13 门语言里漏文案。
 */
describe('通道配置帮助（channelConfig help）', () => {
  it('help 与 help_key 成对出现（缺一即视为配置错误）', () => {
    const unpaired = Object.entries(CONFIG_SCHEMAS)
      .filter(([, schema]) => Boolean(schema.help) !== Boolean(schema.help_key))
      .map(([key]) => key);
    expect(unpaired).toEqual([]);
  });

  it('Telegram 的帮助覆盖三个真实坑：点 START、chat not found、群聊隐私模式', () => {
    const help = CONFIG_SCHEMAS.telegram.help ?? '';
    expect(help).toContain('START'); // 机器人不能主动发起会话
    expect(help).toContain('chat not found'); // 漏做上一步的真实报错原文
    expect(help).toContain('/setprivacy'); // 群聊收不到消息的解法
    expect(help.split('\n')).toHaveLength(3); // 三步：准备 / 填写 / 验证
  });

  it('AC-6 增补 v1.1：7 个凭证级通道都有「?」，且都是「准备 / 填写 / 验证」三步（Telegram 四步）', () => {
    for (const channel of CONFIG_CHANNELS) {
      const help = CONFIG_SCHEMAS[channel]?.help ?? '';
      const lines = help.split('\n').filter(Boolean);
      expect({ channel, lines: lines.length }).toEqual({ channel, lines: 3 });
      expect(help).toMatch(/(准备|Prepare|Vorbereitung|Préparation|準備|준비|Preparación|Preparação|Подготовка|Chuẩn bị|เตรียม|Persiapan)/);
      expect(help).toMatch(/(验证|Verify|Prüfen|Vérification|検証|검증|Verificar|Проверка|Kiểm tra|ตรวจสอบ|Verifikasi)/);
      expect(CONFIG_SCHEMAS[channel]?.help_key).toBeTruthy();
    }
  });
});

/**
 * 校验失败的结构化负载（i18n v1 补交）：
 * message 中文逐字不变（老客户端兜底），message_key + params 供前端按当前语言渲染；
 * 字段名以 `field`（中文）+ `field_key`（资源键）成对下发，前端 resolveParamKeys 解析。
 */
describe('校验失败的结构化负载（i18n v1）', () => {
  const configService = () =>
    new AlertChannelConfigService(
      { alertChannelConfig: { findUnique: async () => null } } as never,
      { write: async () => undefined } as never,
    );

  it('validateConfigInput：中文逐字 + 结构化 message_key/params', () => {
    const required = validateConfigInput('smtp', { port: 465 }, {}, false);
    expect(required?.message).toBe('请填写「SMTP 服务器」');
    expect(required?.message_key).toBe('alerting:error.validate.required');
    expect(required?.params).toEqual({
      field: 'SMTP 服务器',
      field_key: 'alerting:channelConfig.smtp.field.host',
    });

    const notNumber = validateConfigInput('smtp', { host: 'smtp.example.com', port: 'abc' }, {}, false);
    expect(notNumber?.message).toBe('「端口」必须是数字');
    expect(notNumber?.message_key).toBe('alerting:error.validate.number');

    expect(validateConfigInput('telegram', { api_base: 'api.telegram.org' }, { bot_token: 't' }, false)).toMatchObject({
      message: 'API 地址必须以 http(s):// 开头',
      message_key: 'alerting:error.validate.apiBaseHttp',
    });
    expect(validateConfigInput('smtp', { host: 'h', port: 70000 }, {}, false)).toMatchObject({
      message: '端口范围应为 1~65535',
      message_key: 'alerting:error.validate.portRange',
    });
    expect(
      validateConfigInput('smtp', { host: 'h', port: 465, user: 'u', from: 'bad' }, { pass: 'x' }, false),
    ).toMatchObject({
      message: '发件人格式不正确（可写 name <mail@example.com>）',
      message_key: 'alerting:error.validate.fromFormat',
    });
  });

  it('save 校验失败 → 400 DomainError（messageKey/params 已填，前端零改动即可本地化）', async () => {
    const error = await configService()
      .save('smtp', { config: { port: 465 } }, 'admin')
      .then(
        () => {
          throw new Error('save 应当被 400 拦下');
        },
        (err: unknown) => err as Record<string, unknown> & { getStatus: () => number },
      );

    expect(error.getStatus()).toBe(400);
    expect(error.errorCode).toBe('alerting.channelConfig.invalid');
    expect(error.messageKey).toBe('alerting:error.validate.required');
    expect(error.params).toEqual({
      field: 'SMTP 服务器',
      field_key: 'alerting:channelConfig.smtp.field.host',
    });
    expect(error.message).toBe('请填写「SMTP 服务器」');
  });

  it('发送测试的目标校验失败 → error 仍是中文原文，另带 error_key/error_params（加法式）', async () => {
    const result = await configService().test('telegram', { chat_id: 'abc' }, 'admin', 'en-US');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('chat_id 应为数字（群 ID 以 -100 开头）');
    expect(result.error_key).toBe('alerting:error.validate.telegramChatIdFormat');
    expect(result.detail).toBe('Target validation failed');
  });
});
