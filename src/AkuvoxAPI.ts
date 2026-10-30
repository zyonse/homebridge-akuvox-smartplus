import { createHash } from 'crypto';

/**
 * Akuvox SmartPlus cloud API client
 * Endpoints and payloads mirror the SmartPlus iOS app, as documented by https://github.com/nimroddolev/akuvox
 */

// Regional gateways, US first since it is the most common for this plugin's users
export const REGIONS = ['ucloud', 'ecloud', 'aucloud', 'ccloud', 'jcloud', 'rucloud', 'scloud'];

const GATE_PORT = 8600;
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = 'VBell/7.50.4 (iPhone; iOS 26.6; Scale/3.00)';
const EMAIL_LOGIN_USER_AGENT = 'VBell/7.51.3 (iPhone; iOS 27.0; Scale/3.00)';
const REFRESH_USER_AGENT = 'VBell/7.50.3 (iPhone; iOS 26.6; Scale/3.00)';
const ACCEPT_LANGUAGE = 'en-US;q=1';

export interface AkuvoxCredentials {
  subdomain: string;
  host: string;
  // Long-lived credential used only to mint new session tokens
  authToken: string;
  // Short-lived session token sent with every request
  token: string;
  refreshedAt?: string;
  // Email the session was signed in with, to notice when the configured account changes
  account?: string;
  // host:port of the RTSP relay that serves intercom cameras, from the login response
  rtspServer?: string;
}

export interface DoorCamera {
  // Device MAC, stable across restarts and renames
  id: string;
  name: string;
  mac: string;
  rtspPassword: string;
}

export interface DoorRelay {
  // `${mac}:${relayId}`, stable across restarts and renames
  id: string;
  deviceName: string;
  doorName: string;
  mac: string;
  relayId: string;
}

export interface AkuvoxLogger {
  debug(message: string, ...parameters: unknown[]): void;
  info(message: string, ...parameters: unknown[]): void;
  warn(message: string, ...parameters: unknown[]): void;
  error(message: string, ...parameters: unknown[]): void;
}

export type FetchFn = typeof fetch;

type ErrorKind = 'auth' | 'rejected' | 'rate-limit' | 'http' | 'response';

export class AkuvoxApiError extends Error {
  constructor(message: string, public readonly kind: ErrorKind = 'response') {
    super(message);
    this.name = 'AkuvoxApiError';
  }
}

export class AkuvoxAuthError extends AkuvoxApiError {
  constructor(message: string) {
    super(message, 'auth');
    this.name = 'AkuvoxAuthError';
  }
}

interface ApiRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export function gateUrl(subdomain: string, path: string) {
  return `https://gate.${subdomain}.akuvox.com:${GATE_PORT}/${path}`;
}

/**
 * SmartPlus sometimes returns hosts with a literal `subdomain.` placeholder
 */
export function resolveHost(host: string, subdomain: string) {
  return host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace('subdomain.', `${subdomain}.`);
}

/**
 * The app shifts each phone digit by 3 before sending it
 */
export function obfuscatePhoneNumber(phoneNumber: string) {
  const digits = phoneNumber.replace(/\D/g, '');
  if (!digits) {
    throw new AkuvoxApiError('A phone number must contain at least one digit');
  }
  return [...digits].map((digit) => String((Number(digit) + 3) % 10)).join('');
}

/**
 * The app applies a Caesar shift of 3 to the login name, optionally including digits
 */
export function caesarShift(value: string, shiftDigits = false) {
  return [...value].map((character) => {
    if (shiftDigits && character >= '0' && character <= '9') {
      return String((Number(character) + 3) % 10);
    }
    if (character >= 'a' && character <= 'z') {
      return String.fromCharCode((character.charCodeAt(0) - 97 + 3) % 26 + 97);
    }
    if (character >= 'A' && character <= 'Z') {
      return String.fromCharCode((character.charCodeAt(0) - 65 + 3) % 26 + 65);
    }
    return character;
  }).join('');
}

