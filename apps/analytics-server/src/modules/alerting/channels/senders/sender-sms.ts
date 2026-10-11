import type { ContactTarget, SendContext, ValidationIssue } from '../channel-types';
import { validationIssue } from '../validation-issue';

/**
 * 短信通道（phase: clklog-analytics-alert-channels-v1）。
 *
 * 全部走**厂商官方 SDK**（签名算法交给 SDK，仓库里不再有手写的 TC3/V3 实现）：
 * 阿里云 `@alicloud/dysmsapi20170525`、腾讯云 `tencentcloud-sdk-nodejs-sms`、
 * AWS `@aws-sdk/client-sns`、Twilio `twilio`。
 *
 * ⚠️ 模板类通道（阿里云/腾讯云）的签名与模板必须先在控制台报备审核；
 * 短信正文受模板约束，这里只传「一行摘要」作为模板变量。
 */

export type SmsProviderKey = 'sms_aliyun' | 'sms_tencent' | 'sms_aws' | 'sms_twilio';

/** 短信只发一行摘要（模板变量有长度限制；详细内容看平台） */
export function smsSummary(text: string, max = 40): string {
  const line = text.split('\n').find((item) => item.trim()) ?? text;
  return line.replace(/\s+/g, ' ').trim().slice(0, max);
}

function requireString(source: Record<string, unknown>, key: string, label: string): string {
  const value = String(source[key] ?? '').trim();
  if (!value) throw new Error(`${label}_missing`);
  return value;
}

/* ------------------------------- 阿里云 ------------------------------- */

export async function sendAliyunSms(
  config: Record<string, unknown>,
  secret: Record<string, unknown>,
  mobile: string,
  summary: string,
): Promise<void> {
  const { default: Dysmsapi, SendSmsRequest } = await import('@alicloud/dysmsapi20170525');
  const { Config } = await import('@alicloud/openapi-client');
  const client = new Dysmsapi(
    new Config({
      accessKeyId: requireString(secret, 'access_key_id', 'aliyun_access_key_id'),
      accessKeySecret: requireString(secret, 'access_key_secret', 'aliyun_access_key_secret'),
      endpoint: String(config.endpoint ?? 'dysmsapi.aliyuncs.com'),
    }),
  );
  const response = await client.sendSms(
    new SendSmsRequest({
      phoneNumbers: mobile,
      signName: requireString(config, 'sign_name', 'aliyun_sign_name'),
      templateCode: requireString(config, 'template_code', 'aliyun_template_code'),
      templateParam: JSON.stringify({ code: summary }),
    }),
  );
  const body = response.body as { code?: string; message?: string } | undefined;
  if (body?.code && body.code !== 'OK') throw new Error(`aliyun_${body.code}(${body.message ?? ''})`);
}

/* ------------------------------- 腾讯云 ------------------------------- */

export async function sendTencentSms(
  config: Record<string, unknown>,
  secret: Record<string, unknown>,
  mobile: string,
  summary: string,
): Promise<void> {
  const tencentcloud = await import('tencentcloud-sdk-nodejs-sms');
  const SmsClient = tencentcloud.sms.v20210111.Client;
  const client = new SmsClient({
    credential: {
      secretId: requireString(secret, 'secret_id', 'tencent_secret_id'),
      secretKey: requireString(secret, 'secret_key', 'tencent_secret_key'),
    },
    region: String(config.region ?? 'ap-guangzhou'),
    profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com' } },
  });
  const response = (await client.SendSms({
    PhoneNumberSet: [mobile.startsWith('+') ? mobile : `+86${mobile}`],
    SmsSdkAppId: requireString(config, 'sdk_app_id', 'tencent_sdk_app_id'),
    SignName: requireString(config, 'sign_name', 'tencent_sign_name'),
    TemplateId: requireString(config, 'template_id', 'tencent_template_id'),
    TemplateParamSet: [summary],
  })) as { SendStatusSet?: { Code?: string; Message?: string }[] };
  const status = response.SendStatusSet?.[0];
  if (status?.Code && status.Code !== 'Ok') throw new Error(`tencent_${status.Code}(${status.Message ?? ''})`);
}

/* -------------------------------- AWS -------------------------------- */

