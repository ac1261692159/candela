import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * 通道凭证加密（phase: clklog-analytics-alert-channels-v1）。
 *
 * 格式：`<keyId>:<iv>:<tag>:<ciphertext>`（各段 base64url），AES-256-GCM。
 * keyId 用于将来轮换/接 KMS（本期主密钥来自环境变量，明文永不落库、不回显）。
 */

/** 主密钥的环境变量名（只用于提示文案；实际读取在 src/config） */
export const SECRET_KEY_ENV = 'ALERT_CONFIG_KEY';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * 解析主密钥（纯函数）：接受配置里的 base64 字符串，非法或长度不为 32 字节时返回 null。
 * 环境变量的读取统一走 `src/config/configuration.ts`（架构门禁：非配置/脚本目录不得读 env）。
 */
export function parseMasterKey(raw: string | null | undefined): Buffer | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  try {
    const key = Buffer.from(value, 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

export function generateMasterKey(): string {
  return randomBytes(32).toString('base64');
}

export function encryptSecret(plain: string, key: Buffer, keyId = 'v1'): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [keyId, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join(':');
}

export function decryptSecret(payload: string, key: Buffer): string {
  const parts = payload.split(':');
  if (parts.length !== 4) throw new Error('secret_cipher_malformed');
  const [, ivPart, tagPart, dataPart] = parts;
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * 密钥类值的掩码（用于回显与审计）：
 * - 保留末 4 位便于使用者核对，其余一律 `••••`；
 * - 长度不足 8 时全掩。
 */
export function maskSecret(plain: string | null | undefined): string {
  if (!plain) return '（未配置）';
  const value = String(plain);
  if (value.length < 8) return '••••';
  return `••••${value.slice(-4)}`;
}
