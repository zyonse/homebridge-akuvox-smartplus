const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const {
  default: AkuvoxAPI,
  AkuvoxAuthError,
  AkuvoxApiError,
  beginEmailLogin,
  caesarShift,
  doubleMd5,
  obfuscatePhoneNumber,
  parseDoorRelays,
  resolveHost,
  unwrapResponse,
} = require('../dist/AkuvoxAPI');
const { fakeFetch, silentLog } = require('./helpers/fakeFetch');

const credentials = () => ({
  subdomain: 'ucloud',
  host: 'ucloud.akuvox.com:8443',
  authToken: 'auth-1',
  token: 'token-1',
});

test('login value encodings match the SmartPlus app', () => {
  assert.equal(obfuscatePhoneNumber('+1 (555) 789-0123'), '48880123456');
  assert.equal(caesarShift('Zoe.xyz@Mail.com'), 'Crh.abc@Pdlo.frp');
  assert.equal(caesarShift('user79', true), 'xvhu02');
  const md5 = (value) => createHash('md5').update(value).digest('hex');
  assert.equal(doubleMd5('hunter2'), md5(md5('hunter2')));
  assert.equal(resolveHost('https://subdomain.akuvox.com:8443/', 'ucloud'), 'ucloud.akuvox.com:8443');
});

test('unwrapResponse handles each SmartPlus envelope', () => {
  assert.deepEqual(unwrapResponse({ result: 0, datas: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrapResponse({ err_code: '0', datas: { b: 2 } }), { b: 2 });
  assert.deepEqual(unwrapResponse({ code: 0, data: [1] }), [1]);
  assert.throws(() => unwrapResponse({ result: 1, message: 'Username or passwd error' }), AkuvoxAuthError);
  assert.throws(() => unwrapResponse({ code: 2 }), AkuvoxAuthError);
  assert.throws(() => unwrapResponse({ result: 5, message: 'Relay offline' }), (error) =>
    error instanceof AkuvoxApiError && !(error instanceof AkuvoxAuthError) && error.kind === 'rejected');
});

test('parseDoorRelays builds one entry per relay and skips malformed devices', () => {
  const relays = parseDoorRelays({
    dev_list: [
      { location: 'Garage Gate', mac: 'AABBCC', relay: [{ relay_id: 0, door_name: 'Garage' }, { relay_id: 1 }] },
      { location: 'No relays', mac: 'DDEEFF' },
      { location: '', mac: '112233', relay: [{ relay_id: 0 }] },
      { location: 'Lobby', mac: '445566', relay: [null, { door_name: 'missing id' }, { relay_id: '2', door_name: 'Lobby Door' }] },
    ],
  });
  assert.deepEqual(relays, [
    { id: 'AABBCC:0', deviceName: 'Garage Gate', doorName: 'Garage', mac: 'AABBCC', relayId: '0' },
    { id: 'AABBCC:1', deviceName: 'Garage Gate', doorName: 'Garage Gate', mac: 'AABBCC', relayId: '1' },
    { id: '445566:2', deviceName: 'Lobby', doorName: 'Lobby Door', mac: '445566', relayId: '2' },
  ]);
  assert.deepEqual(parseDoorRelays(null), []);
});

test('openDoor posts the relay with the current token', async () => {
  const fetchFn = fakeFetch([{ match: (call) => call.url.includes('/opendoor'), reply: { json: { result: 0 } } }]);
  const api = new AkuvoxAPI(credentials(), silentLog, undefined, fetchFn);
  await api.openDoor({ mac: 'AABBCC', relayId: '1' });

  const [call] = fetchFn.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://ucloud.akuvox.com:8443/opendoor?token=token-1');
  assert.equal(call.headers['X-AUTH-TOKEN'], 'token-1');
  assert.equal(call.body, 'mac=AABBCC&relay=1');
});

test('an expired session is refreshed once, persisted, and the request retried', async () => {
  const saved = [];
  const fetchFn = fakeFetch([
    {
      match: (call) => call.url.includes('/opendoor'),
      reply: (call) => (call.url.endsWith('token-1') ? { status: 401 } : { json: { result: 0 } }),
    },
    {
      match: (call) => call.url === 'https://gate.ucloud.akuvox.com:8600/refresh_token',
      reply: { json: { err_code: 0, datas: { token: 'token-2' } } },
    },
  ]);
  const api = new AkuvoxAPI(credentials(), silentLog, (updated) => saved.push(updated), fetchFn);

  // Concurrent presses must share a single refresh
  await Promise.all([api.openDoor({ mac: 'A', relayId: '0' }), api.openDoor({ mac: 'B', relayId: '0' })]);

  const refreshes = fetchFn.calls.filter((call) => call.url.endsWith('/refresh_token'));
  assert.equal(refreshes.length, 1);
  assert.deepEqual(JSON.parse(refreshes[0].body), { auth_token: 'auth-1' });
  assert.equal(refreshes[0].headers['x-auth-token'], 'token-1');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].token, 'token-2');
  assert.equal(saved[0].authToken, 'auth-1');
  assert.ok(saved[0].refreshedAt);

  const retries = fetchFn.calls.filter((call) => call.url.endsWith('opendoor?token=token-2'));
  assert.equal(retries.length, 2);
  assert.equal(retries[0].headers['X-AUTH-TOKEN'], 'token-2');
});

