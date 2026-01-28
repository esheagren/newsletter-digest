/**
 * Gmail OAuth 2.0 authentication module
 */

import { google } from 'googleapis';
import { readFile, writeFile, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { createInterface } from 'readline';
import { log } from '../utils/helpers.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = new URL('../../token.json', import.meta.url).pathname;
const CREDENTIALS_PATH = new URL('../../credentials.json', import.meta.url).pathname;

/**
 * Load credentials from file or environment variable
 */
async function loadCredentials() {
  // Try environment variable first (for CI)
  if (process.env.GMAIL_CREDENTIALS_BASE64) {
    const decoded = Buffer.from(process.env.GMAIL_CREDENTIALS_BASE64, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  }

  // Fall back to file
  if (existsSync(CREDENTIALS_PATH)) {
    const content = await readFile(CREDENTIALS_PATH, 'utf-8');
    return JSON.parse(content);
  }

  throw new Error(
    'Gmail credentials not found. Either:\n' +
    '1. Place credentials.json in project root, or\n' +
    '2. Set GMAIL_CREDENTIALS_BASE64 environment variable'
  );
}

/**
 * Load saved token from file or environment variable
 */
async function loadToken() {
  // Try environment variable first (for CI)
  if (process.env.GMAIL_TOKEN_BASE64) {
    const decoded = Buffer.from(process.env.GMAIL_TOKEN_BASE64, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  }

  // Fall back to file
  if (existsSync(TOKEN_PATH)) {
    const content = await readFile(TOKEN_PATH, 'utf-8');
    return JSON.parse(content);
  }

  return null;
}

/**
 * Save token to file
 */
async function saveToken(token) {
  await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2));
  await chmod(TOKEN_PATH, 0o600); // Owner read/write only
  log(`Token saved to ${TOKEN_PATH} with secure permissions`, 'success');
}

/**
 * Get authorization code interactively
 */
async function getAuthCodeInteractive(authUrl) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    console.log('\nAuthorize this app by visiting this URL:\n');
    console.log(authUrl);
    console.log();
    rl.question('Enter the authorization code: ', (code) => {
      rl.close();
      resolve(code.trim());
    });
  });
}

/**
 * Create OAuth2 client and authenticate
 */
export async function authorize() {
  const credentials = await loadCredentials();
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  // Try to load existing token
  const token = await loadToken();

  if (token) {
    oAuth2Client.setCredentials(token);

    // Check if token needs refresh
    if (token.expiry_date && token.expiry_date < Date.now()) {
      log('Token expired, refreshing...', 'progress');
      try {
        const { credentials: newToken } = await oAuth2Client.refreshAccessToken();
        oAuth2Client.setCredentials(newToken);
        await saveToken(newToken);
        log('Token refreshed successfully', 'success');
      } catch (error) {
        log('Failed to refresh token, need to re-authenticate', 'warn');
        return await getNewToken(oAuth2Client);
      }
    }

    return oAuth2Client;
  }

  // No token, need to authenticate
  return await getNewToken(oAuth2Client);
}

/**
 * Get new token via OAuth flow
 */
async function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES
  });

  // In CI mode, we can't do interactive auth
  if (process.env.CI) {
    throw new Error(
      'No valid token found and running in CI mode.\n' +
      'Please run `npm run auth` locally first to generate token.json,\n' +
      'then base64 encode it and set GMAIL_TOKEN_BASE64 secret.'
    );
  }

  const code = await getAuthCodeInteractive(authUrl);

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  await saveToken(tokens);

  return oAuth2Client;
}

/**
 * Get Gmail API client
 */
export async function getGmailClient() {
  const auth = await authorize();
  return google.gmail({ version: 'v1', auth });
}

// Run auth flow if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await authorize();
    log('Authentication successful!', 'success');
  } catch (error) {
    log(`Authentication failed: ${error.message}`, 'error');
    process.exit(1);
  }
}
