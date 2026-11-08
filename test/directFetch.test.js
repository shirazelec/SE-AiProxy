import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDirectInterface } from '../src/directFetch.js';

test('VPN tunnel as default route: bypass through the physical interface', () => {
  const routes = 'default dev OneXrayTun metric 1\ndefault via 192.168.1.1 dev wlo1 proto dhcp src 192.168.1.248 metric 600\n';
  assert.equal(parseDirectInterface(routes), 'wlo1');
});

test('no VPN: no bypass', () => {
  assert.equal(parseDirectInterface('default via 192.168.1.1 dev wlo1 proto dhcp metric 600\n'), null);
  assert.equal(parseDirectInterface('default via 10.0.0.1 dev eth0 metric 100\ndefault via 192.168.1.1 dev wlo1 metric 600\n'), null);
});
