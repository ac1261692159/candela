import * as crypto from 'crypto';

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function crcForEvent(jsonString: string): string {
  return sha256(jsonString);
}
