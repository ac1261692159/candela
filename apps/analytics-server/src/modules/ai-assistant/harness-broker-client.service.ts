import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { request as httpRequest } from 'http';
import { join } from 'path';
import { WorkspacePathsService } from './workspace/workspace-paths.service';

export interface BrokerRuntimeResult {
  runtime_id: string;
  socket_path: string;
  upstream_token: string;
}

@Injectable()
export class HarnessBrokerClientService {
  constructor(private readonly paths: WorkspacePathsService) {}

  ensure(input: {
    runtime_id: string;
    user_id: string;
    project_name: string;
    workspace_id: string;
    kind: 'persistent' | 'temporary';
    capability: string;
    permission_mode: 'read-only' | 'workspace-write' | 'danger-full-access';
    /** 项目级 app 目录 host 路径（broker 会按形态校验后挂到 /workspace/app） */
    app_dir: string;
  }): Promise<BrokerRuntimeResult> {
    return this.call<BrokerRuntimeResult>('/v1/runtime/ensure', input, 90_000);
  }

  stop(runtimeId: string): Promise<{ ok: true }> {
    return this.call('/v1/runtime/stop', { runtime_id: runtimeId }, 30_000);
  }

  private async call<T>(path: string, body: unknown, timeout: number): Promise<T> {
    const socketPath = join(await this.paths.root(), 'gateway', 'control', 'broker.sock');
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise<T>((resolvePromise, reject) => {
      const request = httpRequest(
        {
          socketPath,
          path,
          method: 'POST',
          timeout,
          headers: {
            'content-type': 'application/json',
            'content-length': String(payload.byteLength),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let received = 0;
          response.on('data', (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > 1024 * 1024) {
              response.destroy(new Error('broker_response_too_large'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as T & {
                message?: string;
              };
              if ((response.statusCode ?? 500) >= 400) {
                reject(new ServiceUnavailableException(value.message ?? 'Harness Broker 拒绝请求'));
                return;
              }
              resolvePromise(value);
            } catch {
              reject(new ServiceUnavailableException('Harness Broker 返回无效响应'));
            }
          });
        },
      );
      request.on('timeout', () => request.destroy(new Error('broker_timeout')));
      request.on('error', () => reject(new ServiceUnavailableException('Harness Broker 不可用')));
      request.end(payload);
    });
  }
}
