import { randomInt } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList } from 'node:net';

const resolver = new Resolver({ timeout: 3_000, tries: 1 });
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(address, prefix);
}

export async function findRandomUrl(): Promise<string> {
  while (true) {
    const length = randomInt(5, 16);
    let name = '';
    for (let index = 0; index < length; index++) {
      name += randomInt(36).toString(36);
    }
    const hostname = `${name}.com`;
    let addresses: string[];
    try {
      addresses = await resolver.resolve4(hostname);
    } catch {
      continue;
    }
    const address = addresses.find((value) => !blocked.check(value));
    if (!address) continue;

    const valid = await new Promise<boolean>((resolve) => {
      // 検証したIPへ直接接続し、DNSの再解決で内部アドレスへ切り替わるのを防ぐ。
      const outgoing = request({
        hostname: address, servername: hostname, headers: { Host: hostname },
        method: 'HEAD', signal: AbortSignal.timeout(3_000),
      }, (response) => {
        response.resume();
        const status = response.statusCode ?? 0;
        resolve(status >= 200 && status < 300);
      });
      outgoing.once('error', () => resolve(false));
      outgoing.end();
    });
    if (valid) return `https://${hostname}/`;
  }
}
