import { promises as fs } from 'fs';
import path from 'path';

import { AkuvoxCredentials } from './AkuvoxAPI';
import { CREDENTIALS_FILE } from './settings';

export function credentialsPath(storagePath: string) {
  return path.join(storagePath, CREDENTIALS_FILE);
}

/**
 * Read the credentials saved by the login CLI, or undefined if the user hasn't logged in yet
 */
export async function loadCredentials(storagePath: string): Promise<AkuvoxCredentials | undefined> {
  let text: string;
  try {
    text = await fs.readFile(credentialsPath(storagePath), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const data = JSON.parse(text);
  if (!data?.subdomain || !data?.host || !data?.authToken || !data?.token) {
    throw new Error(`${credentialsPath(storagePath)} is missing required fields`);
  }
  return data;
}

/**
 * Write credentials atomically, readable only by the Homebridge user
 */
export async function saveCredentials(storagePath: string, credentials: AkuvoxCredentials) {
  const file = credentialsPath(storagePath);
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
}