export function doubleMd5(password: string) {
  const first = createHash('md5').update(password, 'utf8').digest('hex');
  return createHash('md5').update(first, 'ascii').digest('hex');
}

function rejection(message: unknown, code: unknown) {
  const text = String(message ?? 'No message returned');
  const lower = text.toLowerCase();
  // SmartPlus reports revoked sessions as HTTP 200 with a credential message
  if ((lower.includes('username') && (lower.includes('passwd') || lower.includes('password'))) || lower.includes('token')) {
    return new AkuvoxAuthError(`SmartPlus rejected the session (${code}): ${text}`);
  }
  return new AkuvoxApiError(`SmartPlus rejected the request (${code}): ${text}`, 'rejected');
}

/**
 * Unwrap the three response envelopes SmartPlus uses and return the payload
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapResponse(json: unknown): any {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new AkuvoxApiError('Unexpected SmartPlus response');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = json as Record<string, any>;
  if ('result' in body) {
    if (String(body.result) === '0') {
      return body.datas ?? body;
    }
    throw rejection(body.message, body.result);
  }
  // US API format
  if ('err_code' in body) {
    if (String(body.err_code) === '0') {
      return body.datas ?? body;
    }
    throw rejection(body.message, body.err_code);
  }
  // Web-server endpoints
  if ('code' in body) {
    if (Number(body.code) === 0) {
      return body.data ?? body;
    }
    if (Number(body.code) === 2) {
      throw new AkuvoxAuthError('SmartPlus returned invalid identity information');
    }
    throw new AkuvoxApiError(`SmartPlus returned error code ${body.code}`, 'rejected');
  }
  return body;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sendRequest(fetchFn: FetchFn, request: ApiRequest): Promise<any> {
  const response = await fetchFn(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new AkuvoxAuthError(`SmartPlus rejected the session with HTTP ${response.status}`);
  }
  if (response.status === 429) {
    throw new AkuvoxApiError('SmartPlus rate limited the request', 'rate-limit');
  }
  if (!response.ok) {
    throw new AkuvoxApiError(`SmartPlus returned HTTP ${response.status}`, 'http');
  }
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AkuvoxApiError('SmartPlus returned a non-JSON response');
  }
  return unwrapResponse(json);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseDoorRelays(userConf: any): DoorRelay[] {
  const relays: DoorRelay[] = [];
  const devices = Array.isArray(userConf?.dev_list) ? userConf.dev_list : [];
  for (const device of devices) {
    const deviceName = String(device?.location ?? '').trim();
    const mac = String(device?.mac ?? '').trim();
    if (!deviceName || !mac || !Array.isArray(device.relay)) {
      continue;
    }
    for (const relay of device.relay) {
      if (!relay || relay.relay_id === undefined || relay.relay_id === null) {
        continue;
      }
      const relayId = String(relay.relay_id);
      relays.push({
        id: `${mac}:${relayId}`,
        deviceName,
        doorName: String(relay.door_name || deviceName).trim(),
        mac,
        relayId,
      });
    }
  }
  return relays;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseCameras(userConf: any): DoorCamera[] {
  const devices = Array.isArray(userConf?.dev_list) ? userConf.dev_list : [];
  return devices
    .filter((device: { location?: unknown; mac?: unknown; rtsp_pwd?: unknown }) => device?.location && device?.mac && device?.rtsp_pwd)
    .map((device: { location: unknown; mac: unknown; rtsp_pwd: unknown }) => ({
      id: String(device.mac).trim(),
      name: String(device.location).trim(),
      mac: String(device.mac).trim(),
      rtspPassword: String(device.rtsp_pwd),
    }));
}

/**
 * The SmartPlus app streams from rtsp://user:<device rtsp_pwd>@<vrtsp_server>/<mac> (UrlTools.getLiveViewUrl)
 * The relay ignores RTP-over-TCP requests and always answers with UDP ports, so clients must use UDP
 */
