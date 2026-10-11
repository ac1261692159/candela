import { isAbsolute, posix, resolve, sep } from 'path';
import { badRequest } from '../../../i18n/domain-error';

const CONTROL_PATH = '.clklog';
const MAX_PATH_BYTES = 512;
const MAX_DEPTH = 16;

export function normalizeTemplatePath(input: string): string {
  if (typeof input !== 'string') {
    throw badRequest({
      code: 'ai.template.pathNotString',
      messageKey: 'ai:error.template.pathNotString',
      message: '模板路径必须是字符串',
    });
  }
  if (input.includes('\0') || input.includes('\\') || isAbsolute(input)) {
    throw badRequest({
      code: 'ai.template.pathInvalid',
      messageKey: 'ai:error.template.pathInvalid',
      message: '模板路径无效',
    });
  }
  const normalized = posix.normalize(input.trim().replace(/^\.\//, ''));
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    Buffer.byteLength(normalized, 'utf8') > MAX_PATH_BYTES ||
    normalized.split('/').length > MAX_DEPTH
  ) {
    throw badRequest({
      code: 'ai.template.pathTooDeep',
      messageKey: 'ai:error.template.pathTooDeep',
      message: '模板路径无效或层级过深',
    });
  }
  if (normalized === CONTROL_PATH || normalized.startsWith(`${CONTROL_PATH}/`)) {
    throw badRequest({
      code: 'ai.template.pathReserved',
      messageKey: 'ai:error.template.pathReserved',
      message: '.clklog 是平台保留路径',
    });
  }
  return normalized;
}

export function resolveTemplatePath(root: string, input: string): string {
  const normalized = normalizeTemplatePath(input);
  const candidate = resolve(root, ...normalized.split('/'));
  const normalizedRoot = resolve(root);
  if (!candidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw badRequest({
      code: 'ai.template.pathOutOfBounds',
      messageKey: 'ai:error.template.pathOutOfBounds',
      message: '模板路径越界',
    });
  }
  return candidate;
}
