import type { API, DynamicPlatformPlugin, Logger, PlatformConfig } from 'homebridge' with { 'resolution-mode': 'import' };
import type { PlatformAccessory, Service, Characteristic } from 'homebridge' with { 'resolution-mode': 'import' };

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import AkuvoxAPI, { AkuvoxAuthError, AkuvoxCredentials, DoorCamera, DoorRelay, beginEmailLogin } from './AkuvoxAPI';
import { loadCredentials, saveCredentials, credentialsPath } from './credentials';
import { AccessoryType, DEFAULT_OPEN_DURATION, RelayAccessory } from './accessories/RelayAccessory';
import { CameraAccessory } from './accessories/CameraAccessory';

// SmartPlus doesn't report token expiry, so refresh well before sessions have been seen to lapse
const TOKEN_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOGIN_COMMAND = 'akuvox-smartplus-login';

interface DoorConfig {
  name: string;
  type?: AccessoryType;
  hidden?: boolean;
  openDuration?: number;
}

interface CameraConfig {
  name: string;
}

/**
 * The ffmpeg-for-homebridge build includes the encoders HomeKit streaming needs; fall back to ffmpeg on the PATH
 */
function defaultFfmpegPath() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('ffmpeg-for-homebridge') as string | undefined) || 'ffmpeg';
  } catch {
    return 'ffmpeg';
  }
}

/**
 * HomebridgePlatform
 * Signs in to SmartPlus, discovers door relays, and keeps the session token fresh
 */