export function cameraUrl(camera: DoorCamera, rtspServer: string) {
  return `rtsp://user:${encodeURIComponent(camera.rtspPassword)}@${rtspServer}/${camera.mac}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function credentialsFrom(data: any, subdomain: string, fallbackHost = ''): AkuvoxCredentials {
  // SMS login calls the long-lived credential auth_token, email login calls it refresh_token
  const authToken = String(data?.auth_token || data?.refresh_token || '');
  const token = String(data?.token || '');
  if (!authToken || !token) {
    throw new AkuvoxAuthError('SmartPlus did not return session tokens');
  }
  return {
    subdomain,
    host: resolveHost(String(data?.rest_server_https || fallbackHost), subdomain),
    authToken,
    token,
    refreshedAt: new Date().toISOString(),
    // Email logins return vrtsp_server, SMS logins rtsp_server
    rtspServer: resolveHost(String(data?.vrtsp_server || data?.rtsp_server || ''), subdomain) || undefined,
  };
}

/**
 * Look up the region's app REST server, e.g. ucloud.akuvox.com:8443
 */
export async function fetchRestServer(subdomain: string, fetchFn: FetchFn = fetch) {
  const data = await sendRequest(fetchFn, {
    method: 'GET',
    url: gateUrl(subdomain, 'rest_server'),
    headers: {
      'X-AUTH-TOKEN': '',
      'api-version': '6.0',
      'User-Agent': USER_AGENT,
      'Accept-Language': ACCEPT_LANGUAGE,
    },
  });
  const host = resolveHost(String(data?.rest_server_https ?? ''), subdomain);
  if (!host) {
    throw new AkuvoxApiError(`SmartPlus did not return a REST server for ${subdomain}`);
  }
  return host;
}

/**
 * Request an SMS login code, returns the REST host to pass to smsLogin
 */
export async function sendSmsCode(subdomain: string, countryCode: string, phoneNumber: string, fetchFn: FetchFn = fetch) {
  const host = await fetchRestServer(subdomain, fetchFn);
  await sendRequest(fetchFn, {
    method: 'POST',
    url: `https://${host}/send_mobile_checkcode`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-AUTH-TOKEN': '',
      'Accept': '*/*',
      'User-Agent': USER_AGENT,
      'Accept-Language': ACCEPT_LANGUAGE,
      'x-cloud-lang': 'en',
    },
    body: new URLSearchParams({
      AreaCode: countryCode.replace(/\D/g, ''),
      MobileNumber: phoneNumber.replace(/\D/g, ''),
      Type: '0',
    }).toString(),
  });
  return host;
}

export async function smsLogin(
  subdomain: string,
  countryCode: string,
  phoneNumber: string,
  code: string,
  host: string,
  fetchFn: FetchFn = fetch,
) {
  const params = new URLSearchParams({
    phone: obfuscatePhoneNumber(phoneNumber),
    code: code.trim(),
    area_code: countryCode.replace(/\D/g, ''),
  });
  const data = await sendRequest(fetchFn, {
    method: 'GET',
    url: `${gateUrl(subdomain, 'sms_login')}?${params}`,
    headers: {
      'api-version': '6.6',
      'User-Agent': USER_AGENT,
    },
  });
  return credentialsFrom(data, subdomain, host);
}

export type EmailLoginResult =
  | { credentials: AkuvoxCredentials }
  | { subdomain: string; host: string; tempToken: string };

/**
 * Check an email/username and password on each region until one accepts it
 * Returns credentials directly, or a temporary token when an emailed code is required
 */
