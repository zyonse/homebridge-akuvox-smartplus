#!/usr/bin/env node
/* eslint-disable no-console */
import os from 'os';
import path from 'path';
import readline from 'readline/promises';
import { Writable } from 'stream';

import AkuvoxAPI, {
  AkuvoxCredentials, REGIONS, beginEmailLogin, sendEmailCode, verifyEmailCode, sendSmsCode, smsLogin,
} from './AkuvoxAPI';
import { credentialsPath, saveCredentials } from './credentials';

/**
 * Interactive one-time SmartPlus login
 * Saves session tokens into the Homebridge storage directory, where the plugin reads and refreshes them
 */

const USAGE = `Usage: akuvox-smartplus-login [--storage <homebridge storage path>] [--region <${REGIONS.join('|')}>]

Signs in to Akuvox SmartPlus and saves the session for homebridge-akuvox-smartplus.
Defaults: --storage ~/.homebridge, --region ucloud (US)`;

function parseArgs(argv: string[]) {
  const options = { storage: path.join(os.homedir(), '.homebridge'), region: 'ucloud' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else if ((arg === '--storage' || arg === '-U') && argv[i + 1]) {
      options.storage = path.resolve(argv[++i].replace(/^~(?=$|\/)/, os.homedir()));
    } else if (arg === '--region' && argv[i + 1]) {
      options.region = argv[++i];
    } else {
      console.error(`Unknown argument: ${arg}\n\n${USAGE}`);
      process.exit(1);
    }
  }
  if (!REGIONS.includes(options.region)) {
    console.error(`Unknown region ${options.region}, expected one of ${REGIONS.join(', ')}`);
    process.exit(1);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  // Mutable output lets the password prompt hide what's typed
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) {
        process.stdout.write(chunk, encoding);
      }
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  const ask = async (question: string, fallback = '') => {
    const answer = (await rl.question(question)).trim();
    return answer || fallback;
  };
  const askSecret = async (question: string) => {
    process.stdout.write(question);
    muted = true;
    try {
      return await rl.question('');
    } finally {
      muted = false;
      process.stdout.write('\n');
    }
  };

  try {
    console.log(`Akuvox SmartPlus login (region ${options.region})`);
    console.log('Note: SmartPlus allows one app session per account, so this will likely sign out the SmartPlus app on your phone.\n');

    const method = (await ask('Sign in with [e]mail/password or [s]ms? [e] ', 'e')).toLowerCase();
    let credentials: AkuvoxCredentials;

    if (method.startsWith('s')) {
      const countryCode = await ask('Country calling code [1]: ', '1');
      const phoneNumber = await ask('Phone number: ');
      const host = await sendSmsCode(options.region, countryCode, phoneNumber);
      const code = await ask('Code from SMS: ');
      credentials = await smsLogin(options.region, countryCode, phoneNumber, code, host);
    } else {
      const account = await ask('Email or username: ');
      const password = await askSecret('Password: ');
      // Try the chosen region, then the global gateway like the app does
      const regions = [...new Set([options.region, 'ecloud'])];
      const result = await beginEmailLogin(account, password, regions);
      if ('credentials' in result) {
        credentials = result.credentials;
      } else {
        await sendEmailCode(result.host, account, result.tempToken);
        const code = await ask('Code from verification email: ');
        credentials = await verifyEmailCode(result.subdomain, result.host, account, code);
      }
      credentials = { ...credentials, account };
    }

    const api = new AkuvoxAPI(credentials, console, (updated) => {
      credentials = updated;
    });
    const relays = await api.getDoorRelays();
    await saveCredentials(options.storage, api.currentCredentials);

    console.log(`\nSigned in on ${credentials.subdomain}, saved session to ${credentialsPath(options.storage)}`);
    if (relays.length) {
      console.log('Door relays on this account (use these names in the plugin\'s "doors" config):');
      for (const relay of relays) {
        console.log(`  - ${relay.doorName}  (device "${relay.deviceName}", id ${relay.id})`);
      }
    } else {
      console.log('No door relays were found on this account.');
    }
    console.log('\nRestart Homebridge to load the new login.');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`\nLogin failed: ${error.message}`);
  process.exit(1);
});
