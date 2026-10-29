import type { API, DynamicPlatformPlugin, Logger, PlatformConfig } from 'homebridge' with { 'resolution-mode': 'import' };
import type { PlatformAccessory, Service, Characteristic } from 'homebridge' with { 'resolution-mode': 'import' };

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import AkuvoxAPI, { AkuvoxAuthError, AkuvoxCredentials, DoorRelay, beginEmailLogin } from './AkuvoxAPI';
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
 * Signs in to SmartPlus, discovers door relays, and keeps the session token fresh
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

    this.akuvox = new AkuvoxAPI(
      credentials,
      this.log,
      async (updated) => {
        await saveCredentials(storagePath, updated);
        this.log.debug('Saved refreshed credentials to', credentialsPath(storagePath));
      },
      undefined,
      // With a password configured, a revoked session (e.g. after signing in on the phone) is recovered automatically
      hasLogin ? () => this.signIn(storagePath) : undefined,
    );

    let relays: DoorRelay[];
    let fromCache = false;
    try {
      relays = await this.akuvox.getDoorRelays();
      // Names and ids to copy into the "doors" setting
      this.log.info('Doors on this account:', relays.map((relay) => `${relay.doorName} (${relay.id})`).join(', '));
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

  private matchesId(name: string | undefined, relay: DoorRelay) {
    return String(name ?? '').trim().toLowerCase() === relay.id.toLowerCase();
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
