const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// homebridge 2 only exports its entry point, so load the API class from beside it
const { HomebridgeAPI } = require(path.join(path.dirname(require.resolve('homebridge')), 'api.js'));

const { AkuvoxPlatform } = require('../dist/platform');
const { fakeFetch, silentLog } = require('./helpers/fakeFetch');

const USERCONF = {
  result: 0,
  datas: {
    dev_list: [
      {
        location: 'Parking', mac: 'AABBCC', rtsp_pwd: 'cam-secret',
        relay: [{ relay_id: 0, door_name: 'Garage' }, { relay_id: 1, door_name: 'Side Gate' }],
      },
      { location: 'Lobby', mac: 'DDEEFF', relay: [{ relay_id: 0, door_name: 'Front Door' }] },
    ],
  },
};

const originalFetch = globalThis.fetch;

const LOGIN = {
  result: 0,
  datas: {
    token: 'fresh-tok', refresh_token: 'fresh-auth', rest_server_https: 'rest.ucloud.akuvox.com:8443',
    vrtsp_server: 'rtspsrv1.ucloud.akuvox.com:554',
  },
};

async function setup({
  config = {},
  userconf = { json: USERCONF },
  opendoor = { json: { result: 0 } },
  login = { json: LOGIN },
  refresh = { json: { err_code: 1, message: 'expired' } },
  credentials = true,
} = {}) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'akuvox-test-'));
  if (credentials) {
    fs.writeFileSync(path.join(storage, 'akuvox-smartplus.json'), JSON.stringify({
      subdomain: 'ucloud', host: 'ucloud.akuvox.com:8443', authToken: 'auth', token: 'tok', refreshedAt: new Date().toISOString(),
      ...(typeof credentials === 'object' ? credentials : {}),
    }));
  }
  const fetchFn = fakeFetch([
    { match: (call) => call.url.includes('/userconf'), reply: userconf },
    { match: (call) => call.url.includes('/opendoor'), reply: opendoor },
    { match: (call) => call.url.includes('/login?'), reply: login },
    { match: (call) => call.url.endsWith('/refresh_token'), reply: refresh },
  ]);
  globalThis.fetch = fetchFn;

  const api = new HomebridgeAPI();
  // Homebridge only allows setting the real storage path once per process
  Object.defineProperty(api, 'user', { value: { storagePath: () => storage } });
  const errors = [];
  const log = { ...silentLog, error: (...args) => errors.push(args.join(' ')) };
  const platform = new AkuvoxPlatform(log, { platform: 'AkuvoxSmartPlus', name: 'Akuvox', ...config }, api);
  const registered = [];
  api.on('registerPlatformAccessories', (accessories) => registered.push(...accessories));
  return { api, platform, fetchFn, registered, errors, storage };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('each relay becomes an accessory, with per-door type and hidden overrides', async (t) => {
  const { api, platform, registered, errors } = await setup({
    config: { doors: [{ name: 'side gate', hidden: true }, { name: 'Lobby', type: 'lock' }] },
  });
  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));

  assert.deepEqual(registered.map((accessory) => accessory.displayName), ['Garage', 'Front Door']);
  const [garage, front] = registered;
  assert.ok(garage.getService(api.hap.Service.GarageDoorOpener));
  assert.ok(front.getService(api.hap.Service.LockMechanism));
  assert.equal(garage.context.relay.id, 'AABBCC:0');
});

test('onlyListedDoors adds just the listed doors, and an id beats a duplicate name', async (t) => {
  const { api, platform, registered } = await setup({
    config: {
      onlyListedDoors: true,
      doors: [{ name: 'garage', type: 'switch' }, { name: 'AABBCC:0', type: 'lock' }, { name: 'Front Door' }],
    },
  });
  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));

  assert.deepEqual(registered.map((accessory) => accessory.displayName), ['Garage', 'Front Door']);
  assert.ok(registered[0].getService(api.hap.Service.LockMechanism));
  assert.ok(registered[1].getService(api.hap.Service.GarageDoorOpener));
});