export async function beginEmailLogin(account: string, password: string, regions: string[], fetchFn: FetchFn = fetch) {
  // Match the Android app (LoginModel/UrlTools): digits are always shifted, the query is built with String.format
  // so '@' is sent unencoded, and id_code is only sent for PM accounts. ucloud rejects '%40' or id_code=(null)
  // with "user not exist or passwd incorrect".
  const loginName = encodeURIComponent(caesarShift(account.trim(), true)).replace(/%40/g, '@');
  const url = (subdomain: string) => `${gateUrl(subdomain, 'login')}?user=${loginName}&passwd=${doubleMd5(password)}`;

  for (const subdomain of regions) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any;
    try {
      data = await sendRequest(fetchFn, {
        method: 'GET',
        url: url(subdomain),
        headers: {
          'Accept': '*/*',
          'X-AUTH-TOKEN': '',
          'api-version': '7.33',
          'User-Agent': EMAIL_LOGIN_USER_AGENT,
          'Accept-Language': ACCEPT_LANGUAGE,
        },
      });
    } catch (error) {
      if (error instanceof AkuvoxApiError && error.kind === 'rate-limit') {
        throw error;
      }
      continue;
    }

    const host = data?.rest_server_https ? resolveHost(String(data.rest_server_https), subdomain) : '';
    if (data?.token) {
      return { credentials: credentialsFrom(data, subdomain, host || await fetchRestServer(subdomain, fetchFn)) } as EmailLoginResult;
    }
    if (data?.two_factor_auth_temp_token) {
      return {
        subdomain,
        host: host || await fetchRestServer(subdomain, fetchFn),
        tempToken: String(data.two_factor_auth_temp_token),
      } as EmailLoginResult;
    }
  }
  throw new AkuvoxAuthError(`SmartPlus did not accept that email and password on ${regions.join(', ')}`);
}

export async function sendEmailCode(host: string, account: string, tempToken: string, fetchFn: FetchFn = fetch) {
  await sendRequest(fetchFn, {
    method: 'POST',
    url: `https://${host}/apprest/v2/send_two_factor_authentication_code`,
    headers: {
      'Accept': '*/*',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-AUTH-TOKEN': '',
      'api-version': '7.1',
      'User-Agent': EMAIL_LOGIN_USER_AGENT,
      'Accept-Language': ACCEPT_LANGUAGE,
    },
    body: new URLSearchParams({
      account_type: 'enduser',
      login_account: account,
      two_factor_auth_temp_token: tempToken,
    }).toString(),
  });
}

export async function verifyEmailCode(subdomain: string, host: string, account: string, code: string, fetchFn: FetchFn = fetch) {
  const data = await sendRequest(fetchFn, {
    method: 'POST',
    url: gateUrl(subdomain, 'enduser/enduser_verify_code'),
    headers: {
      'Accept': '*/*',
      'Content-Type': 'application/json',
      'X-AUTH-TOKEN': '',
      'api-version': '7.33',
      'User-Agent': EMAIL_LOGIN_USER_AGENT,
      'Accept-Language': ACCEPT_LANGUAGE,
    },
    body: JSON.stringify({ verify_code: code.trim(), user: account }),
  });
  return credentialsFrom(data, subdomain, host);
}

// Wait after a failed sign-in before trying again, so a wrong password can't lock the account
const RELOGIN_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * An authenticated SmartPlus session that refreshes its token when it expires,
 * and signs in again with `relogin` if SmartPlus revokes the session entirely
 */
export default class AkuvoxAPI {
  private refreshing?: Promise<void>;
  private relogging?: Promise<void>;
  private reloginBlockedUntil = 0;

  constructor(
    private credentials: AkuvoxCredentials,
    private readonly log: AkuvoxLogger,
    private readonly onCredentialsChanged: (credentials: AkuvoxCredentials) => void | Promise<void> = () => undefined,
    private readonly fetchFn: FetchFn = fetch,
    private readonly relogin?: () => Promise<AkuvoxCredentials>,
  ) {}

  get currentCredentials(): AkuvoxCredentials {
    return { ...this.credentials };
  }

  /**
   * Fetch the account's door relays and intercom cameras
   */
  async getDevices() {
    const data = await this.authenticated((token) => ({
      method: 'GET',
      url: `https://${this.credentials.host}/userconf?token=${encodeURIComponent(token)}`,
      headers: this.appHeaders(token, '6.5'),
    }));
    return { relays: parseDoorRelays(data), cameras: parseCameras(data) };
  }

  async getDoorRelays() {
    return (await this.getDevices()).relays;
  }

