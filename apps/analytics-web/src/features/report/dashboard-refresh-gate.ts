/** 看板多卡同时 refresh 会打满 ClickHouse；同页最多并行 2 路。 */
export function createRefreshGate(limit = 2) {
  let active = 0;
  const waiting: Array<() => void> = [];

  const pump = () => {
    while (active < limit && waiting.length > 0) {
      waiting.shift()?.();
    }
  };

  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            pump();
          });
      };
      if (active < limit) start();
      else waiting.push(start);
    });
  };
}
