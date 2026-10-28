import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import AkuvoxAPI, { AkuvoxAuthError, DoorRelay } from './AkuvoxAPI';
import { loadCredentials, saveCredentials, credentialsPath } from './credentials';
import { AccessoryType, DEFAULT_OPEN_DURATION, RelayAccessory } from './accessories/RelayAccessory';

// SmartPlus doesn't report token expiry, so refresh well before sessions have been seen to lapse
const TOKEN_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOGIN_COMMAND = 'akuvox-smartplus-login';

interface DoorConfig {
  name: string;
  type?: AccessoryType;
  hidden?: boolean;
  openDuration?: number;
}

/**
 * HomebridgePlatform
 * Loads the saved SmartPlus login, discovers door relays, and keeps the session token fresh
 */
export class AkuvoxPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public akuvox?: AkuvoxAPI;

  // This is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  private readonly handlers: RelayAccessory[] = [];
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
   * Load the saved login, fetch the account's door relays, and register them as accessories
   * Also remove accessories that are no longer present on the user's account
   */
  async discoverDevices() {
    const storagePath = this.api.user.storagePath();
    const credentials = await loadCredentials(storagePath);
    if (!credentials) {
      this.log.error(`Not logged in. Run \`${LOGIN_COMMAND} --storage ${storagePath}\` then restart Homebridge.`);
      return;
    }

    this.akuvox = new AkuvoxAPI(credentials, this.log, async (updated) => {
      await saveCredentials(storagePath, updated);
      this.log.debug('Saved refreshed credentials to', credentialsPath(storagePath));
    });

    let relays: DoorRelay[];
    let fromCache = false;
    try {
      relays = await this.akuvox.getDoorRelays();
    } catch (error) {
      if (error instanceof AkuvoxAuthError) {
        this.log.error(`SmartPlus login expired (${error.message}). Run \`${LOGIN_COMMAND} --storage ${storagePath}\` `
          + 'then restart Homebridge.');
      } else {
        this.log.error('Failed to fetch door list, using cached accessories:', (error as Error).message);
      }
      // Keep cached doors working, a temporary outage shouldn't remove them from Home
      relays = this.accessories.map((accessory) => accessory.context.relay).filter(Boolean);
      fromCache = true;
    }

    const doorConfigs: DoorConfig[] = Array.isArray(this.config.doors) ? this.config.doors : [];
    const activeUUIDs = new Set<string>();

    for (const relay of relays) {
      const doorConfig = doorConfigs.find((door) => this.matches(door.name, relay));
      if (doorConfig?.hidden) {
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

    // Only prune when the door list came from SmartPlus, hidden doors are pruned too
    if (!fromCache) {
      const stale = this.accessories.filter((accessory) => !activeUUIDs.has(accessory.UUID));
      if (stale.length) {
        this.log.info('Removing accessories no longer on the account:', stale.map((accessory) => accessory.displayName).join(', '));
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      }
    }

    this.scheduleTokenRefresh(credentials.refreshedAt);
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
