const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCameras, cameraUrl, beginEmailLogin } = require('../dist/AkuvoxAPI');
const { buildStreamArgs, buildSnapshotArgs } = require('../dist/accessories/CameraAccessory');
const { fakeFetch } = require('./helpers/fakeFetch');

const camera = { id: 'AABBCC', name: 'Garage', mac: 'AABBCC', rtspPassword: 'p@ss/word' };

test('parseCameras keeps devices that have an RTSP password', () => {
  assert.deepEqual(parseCameras({
    dev_list: [
      { location: 'Garage', mac: 'AABBCC', rtsp_pwd: 'secret' },
      { location: 'No camera', mac: 'DDEEFF' },
      { location: '', mac: '112233', rtsp_pwd: 'x' },
      null,
    ],
  }), [{ id: 'AABBCC', name: 'Garage', mac: 'AABBCC', rtspPassword: 'secret' }]);
  assert.deepEqual(parseCameras(undefined), []);
});

test('cameraUrl matches the SmartPlus app and escapes the password', () => {
  assert.equal(cameraUrl(camera, 'rtspsrv1.ucloud.akuvox.com:554'), 'rtsp://user:p%40ss%2Fword@rtspsrv1.ucloud.akuvox.com:554/AABBCC');
});

test('email sign-in records the camera server', async () => {
  const fetchFn = fakeFetch([{
    match: () => true,
    reply: { json: { result: 0, datas: { token: 't', refresh_token: 'r', rest_server_https: 'h:8443', vrtsp_server: 'subdomain.cam:554' } } },
  }]);
  const result = await beginEmailLogin('me@example.com', 'pw', ['ucloud'], fetchFn);
  assert.equal(result.credentials.rtspServer, 'ucloud.cam:554');
});

const streamOptions = {
  url: 'rtsp://user:x@cam:554/AABBCC', encoder: 'libx264', width: 640, height: 480, fps: 30, bitrate: 299,
  profile: 2, level: 2, payloadType: 99, ssrc: 42, srtp: 'S3CR3T', address: '10.0.0.5', ipv6: false, port: 51000, mtu: 1378,
};
const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

test('stream args pull over UDP and send SRTP at exactly the requested size', () => {
  const args = buildStreamArgs(streamOptions);
  assert.equal(valueAfter(args, '-rtsp_transport'), 'udp');
  assert.equal(valueAfter(args, '-i'), streamOptions.url);
  assert.ok(args.includes('-an'));
  assert.equal(valueAfter(args, '-vf'), 'scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2');
  assert.equal(valueAfter(args, '-b:v'), '299k');
  assert.equal(valueAfter(args, '-profile:v'), 'high');
  assert.equal(valueAfter(args, '-level:v'), '4.0');
  assert.equal(valueAfter(args, '-payload_type'), '99');
  assert.equal(valueAfter(args, '-ssrc'), '42');
  assert.equal(valueAfter(args, '-srtp_out_params'), 'S3CR3T');
  assert.equal(args.at(-1), 'srtp://10.0.0.5:51000?rtcpport=51000&pkt_size=1378');
});

test('stream args support passthrough, hardware encoding, and IPv6 targets', () => {
  const copy = buildStreamArgs({ ...streamOptions, encoder: 'copy' });
  assert.equal(valueAfter(copy, '-codec:v'), 'copy');
  assert.ok(!copy.includes('-vf'));

  const videotoolbox = buildStreamArgs({ ...streamOptions, encoder: 'h264_videotoolbox' });
  assert.equal(valueAfter(videotoolbox, '-realtime'), '1');
  assert.ok(!videotoolbox.includes('-preset'));

  assert.equal(buildStreamArgs({ ...streamOptions, ipv6: true, address: 'fe80::1' }).at(-1),
    'srtp://[fe80::1]:51000?rtcpport=51000&pkt_size=1378');
});

test('snapshot args skip the stale first frames inside the filter graph', () => {
  const args = buildSnapshotArgs('rtsp://cam', 640);
  assert.equal(valueAfter(args, '-rtsp_transport'), 'udp');
  assert.equal(valueAfter(args, '-vf'), "trim=start=2,scale='min(640,iw)':-2");
  assert.ok(!args.includes('-ss'));
  assert.equal(args.at(-1), 'pipe:1');
});
