import type { CameraController, CameraStreamingDelegate, PlatformAccessory } from 'homebridge' with { 'resolution-mode': 'import' };
import type { PrepareStreamCallback, PrepareStreamRequest, SnapshotRequest } from 'homebridge' with { 'resolution-mode': 'import' };
import type { SnapshotRequestCallback, StreamingRequest, StreamRequestCallback } from 'homebridge' with { 'resolution-mode': 'import' };
import { ChildProcess, spawn } from 'child_process';
import { createSocket, Socket } from 'dgram';

import { AkuvoxPlatform } from '../platform';
import { DoorCamera, cameraUrl } from '../AkuvoxAPI';

// A stream's first frames are decoded with the SDP's stale parameter sets (black, and sometimes 1280x1024
// instead of 720p), so snapshots skip the first seconds before the output size is fixed
const SNAPSHOT_SKIP_SECONDS = 2;
const SNAPSHOT_TIMEOUT_MS = 15_000;
// The Home app re-requests snapshots every few seconds while open; reuse one instead of reconnecting each time
const SNAPSHOT_CACHE_MS = 15_000;
// HomeKit sends RTCP while watching; without it the viewer is gone and the stream would keep pulling from SmartPlus
const STREAM_INACTIVITY_MS = 10_000;

const H264_PROFILES = ['baseline', 'main', 'high'];
const H264_LEVELS = ['3.1', '3.2', '4.0'];

interface PendingSession {
  address: string;
  ipv6: boolean;
  videoPort: number;
  srtp: string;
  ssrc: number;
  socket: Socket;
}

interface ActiveStream {
  process: ChildProcess;
  socket: Socket;
  inactivityTimer?: NodeJS.Timeout;
}

export interface StreamArgsOptions {
  url: string;
  encoder: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  profile: number;
  level: number;
  payloadType: number;
  ssrc: number;
  srtp: string;
  address: string;
  ipv6: boolean;
  port: number;
  mtu: number;
}

/**
 * ffmpeg arguments that pull a SmartPlus camera over RTSP/UDP and send it to HomeKit as SRTP
 */
export function buildStreamArgs(options: StreamArgsOptions) {
  const encoding = options.encoder === 'copy'
    ? ['-codec:v', 'copy']
    : [
      '-codec:v', options.encoder,
      '-pix_fmt', 'yuv420p',
      '-color_range', 'mpeg',
      '-r', String(options.fps),
      // Always output exactly the requested size (letterboxed), so the stale-SPS frames at the start of a
      // stream can't lock the encoder to the wrong dimensions
      '-vf', `scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease,`
        + `pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2`,
      '-b:v', `${options.bitrate}k`,
      '-bufsize', `${options.bitrate * 2}k`,
      '-maxrate', `${options.bitrate}k`,
      '-profile:v', H264_PROFILES[options.profile] ?? 'main',
      ...(options.encoder === 'libx264'
        ? ['-level:v', H264_LEVELS[options.level] ?? '3.1', '-preset', 'ultrafast', '-tune', 'zerolatency']
        : []),
      ...(options.encoder === 'h264_videotoolbox' ? ['-realtime', '1'] : []),
    ];
  const host = options.ipv6 ? `[${options.address}]` : options.address;
  return [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'udp',
    '-i', options.url,
    '-an', '-sn', '-dn',
    ...encoding,
    '-payload_type', String(options.payloadType),
    '-ssrc', String(options.ssrc),
    '-f', 'rtp',
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params', options.srtp,
    `srtp://${host}:${options.port}?rtcpport=${options.port}&pkt_size=${options.mtu}`,
  ];
}

export function buildSnapshotArgs(url: string, width: number) {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'udp',
    '-i', url,
    // Trimming inside the filter graph (unlike -ss) keeps the skipped frames from sizing the encoder
    '-vf', `trim=start=${SNAPSHOT_SKIP_SECONDS},scale='min(${width},iw)':-2`,
    '-frames:v', '1',
    '-f', 'image2',
    '-c:v', 'mjpeg',
    'pipe:1',
  ];
}

/**
 * A SmartPlus intercom camera exposed as a HomeKit camera, streamed through ffmpeg
 * SmartPlus cameras send video only, so no audio stream is offered
 */
export class CameraAccessory implements CameraStreamingDelegate {
  readonly controller: CameraController;
  private readonly pendingSessions = new Map<string, PendingSession>();
  private readonly activeStreams = new Map<string, ActiveStream>();
  private snapshot?: { image: Buffer; takenAt: number };
  private snapshotInFlight?: Promise<Buffer>;

