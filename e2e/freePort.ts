import { createServer } from 'node:net';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
