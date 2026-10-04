import test from 'node:test';
import assert from 'node:assert/strict';
import { GAMES } from '../apps/mochii-cloud.data.js';
import { getFigureLaunchUrl, getFigureProxyUrl } from '../apps/mochii-figure.js';

test('verified Figure links translate local IDs into provider keys without changing the hosted origin or launch contract', () => {
  const mapped = GAMES.map(game => ({ game, href: getFigureLaunchUrl(game.id) })).filter(item => item.href !== null);
  assert.equal(mapped.length, 94);
  const keys = new Set();
  for (const { game, href } of mapped) {
    const url = new URL(href);
    assert.equal(url.origin, 'https://figure-cloud.figure-softwares.workers.dev', game.id);
    assert.equal(url.pathname, '/');
    assert.equal(url.username + url.password + url.hash + url.port, '');
    assert.deepEqual([...url.searchParams.keys()], ['game']);
    const key = url.searchParams.get('game');
    assert.match(key, /^[A-Za-z0-9]+$/);
    assert.notEqual(key, game.id);
    assert(!keys.has(key), `Duplicate provider mapping: ${game.id}`);
    keys.add(key);
  }
});

test('known title matches retain the exact Figure key including case', () => {
  assert.equal(getFigureLaunchUrl('117'), 'https://figure-cloud.figure-softwares.workers.dev/?game=jy0354');
  assert.equal(getFigureLaunchUrl('209'), 'https://figure-cloud.figure-softwares.workers.dev/?game=jy0108');
  assert.equal(getFigureLaunchUrl('598'), 'https://figure-cloud.figure-softwares.workers.dev/?game=dg0170');
  assert.equal(getFigureLaunchUrl('610'), 'https://figure-cloud.figure-softwares.workers.dev/?game=KJ0019');
});

test('unmapped local games and unknown IDs never receive a guessed Figure launch', () => {
  const unmatched = GAMES.filter(game => getFigureLaunchUrl(game.id) === null);
  assert.equal(unmatched.length, 12);
  for (const game of unmatched) assert.equal(getFigureLaunchUrl(game.id), null);
  for (const value of ['', '0', '999999', '017', '0117', '117 ', ' 117', 'jy0354', '__proto__', 'constructor', 'toString',
    'https://evil.example/', '//evil.example/', '117&token=forged', '117?embed=1', '../api/auto-signup', '117\n']) {
    assert.equal(getFigureLaunchUrl(value), null);
  }
});

test('Figure lookup rejects nonstrings without coercing attacker-controlled values', () => {
  const throwing = { toString() { throw new Error('Must not coerce'); }, valueOf() { throw new Error('Must not coerce'); } };
  for (const value of [undefined, null, false, true, 117, 117n, NaN, Symbol('117'), ['117'], new String('117'), throwing]) {
    assert.equal(getFigureLaunchUrl(value), null);
  }
});

test('Figure destinations are encoded only beneath a configured isolated proxy host', () => {
  const shell = 'https://monkeh.example';
  const config = { proxyOrigin: 'https://proxy.example', shellOrigins: [shell, 'https://mirror.example'] };
  for (const game of GAMES) {
    const target = getFigureLaunchUrl(game.id);
    const href = getFigureProxyUrl(game.id, config, shell);
    if (!target) { assert.equal(href, null); continue; }
    const proxy = new URL(href);
    assert.equal(proxy.origin, config.proxyOrigin);
    assert.equal(proxy.pathname, '/proxy-host.html');
    assert.equal(proxy.username + proxy.password + proxy.search, '');
    assert.equal(decodeURIComponent(proxy.hash.slice(1)), target);
    assert.equal(getFigureProxyUrl(game.id, config, 'https://mirror.example'), href);
  }
});

test('proxy configuration rejects origin confusion, credentials, remote HTTP, and missing shell approval', () => {
  const shell = 'https://monkeh.example';
  const base = { proxyOrigin: 'https://proxy.example', shellOrigins: [shell] };
  for (const config of [null, {}, [], { ...base, shellOrigins: [] }, { ...base, shellOrigins: shell },
    { ...base, shellOrigins: ['https://another-shell.example'] },
    ...[shell, 'http://proxy.example', 'https://user:password@proxy.example', 'https://proxy.example/path',
      'https://proxy.example?target=evil', 'https://proxy.example#fragment', '//proxy.example',
      'javascript:alert(1)', 'data:text/html,hello'].map(proxyOrigin => ({ ...base, proxyOrigin })),
    { ...base, proxyOrigin: 'https://mirror.example', shellOrigins: [shell, 'https://mirror.example'] }]) {
    assert.equal(getFigureProxyUrl('117', config, shell), null);
  }
  for (const origin of [undefined, null, '', 'https://monkeh.example.evil.test', 'https://user@monkeh.example', 'https://monkeh.example/path']) {
    assert.equal(getFigureProxyUrl('117', base, origin), null);
  }
  for (const id of [null, undefined, 117, 'unknown', 'MC120']) assert.equal(getFigureProxyUrl(id, base, shell), null);
});

test('local HTTP development keeps shell and proxy on separate approved loopback origins', () => {
  for (const hostname of ['localhost', '127.0.0.1']) {
    const shell = `http://${hostname}:4173`;
    const config = { proxyOrigin: `http://${hostname}:4174`, shellOrigins: [shell] };
    assert.equal(getFigureProxyUrl('117', config, shell), config.proxyOrigin + '/proxy-host.html#' + encodeURIComponent(getFigureLaunchUrl('117')));
    assert.equal(getFigureProxyUrl('117', { ...config, proxyOrigin: shell }, shell), null);
  }
  assert.equal(getFigureProxyUrl('117', { proxyOrigin: 'http://localhost:4174', shellOrigins: ['https://monkeh.example'] }, 'https://monkeh.example'), null);
});