test('a rejected refresh surfaces as an auth error without retrying forever', async () => {
  const fetchFn = fakeFetch([
    { match: (call) => call.url.includes('/userconf'), reply: { json: { result: 1, message: 'token invalid' } } },
    { match: (call) => call.url.endsWith('/refresh_token'), reply: { json: { err_code: 1001, message: 'expired' } } },
  ]);
  const api = new AkuvoxAPI(credentials(), silentLog, undefined, fetchFn);
  await assert.rejects(api.getDoorRelays(), AkuvoxAuthError);
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(api.currentCredentials.token, 'token-1');
});

test('non-auth failures are not treated as expired sessions', async () => {
  const fetchFn = fakeFetch([{ match: () => true, reply: { status: 500 } }]);
  const api = new AkuvoxAPI(credentials(), silentLog, undefined, fetchFn);
  await assert.rejects(api.openDoor({ mac: 'A', relayId: '0' }), (error) => error.kind === 'http');
  assert.equal(fetchFn.calls.length, 1);
});

test('beginEmailLogin builds the query like the Android app and tries each region', async () => {
  const fetchFn = fakeFetch([
    { match: (call) => call.url.startsWith('https://gate.ucloud.akuvox.com:8600/login'), reply: { json: { err_code: '1000100004', message: 'no' } } },
    {
      match: (call) => call.url.startsWith('https://gate.ecloud.akuvox.com:8600/login'),
      reply: { json: { result: 0, datas: { two_factor_auth_temp_token: 'tmp', rest_server_https: 'ecloud.akuvox.com:8443' } } },
    },
  ]);
  const result = await beginEmailLogin(' user7+hb@example.com ', 'pw', ['ucloud', 'ecloud'], fetchFn);
  assert.deepEqual(result, { subdomain: 'ecloud', host: 'ecloud.akuvox.com:8443', tempToken: 'tmp' });

  // '@' stays literal, digits are shifted, '+' is escaped so it isn't read as a space, and no id_code is sent
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(
    fetchFn.calls[0].url,
    `https://gate.ucloud.akuvox.com:8600/login?user=xvhu0%2Bke@hadpsoh.frp&passwd=${doubleMd5('pw')}`,
  );
});

test('beginEmailLogin returns credentials directly when no emailed code is needed', async () => {
  const fetchFn = fakeFetch([{
    match: (call) => call.url.includes('/login'),
    reply: { json: { result: 0, datas: { token: 't', refresh_token: 'r', rest_server_https: 'ucloud.akuvox.com:8443' } } },
  }]);
  const result = await beginEmailLogin('me@example.com', 'pw', ['ucloud'], fetchFn);
  assert.equal(result.credentials.token, 't');
  assert.equal(result.credentials.authToken, 'r');
  assert.equal(result.credentials.host, 'ucloud.akuvox.com:8443');
});