export async function sendAwsSms(
  config: Record<string, unknown>,
  secret: Record<string, unknown>,
  mobile: string,
  summary: string,
): Promise<void> {
  const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');
  const client = new SNSClient({
    region: requireString(config, 'region', 'aws_region'),
    credentials: {
      accessKeyId: requireString(secret, 'access_key_id', 'aws_access_key_id'),
      secretAccessKey: requireString(secret, 'secret_access_key', 'aws_access_key_secret'),
    },
  });
  try {
    await client.send(
      new PublishCommand({
        PhoneNumber: mobile.startsWith('+') ? mobile : `+86${mobile}`,
        Message: summary,
        ...(config.sender_id ? { MessageAttributes: {} } : {}),
      }),
    );
  } finally {
    client.destroy();
  }
}

/* ------------------------------- Twilio ------------------------------- */

export async function sendTwilioSms(
  config: Record<string, unknown>,
  secret: Record<string, unknown>,
  mobile: string,
  summary: string,
): Promise<void> {
  const twilio = (await import('twilio')).default;
  const client = twilio(
    requireString(secret, 'account_sid', 'twilio_account_sid'),
    requireString(secret, 'auth_token', 'twilio_auth_token'),
  );
  await client.messages.create({
    from: requireString(config, 'from_number', 'twilio_from_number'),
    to: mobile.startsWith('+') ? mobile : `+86${mobile}`,
    body: summary,
  });
}

/* ------------------------------ 分派与校验 ----------------------------- */

export async function sendSms(
  provider: SmsProviderKey,
  config: Record<string, unknown>,
  secret: Record<string, unknown>,
  mobile: string,
  summary: string,
): Promise<void> {
  switch (provider) {
    case 'sms_aliyun':
      return sendAliyunSms(config, secret, mobile, summary);
    case 'sms_tencent':
      return sendTencentSms(config, secret, mobile, summary);
    case 'sms_aws':
      return sendAwsSms(config, secret, mobile, summary);
    case 'sms_twilio':
      return sendTwilioSms(config, secret, mobile, summary);
    default:
      throw new Error(`unknown_sms_provider_${String(provider)}`);
  }
}

export async function sendSmsFromContext(
  ctx: SendContext,
  preferred: SmsProviderKey = 'sms_tencent',
): Promise<void> {
  const override = typeof ctx.contact.options?.provider === 'string' ? ctx.contact.options.provider : '';
  const order: SmsProviderKey[] = [
    ...(override ? [override as SmsProviderKey] : []),
    preferred,
    'sms_aliyun',
    'sms_tencent',
    'sms_aws',
    'sms_twilio',
  ];
  const tried = new Set<SmsProviderKey>();
  for (const candidate of order) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    const config = await ctx.readConfig(candidate);
    // 被暂停的厂商不参与挑选（联系人显式指定它时也不发，避免「暂停了还在扣费」）
    if (!config?.enabled || config.muted) continue;
    await sendSms(candidate, config.config, config.secret, ctx.contact.address.trim(), smsSummary(ctx.text));
    return;
  }
  throw new Error(override ? `${override}_not_configured` : 'sms_provider_not_configured');
}

export function validateSmsContact(contact: ContactTarget): ValidationIssue | null {
  const mobile = (contact.address ?? '').replace(/[\s-]/g, '');
  if (!mobile) return validationIssue('请填写接收手机号', 'alerting:error.validate.smsRequired');
  if (!/^(\+?\d{6,20})$/.test(mobile)) {
    return validationIssue(
      '手机号格式不正确（建议带国家码，如 +8613800138000）',
      'alerting:error.validate.smsFormat',
    );
  }
  const override = typeof contact.options?.provider === 'string' ? contact.options.provider : '';
  const allowed: SmsProviderKey[] = ['sms_aliyun', 'sms_tencent', 'sms_aws', 'sms_twilio'];
  if (override && !allowed.includes(override as SmsProviderKey)) {
    return validationIssue(
      `短信厂商无效（可选：${allowed.join(' / ')}）`,
      'alerting:error.validate.smsProvider',
      { allowed: allowed.join(' / ') },
    );
  }
  return null;
}