test('opening the garage fires the relay, shows open, then resets to closed', async (t) => {
  const { api, platform, registered, fetchFn } = await setup({ config: { openDuration: 0.05 } });
  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));

  const { Characteristic, Service } = api.hap;
  const service = registered[0].getService(Service.GarageDoorOpener);
  await service.getCharacteristic(Characteristic.TargetDoorState).handleSetRequest(Characteristic.TargetDoorState.OPEN);

  const opens = fetchFn.calls.filter((call) => call.url.includes('/opendoor'));
  assert.equal(opens.length, 1);
  assert.equal(opens[0].body, 'mac=AABBCC&relay=0');
  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.OPEN);

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(service.getCharacteristic(Characteristic.CurrentDoorState).value, Characteristic.CurrentDoorState.CLOSED);
  assert.equal(service.getCharacteristic(Characteristic.TargetDoorState).value, Characteristic.TargetDoorState.CLOSED);
});

test('a failed relay call reports a HomeKit error and stays closed', async (t) => {
  const { api, platform, registered } = await setup({ opendoor: { status: 500 } });
  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));

  const { Characteristic, Service, HAPStatus } = api.hap;
  const service = registered[0].getService(Service.GarageDoorOpener);
  // HAP converts the thrown HapStatusError into the status code sent to HomeKit
  await assert.rejects(
    service.getCharacteristic(Characteristic.TargetDoorState).handleSetRequest(Characteristic.TargetDoorState.OPEN),
    (status) => status === HAPStatus.SERVICE_COMMUNICATION_FAILURE,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.getCharacteristic(Characteristic.TargetDoorState).value, Characteristic.TargetDoorState.CLOSED);
});

test('switch type turns itself back off', async (t) => {
  const { api, platform, registered, fetchFn } = await setup({ config: { defaultType: 'switch', openDuration: 0.05 } });
  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));

  const { Characteristic, Service } = api.hap;
  const on = registered[0].getService(Service.Switch).getCharacteristic(Characteristic.On);
  await on.handleSetRequest(true);
  assert.equal(on.value, true);
  assert.equal(fetchFn.calls.filter((call) => call.url.includes('/opendoor')).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(on.value, false);
});

test('a fetch failure keeps cached accessories instead of removing them', async (t) => {
  const { api, platform } = await setup({ userconf: { status: 503 } });
  const cached = new api.platformAccessory('Garage', api.hap.uuid.generate('AABBCC:0'));
  cached.context.relay = { id: 'AABBCC:0', deviceName: 'Parking', doorName: 'Garage', mac: 'AABBCC', relayId: '0' };
  platform.configureAccessory(cached);
  const removed = [];
  api.on('unregisterPlatformAccessories', (accessories) => removed.push(...accessories));

  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));

  assert.equal(removed.length, 0);
  assert.ok(cached.getService(api.hap.Service.GarageDoorOpener));
});

test('accessories no longer on the account are removed', async (t) => {
  const { api, platform } = await setup();
  const gone = new api.platformAccessory('Old Door', api.hap.uuid.generate('000000:9'));
  platform.configureAccessory(gone);
  const removed = [];
  api.on('unregisterPlatformAccessories', (accessories) => removed.push(...accessories));

  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));
  assert.deepEqual(removed.map((accessory) => accessory.displayName), ['Old Door']);
});

test('missing login logs the command to run', async () => {
  const { platform, errors, fetchFn } = await setup({ credentials: false });
  await platform.discoverDevices();
  assert.equal(fetchFn.calls.length, 0);
  assert.match(errors[0], /email and password in the plugin settings/);
});

const LOGIN_OPTIONS = { options: { email: 'me@example.com', password: 'hunter2', region: 'ucloud' } };
const readSaved = (storage) => JSON.parse(fs.readFileSync(path.join(storage, 'akuvox-smartplus.json'), 'utf8'));

test('signs in from the plugin settings when no session is saved', async (t) => {
  const { api, platform, registered, fetchFn, storage, errors } = await setup({ credentials: false, config: LOGIN_OPTIONS });
  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));

  assert.deepEqual(errors, []);
  assert.equal(registered.length, 3);
  const login = fetchFn.calls.find((call) => call.url.includes('/login?'));
  assert.match(login.url, /^https:\/\/gate\.ucloud\.akuvox\.com:8600\/login\?user=ph@hadpsoh\.frp&passwd=[0-9a-f]{32}$/);

  const saved = readSaved(storage);
  assert.equal(saved.token, 'fresh-tok');
  assert.equal(saved.authToken, 'fresh-auth');
  assert.equal(saved.account, 'me@example.com');
  assert.equal(saved.host, 'rest.ucloud.akuvox.com:8443');
  // The password is never written to disk
  assert.doesNotMatch(fs.readFileSync(path.join(storage, 'akuvox-smartplus.json'), 'utf8'), /hunter2/);
});

