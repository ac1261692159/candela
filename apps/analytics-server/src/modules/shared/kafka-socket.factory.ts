import * as net from 'net';

/**
 * Kafka SocketFactory：本地开发时将 broker 返回的真实地址映射到本地 SSH 转发端口
 *
 * 仅当 KAFKA_LOCAL_FORWARD=true 时启用映射：
 *   broker 端口 9092 -> localhost:19092
 *   若后续 SASL/SSL 端口可用，再扩展映射。
 *
 * 服务器端直接连接原始地址。
 */

/**
 * CKafka broker 端口到本地 SSH 转发端口的映射。
 * 本地开发时 broker metadata 会返回所有 broker 的真实地址，
 * 因此必须把集群中所有 broker 端口都映射到本地。
 */
const BROKER_PORT_MAP: Record<number, number> = {
  9092: 19092,
  9093: 19093,
  9094: 19094,
  9095: 19095,
  9096: 19096,
};

const KEEP_ALIVE_DELAY = 60000;

export const localForwardedSocketFactory: any =
  ({ host, port, onConnect }: { host: string; port: number; onConnect?: () => void }) => {
    let socket: net.Socket;

    if (process.env.KAFKA_LOCAL_FORWARD === 'true') {
      const localPort = BROKER_PORT_MAP[port];
      if (localPort) {
        console.log(`[Kafka SocketFactory] ${host}:${port} -> localhost:${localPort}`);
        socket = net.connect({ host: 'localhost', port: localPort }, onConnect);
        socket.setKeepAlive(true, KEEP_ALIVE_DELAY);
        return socket;
      }
    }

    // 服务器端或未配置映射时直接连接
    socket = net.connect({ host, port }, onConnect);
    socket.setKeepAlive(true, KEEP_ALIVE_DELAY);
    return socket;
  };