export class AkuvoxPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public akuvox?: AkuvoxAPI;

  // This is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  private readonly handlers: (RelayAccessory | CameraAccessory)[] = [];
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices().catch((error) => this.log.error('Setup failed:', error.message));
    });

    // Clear timers so they don't keep the process alive
    this.api.on('shutdown', () => {
      clearInterval(this.refreshTimer);
      this.handlers.forEach((handler) => handler.stop());
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  /**
   * Sign in with the email and password from the plugin settings
   * Accounts that need an emailed verification code have to use the login command instead
   */
  private async signIn(storagePath: string): Promise<AkuvoxCredentials> {
    const { email, password, region } = this.config.options ?? {};
    const account = String(email).trim();
    const result = await beginEmailLogin(account, String(password), [...new Set([region || 'ucloud', 'ecloud'])]);
    if (!('credentials' in result)) {
      throw new AkuvoxAuthError('SmartPlus requires an emailed verification code for this account. '
        + `Run \`${LOGIN_COMMAND} --storage ${storagePath}\` once, then restart Homebridge.`);
    }
    this.log.info(`Signed in to SmartPlus as ${account}`);
    return { ...result.credentials, account };
  }

  /**
   * Sign in (or load the saved session), fetch the account's door relays, and register them as accessories
   * Also remove accessories that are no longer present on the user's account
   */
  async discoverDevices() {
    const storagePath = this.api.user.storagePath();
    const hasLogin = Boolean(this.config.options?.email && this.config.options?.password);
    let credentials = await loadCredentials(storagePath);

    // A session saved for a different email than the one now configured belongs to the old account
    const configuredAccount = String(this.config.options?.email ?? '').trim().toLowerCase();
    if (hasLogin && credentials?.account && credentials.account.toLowerCase() !== configuredAccount) {
      credentials = undefined;
    }

    if (!credentials) {
      if (!hasLogin) {
        this.log.error('Not logged in. Enter your SmartPlus email and password in the plugin settings, '
          + `or run \`${LOGIN_COMMAND} --storage ${storagePath}\`, then restart Homebridge.`);
        return;
      }
      try {
        credentials = await this.signIn(storagePath);
        await saveCredentials(storagePath, credentials);
      } catch (error) {
        this.log.error('SmartPlus sign-in failed:', (error as Error).message);
        return;
      }
    }

    // With a password configured, a revoked session (e.g. after signing in on the phone) is recovered automatically
    const signIn = hasLogin ? () => this.signIn(storagePath) : undefined;
    this.connect(credentials, storagePath, signIn);

    let relays: DoorRelay[];
    let cameras: DoorCamera[];
    let fromCache = false;
    try {
      ({ relays, cameras } = await this.akuvox!.getDevices());
      // Names and ids to copy into the "doors" and "cameras" settings
      this.log.info('Doors on this account:', relays.map((relay) => `${relay.doorName} (${relay.id})`).join(', '));
      this.log.info('Cameras on this account:', cameras.map((camera) => `${camera.name} (${camera.id})`).join(', '));
    } catch (error) {
      if (error instanceof AkuvoxAuthError) {
        this.log.error(`SmartPlus login expired (${error.message}). `
          + (hasLogin
            ? 'Check the email and password in the plugin settings, then restart Homebridge.'
            : `Run \`${LOGIN_COMMAND} --storage ${storagePath}\` then restart Homebridge.`));
      } else {
        this.log.error('Failed to fetch door list, using cached accessories:', (error as Error).message);
      }
      // Keep cached doors working, a temporary outage shouldn't remove them from Home
      relays = this.accessories.map((accessory) => accessory.context.relay).filter(Boolean);
      cameras = this.accessories.map((accessory) => accessory.context.camera).filter(Boolean);
      fromCache = true;
    }

    const doorConfigs: DoorConfig[] = Array.isArray(this.config.doors) ? this.config.doors : [];
    const activeUUIDs = new Set<string>();

    for (const relay of relays) {
      // An exact id match wins over a name match, since names repeat across community devices
      const doorConfig = doorConfigs.find((door) => this.matchesId(door.name, relay))
        || doorConfigs.find((door) => this.matches(door.name, relay));
      if (doorConfig?.hidden || (!doorConfig && this.config.onlyListedDoors)) {
        continue;
      }
      const type: AccessoryType = doorConfig?.type || this.config.defaultType || 'garage';
      const openDuration = doorConfig?.openDuration ?? this.config.openDuration ?? DEFAULT_OPEN_DURATION[type];
      const uuid = this.api.hap.uuid.generate(relay.id);
      activeUUIDs.add(uuid);

      let accessory = this.accessories.find((cached) => cached.UUID === uuid);
      if (accessory) {
        this.log.info('Restoring existing accessory from cache:', accessory.displayName);
        accessory.context.relay = relay;
        this.api.updatePlatformAccessories([accessory]);
      } else {
        const name = relay.doorName || relay.deviceName;
        this.log.info('Adding new accessory:', name);
        accessory = new this.api.platformAccessory(name, uuid);
        accessory.context.relay = relay;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      this.handlers.push(new RelayAccessory(this, accessory, relay, type, openDuration));
    }

    await this.setUpCameras(cameras, activeUUIDs, storagePath, signIn);

    // Only prune when the device list came from SmartPlus, hidden doors and unlisted cameras are pruned too
    if (!fromCache) {
      const stale = this.accessories.filter((accessory) => !activeUUIDs.has(accessory.UUID));
      if (stale.length) {
        this.log.info('Removing accessories no longer on the account:', stale.map((accessory) => accessory.displayName).join(', '));
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      }
    }

    this.scheduleTokenRefresh(credentials.refreshedAt);
  }

  /**
   * Add the cameras listed in the "cameras" setting; cameras are opt-in since community accounts can see many
   */
  private connect(credentials: AkuvoxCredentials, storagePath: string, signIn?: () => Promise<AkuvoxCredentials>) {
    this.akuvox = new AkuvoxAPI(
      credentials,
      this.log,
      async (updated) => {
        await saveCredentials(storagePath, updated);
        this.log.debug('Saved refreshed credentials to', credentialsPath(storagePath));
      },
      undefined,
      signIn,
    );
  }

  private async setUpCameras(
    cameras: DoorCamera[],
    activeUUIDs: Set<string>,
    storagePath: string,
    signIn?: () => Promise<AkuvoxCredentials>,
  ) {
    const cameraConfigs: CameraConfig[] = Array.isArray(this.config.cameras) ? this.config.cameras : [];
    const wanted = (camera: DoorCamera) => cameraConfigs.find((config) => this.matchesId(config.name, camera))
      || cameraConfigs.find((config) => String(config.name ?? '').trim().toLowerCase() === camera.name.toLowerCase());
    const selected = cameras.filter((camera) => wanted(camera));
    if (!selected.length) {
      return;
    }

    // Sessions saved before camera support didn't record the RTSP server; one fresh sign-in returns it
    let rtspServer = this.akuvox!.currentCredentials.rtspServer;
    if (!rtspServer && signIn) {
      try {
        const credentials = await signIn();
        await saveCredentials(storagePath, credentials);
        this.connect(credentials, storagePath, signIn);
        rtspServer = credentials.rtspServer;
      } catch (error) {
        this.log.error('Could not sign in to look up the camera server:', (error as Error).message);
      }
    }
    if (!rtspServer) {
      this.log.error('SmartPlus did not return a camera server for this account, so cameras are unavailable. '
        + `Sign in again with \`${LOGIN_COMMAND}\` or add your password to the plugin settings.`);
      return;
    }

    const ffmpegPath = this.config.videoProcessor || defaultFfmpegPath();
    const encoder = this.config.videoEncoder || 'libx264';
    for (const camera of selected) {
      const uuid = this.api.hap.uuid.generate(`camera:${camera.id}`);
      activeUUIDs.add(uuid);
      let accessory = this.accessories.find((cached) => cached.UUID === uuid);
      if (accessory) {
        this.log.info('Restoring existing camera from cache:', accessory.displayName);
        accessory.context.camera = camera;
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.log.info('Adding new camera:', camera.name);
        accessory = new this.api.platformAccessory(camera.name, uuid, this.api.hap.Categories.CAMERA);
        accessory.context.camera = camera;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      this.handlers.push(new CameraAccessory(this, accessory, camera, rtspServer, ffmpegPath, encoder));
    }
  }

  private matchesId(name: string | undefined, device: { id: string }) {
    return String(name ?? '').trim().toLowerCase() === device.id.toLowerCase();
  }

  private matches(name: string | undefined, relay: DoorRelay) {
    const wanted = String(name ?? '').trim().toLowerCase();
    return Boolean(wanted) && [relay.doorName, relay.deviceName, relay.id].some((value) => value.toLowerCase() === wanted);
  }

  private scheduleTokenRefresh(refreshedAt?: string) {
    const refresh = () => {
      this.akuvox!.refreshToken().catch((error) => {
        // A rejected proactive refresh doesn't mean the current token stopped working
        this.log.warn('Scheduled SmartPlus token refresh failed:', error.message);
      });
    };
    const lastRefresh = refreshedAt ? Date.parse(refreshedAt) : NaN;
    if (!Number.isNaN(lastRefresh) && Date.now() - lastRefresh >= TOKEN_REFRESH_INTERVAL_MS) {
      refresh();
    }
    this.refreshTimer = setInterval(refresh, TOKEN_REFRESH_INTERVAL_MS);
  }
}