test('a saved session is reused without signing in again', async (t) => {
  const { api, platform, fetchFn } = await setup({ credentials: { account: 'me@example.com' }, config: LOGIN_OPTIONS });
  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));
  assert.equal(fetchFn.calls.filter((call) => call.url.includes('/login?')).length, 0);
});

test('changing the configured email signs in to the new account', async (t) => {
  const { api, platform, fetchFn, storage } = await setup({ credentials: { account: 'old@example.com' }, config: LOGIN_OPTIONS });
  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));
  assert.equal(fetchFn.calls.filter((call) => call.url.includes('/login?')).length, 1);
  assert.equal(readSaved(storage).account, 'me@example.com');
});

test('a revoked session is recovered by signing in with the configured password', async (t) => {
  const { api, platform, registered, fetchFn, storage, errors } = await setup({
    config: LOGIN_OPTIONS,
    // The saved token was revoked (e.g. by signing in on the phone), only the new one works
    userconf: (call) => (call.url.includes('token=fresh-tok') ? { json: USERCONF } : { status: 401 }),
  });
  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));

  assert.deepEqual(errors, []);
  assert.equal(registered.length, 3);
  assert.deepEqual(
    fetchFn.calls.map((call) => new URL(call.url).pathname),
    ['/userconf', '/refresh_token', '/login', '/userconf'],
  );
  assert.equal(readSaved(storage).token, 'fresh-tok');
});

test('a wrong password reports a sign-in error', async (t) => {
  const { api, platform, fetchFn, errors } = await setup({
    credentials: false,
    config: LOGIN_OPTIONS,
    login: { json: { err_code: '1000100004', message: 'user not exist or passwd incorrect.' } },
  });
  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));
  assert.match(errors[0], /sign-in failed/);
  // One attempt on the configured region and one on the global fallback
  assert.equal(fetchFn.calls.filter((call) => call.url.includes('/login?')).length, 2);
});

test('only cameras listed in settings are added, as HomeKit cameras', async (t) => {
  const { api, platform, registered } = await setup({
    credentials: { rtspServer: 'rtspsrv1.ucloud.akuvox.com:554' },
    config: { onlyListedDoors: true, cameras: [{ name: 'aabbcc' }] },
  });
  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));

  assert.deepEqual(registered.map((accessory) => accessory.displayName), ['Parking']);
  const [camera] = registered;
  assert.equal(camera.category, api.hap.Categories.CAMERA);
  assert.ok(camera.getService(api.hap.Service.CameraRTPStreamManagement));
  assert.deepEqual(camera.context.camera, { id: 'AABBCC', name: 'Parking', mac: 'AABBCC', rtspPassword: 'cam-secret' });
});

test('no cameras are added unless listed', async (t) => {
  const { api, platform, registered } = await setup({ credentials: { rtspServer: 'rtspsrv1.ucloud.akuvox.com:554' } });
  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));
  assert.equal(registered.filter((accessory) => accessory.context.camera).length, 0);
});

test('a session saved before camera support signs in once more to learn the camera server', async (t) => {
  const { api, platform, registered, fetchFn, storage } = await setup({
    credentials: { account: 'me@example.com' },
    config: { ...LOGIN_OPTIONS, onlyListedDoors: true, cameras: [{ name: 'Parking' }] },
  });
  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));

  assert.equal(fetchFn.calls.filter((call) => call.url.includes('/login?')).length, 1);
  assert.equal(readSaved(storage).rtspServer, 'rtspsrv1.ucloud.akuvox.com:554');
  assert.deepEqual(registered.map((accessory) => accessory.displayName), ['Parking']);
});

test('cameras are skipped with an error when the camera server is unknown and no password is set', async (t) => {
  const { api, platform, registered, errors } = await setup({ config: { cameras: [{ name: 'Parking' }] } });
  await platform.discoverDevices();
  t.after(() => api.emit('shutdown'));
  assert.equal(registered.filter((accessory) => accessory.context.camera).length, 0);
  assert.match(errors.join('\n'), /did not return a camera server/);
});
