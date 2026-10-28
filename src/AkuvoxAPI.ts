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
  const digest = doubleMd5(password);
  const loginNames = [caesarShift(account)];
  if (/\d/.test(account)) {
    loginNames.push(caesarShift(account, true));
  }

  for (const subdomain of regions) {
    for (const loginName of loginNames) {
      const params = new URLSearchParams({ user: loginName, passwd: digest, id_code: '(null)' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any;
      try {
        data = await sendRequest(fetchFn, {
          method: 'GET',
          url: `${gateUrl(subdomain, 'login')}?${params}`,
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

/**
 * An authenticated SmartPlus session that refreshes its token when it expires
 */
export default class AkuvoxAPI {
  private refreshing?: Promise<void>;

  constructor(
    private credentials: AkuvoxCredentials,
    private readonly log: AkuvoxLogger,
    private readonly onCredentialsChanged: (credentials: AkuvoxCredentials) => void | Promise<void> = () => undefined,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  get currentCredentials(): AkuvoxCredentials {
    return { ...this.credentials };
  }

  async getDoorRelays() {
    const data = await this.authenticated((token) => ({
      method: 'GET',
      url: `https://${this.credentials.host}/userconf?token=${encodeURIComponent(token)}`,
      headers: this.appHeaders(token, '6.5'),
    }));
    return parseDoorRelays(data);
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
   * Send a request built around the current token, refreshing and retrying once if the session was rejected
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
      await this.refreshToken(token);
      return sendRequest(this.fetchFn, build(this.credentials.token));
    }
  }
}
