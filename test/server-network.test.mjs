import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPublicAddress, resolvePublicAddress } from '../server-network.mjs';

test('public-address filtering accepts global IPv4 and IPv6 destinations', () => {
  for (const address of [
    '93.184.216.34',
    '1.1.1.1',
    '8.8.8.8',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
  ]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('public-address filtering denies local, mapped, special, and invalid addresses', () => {
  for (const address of [
    '127.0.0.1',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:192.168.1.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
    '64:ff9b::127.0.0.1',
    '2002:7f00:1::',
    'localhost',
    'example.com',
    'invalid',
    '',
    undefined,
  ]) {
    assert.equal(isPublicAddress(address), false, String(address));
  }
});

test('the resolver chooses a public result and requests IPv4 first for connectivity', async () => {
  const result = await resolvePublicAddress('example.com', async (hostname, options) => {
    assert.equal(hostname, 'example.com');
    assert.deepEqual(options, { all: true, order: 'ipv4first' });
    return [
      { address: '192.168.1.1', family: 4 },
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
  });
  assert.equal(result, '93.184.216.34');
});

test('IPv6-only public destinations remain usable', async () => {
  assert.equal(await resolvePublicAddress('ipv6.example', async () => [
    { address: '2606:4700:4700::1111', family: 6 },
  ]), '2606:4700:4700::1111');
});

test('DNS results containing only local or mapped private addresses are denied', async () => {
  const records = [
    { address: '127.0.0.1', family: 4 },
    { address: 'fc00::1', family: 6 },
    { address: '::ffff:127.0.0.1', family: 6 },
  ];
  await assert.rejects(resolvePublicAddress('private.example', async () => records), { code: 'EACCES' });
  await assert.rejects(resolvePublicAddress('empty.example', async () => []), { code: 'EACCES' });
});

test('DNS failures propagate without substituting an unchecked hostname', async () => {
  const error = new Error('DNS unavailable');
  error.code = 'ENOTFOUND';
  await assert.rejects(resolvePublicAddress('missing.example', async () => { throw error; }), candidate => candidate === error);
});
