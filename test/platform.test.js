const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { HomebridgeAPI } = require('homebridge/lib/api');

const { AkuvoxPlatform } = require('../dist/platform');
const { fakeFetch, silentLog } = require('./helpers/fakeFetch');

const USERCONF = {
  result: 0,
  datas: {
    dev_list: [
      { location: 'Parking', mac: 'AABBCC', relay: [{ relay_id: 0, door_name: 'Garage' }, { relay_id: 1, door_name: 'Side Gate' }] },
      { location: 'Lobby', mac: 'DDEEFF', relay: [{ relay_id: 0, door_name: 'Front Door' }] },
    ],
  },
};

const originalFetch = globalThis.fetch;

async function setup({ config = {}, userconf = { json: USERCONF }, opendoor = { json: { result: 0 } }, credentials = true } = {}) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'akuvox-test-'));
  if (credentials) {
    fs.writeFileSync(path.join(storage, 'akuvox-smartplus.json'), JSON.stringify({
      subdomain: 'ucloud', host: 'ucloud.akuvox.com:8443', authToken: 'auth', token: 'tok', refreshedAt: new Date().toISOString(),
    }));
  }
  const fetchFn = fakeFetch([
    { match: (call) => call.url.includes('/userconf'), reply: userconf },
    { match: (call) => call.url.includes('/opendoor'), reply: opendoor },
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
  assert.match(errors[0], /akuvox-smartplus-login --storage/);
});