  async openDoor(relay: Pick<DoorRelay, 'mac' | 'relayId'>) {
    await this.authenticated((token) => ({
      method: 'POST',
      url: `https://${this.credentials.host}/opendoor?token=${encodeURIComponent(token)}`,
      headers: {
        ...this.appHeaders(token, '4.3'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ mac: relay.mac, relay: relay.relayId }).toString(),
    }));
  }

  /**
   * Mint a new session token from the long-lived auth token
   * Concurrent callers share one request, and a token that was already replaced is not refreshed again
   */
  async refreshToken(failedToken = this.credentials.token): Promise<void> {
    if (this.refreshing) {
      return this.refreshing;
    }
    if (this.credentials.token !== failedToken) {
      return;
    }

    this.refreshing = (async () => {
      this.log.debug('Refreshing SmartPlus session token');
      let data;
      try {
        data = await sendRequest(this.fetchFn, {
          method: 'POST',
          url: gateUrl(this.credentials.subdomain, 'refresh_token'),
          headers: {
            'accept': '*/*',
            'content-type': 'application/json',
            'x-auth-token': this.credentials.token,
            'api-version': '6.8',
            'x-cloud-lang': 'en',
            'user-agent': REFRESH_USER_AGENT,
            'accept-language': ACCEPT_LANGUAGE,
          },
          body: JSON.stringify({ auth_token: this.credentials.authToken }),
        });
      } catch (error) {
        // Any rejection of the refresh means the saved login is no longer usable
        if (error instanceof AkuvoxApiError && error.kind === 'rejected') {
          throw new AkuvoxAuthError(error.message);
        }
        throw error;
      }
      if (!data?.token) {
        throw new AkuvoxAuthError('SmartPlus did not return a refreshed session token');
      }

      this.credentials = {
        ...this.credentials,
        token: String(data.token),
        authToken: data.auth_token ? String(data.auth_token) : this.credentials.authToken,
        refreshedAt: new Date().toISOString(),
      };
      await this.onCredentialsChanged(this.currentCredentials);
      this.log.debug('SmartPlus session token refreshed');
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private appHeaders(token: string, apiVersion: string): Record<string, string> {
    return {
      'X-AUTH-TOKEN': token,
      'api-version': apiVersion,
      'Accept': '*/*',
      'User-Agent': USER_AGENT,
      'Accept-Language': ACCEPT_LANGUAGE,
      'x-cloud-lang': 'en',
    };
  }

  /**
   * Send a request built around the current token, recovering the session and retrying once if it was rejected
   */
  private async authenticated(build: (token: string) => ApiRequest) {
    const token = this.credentials.token;
    try {
      return await sendRequest(this.fetchFn, build(token));
    } catch (error) {
      if (!(error instanceof AkuvoxAuthError)) {
        throw error;
      }
      this.log.debug('SmartPlus rejected the session token:', error.message);
      await this.recoverSession(token);
      return sendRequest(this.fetchFn, build(this.credentials.token));
    }
  }

  private async recoverSession(failedToken: string) {
    try {
      await this.refreshToken(failedToken);
    } catch (error) {
      if (!(error instanceof AkuvoxAuthError) || !this.relogin) {
        throw error;
      }
      await this.signInAgain(failedToken, error);
    }
  }

  /**
   * Replace a revoked session by signing in again, shared by concurrent callers like refreshToken
   */
  private async signInAgain(failedToken: string, cause: AkuvoxAuthError): Promise<void> {
    if (this.relogging) {
      return this.relogging;
    }
    if (this.credentials.token !== failedToken) {
      return;
    }
    if (Date.now() < this.reloginBlockedUntil) {
      throw cause;
    }

    this.relogging = (async () => {
      this.log.info('SmartPlus session ended, signing in again');
      try {
        this.credentials = await this.relogin!();
      } catch (error) {
        this.reloginBlockedUntil = Date.now() + RELOGIN_COOLDOWN_MS;
        throw error;
      }
      await this.onCredentialsChanged(this.currentCredentials);
    })().finally(() => {
      this.relogging = undefined;
    });
    return this.relogging;
  }
}