  constructor(
    private readonly platform: AkuvoxPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly camera: DoorCamera,
    private readonly rtspServer: string,
    private readonly ffmpegPath: string,
    private readonly encoder: string,
  ) {
    const { hap } = platform.api;
    const { Characteristic } = platform;

    accessory.getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Akuvox')
      .setCharacteristic(Characteristic.Model, 'SmartPlus Camera')
      .setCharacteristic(Characteristic.SerialNumber, camera.mac);

    this.controller = new hap.CameraController({
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          // SmartPlus cameras stream 1280x720, so nothing larger is offered
          resolutions: [
            [320, 180, 30], [320, 240, 15], [320, 240, 30], [480, 270, 30], [480, 360, 30],
            [640, 360, 30], [640, 480, 30], [1280, 720, 30],
          ],
          codec: {
            profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
            levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
          },
        },
      },
    });
    accessory.configureController(this.controller);
  }

  private get url() {
    return cameraUrl(this.camera, this.rtspServer);
  }

  async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback) {
    try {
      callback(undefined, await this.getSnapshot(request.width));
    } catch (error) {
      this.platform.log.error(`Snapshot from ${this.accessory.displayName} failed:`, (error as Error).message);
      callback(error as Error);
    }
  }

  private getSnapshot(width: number): Promise<Buffer> {
    if (this.snapshot && Date.now() - this.snapshot.takenAt < SNAPSHOT_CACHE_MS) {
      return Promise.resolve(this.snapshot.image);
    }
    // Concurrent requests share one capture
    this.snapshotInFlight ??= this.captureSnapshot(width)
      .then((image) => {
        this.snapshot = { image, takenAt: Date.now() };
        return image;
      })
      .finally(() => {
        this.snapshotInFlight = undefined;
      });
    return this.snapshotInFlight;
  }

  private captureSnapshot(width: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn(this.ffmpegPath, buildSnapshotArgs(this.url, width));
      const chunks: Buffer[] = [];
      let stderr = '';
      const timer = setTimeout(() => ffmpeg.kill('SIGKILL'), SNAPSHOT_TIMEOUT_MS);
      ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      ffmpeg.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      ffmpeg.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`could not run ffmpeg at ${this.ffmpegPath}: ${error.message}`));
      });
      ffmpeg.on('close', (code) => {
        clearTimeout(timer);
        const image = Buffer.concat(chunks);
        if (image.length) {
          resolve(image);
        } else {
          reject(new Error(`ffmpeg exited with ${code}: ${this.redact(stderr).trim() || 'no image'}`));
        }
      });
    });
  }

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback) {
    const ipv6 = request.addressVersion === 'ipv6';
    const socket = createSocket(ipv6 ? 'udp6' : 'udp4');
    socket.on('error', (error) => this.platform.log.debug(`${this.accessory.displayName} stream socket error:`, error.message));
    try {
      // Local port for HomeKit's RTCP, used to notice when the viewer goes away
      await new Promise<void>((resolve) => socket.bind(0, resolve));
    } catch (error) {
      callback(error as Error);
      return;
    }
    const ssrc = this.platform.api.hap.CameraController.generateSynchronisationSource();
    this.pendingSessions.set(request.sessionID, {
      address: request.targetAddress,
      ipv6,
      videoPort: request.video.port,
      srtp: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]).toString('base64'),
      ssrc,
      socket,
    });
    callback(undefined, {
      video: {
        port: socket.address().port,
        ssrc,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
    });
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback) {
    switch (request.type) {
      case 'start':
        this.startStream(request.sessionID, request.video);
        callback();
        break;
      case 'reconfigure':
        // ffmpeg can't change resolution mid-stream; HomeKit keeps the current stream
        callback();
        break;
      case 'stop':
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  private startStream(sessionID: string, video: {
    width: number; height: number; fps: number; max_bit_rate: number; pt: number; mtu: number; profile: number; level: number;
  }) {
    const session = this.pendingSessions.get(sessionID);
    if (!session) {
      return;
    }
    this.pendingSessions.delete(sessionID);

    const args = buildStreamArgs({
      url: this.url,
      encoder: this.encoder,
      width: video.width,
      height: video.height,
      fps: video.fps,
      bitrate: video.max_bit_rate,
      profile: video.profile,
      level: video.level,
      payloadType: video.pt,
      ssrc: session.ssrc,
      srtp: session.srtp,
      address: session.address,
      ipv6: session.ipv6,
      port: session.videoPort,
      mtu: video.mtu,
    });
    this.platform.log.info(`Streaming ${this.accessory.displayName} at ${video.width}x${video.height} ${video.fps}fps`);
    const ffmpeg = spawn(this.ffmpegPath, args);
    const stream: ActiveStream = { process: ffmpeg, socket: session.socket };
    this.activeStreams.set(sessionID, stream);

    ffmpeg.stderr?.on('data', (chunk: Buffer) => this.platform.log.debug(`[${this.accessory.displayName}]`, this.redact(chunk.toString())));
    ffmpeg.on('error', (error) => this.platform.log.error(`Could not run ffmpeg at ${this.ffmpegPath}:`, error.message));
    ffmpeg.on('exit', (code, signal) => {
      // Ending on its own (not because we stopped it) means the camera or SmartPlus dropped the stream
      if (this.activeStreams.get(sessionID) === stream) {
        this.platform.log.error(`Stream from ${this.accessory.displayName} ended unexpectedly (${signal ?? code})`);
        this.stopStream(sessionID);
        this.controller.forceStopStreamingSession(sessionID);
      }
    });

    const resetInactivity = () => {
      clearTimeout(stream.inactivityTimer);
      stream.inactivityTimer = setTimeout(() => {
        this.platform.log.info(`Stopping ${this.accessory.displayName} stream, HomeKit stopped responding`);
        this.stopStream(sessionID);
        this.controller.forceStopStreamingSession(sessionID);
      }, STREAM_INACTIVITY_MS);
    };
    session.socket.on('message', resetInactivity);
    resetInactivity();
  }

  private stopStream(sessionID: string) {
    const pending = this.pendingSessions.get(sessionID);
    if (pending) {
      this.pendingSessions.delete(sessionID);
      pending.socket.close();
    }
    const stream = this.activeStreams.get(sessionID);
    if (!stream) {
      return;
    }
    this.activeStreams.delete(sessionID);
    clearTimeout(stream.inactivityTimer);
    stream.process.kill('SIGKILL');
    try {
      stream.socket.close();
    } catch {
      // Already closed
    }
  }

  stop() {
    [...this.pendingSessions.keys(), ...this.activeStreams.keys()].forEach((sessionID) => this.stopStream(sessionID));
  }

  private redact(text: string) {
    return text.split(this.camera.rtspPassword).join('***').split(encodeURIComponent(this.camera.rtspPassword)).join('***');
  }
}
