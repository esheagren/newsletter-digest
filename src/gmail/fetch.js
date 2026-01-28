/**
 * Gmail email fetching module
 */

import { getGmailClient } from './auth.js';
import { log, sleep } from '../utils/helpers.js';

const DAYS_TO_FETCH = parseInt(process.env.DAYS_TO_FETCH || '7', 10);
const MAX_EMAILS = parseInt(process.env.MAX_EMAILS || '1000', 10);

/**
 * Decode base64 email body
 */
function decodeBody(body) {
  if (!body?.data) return '';
  return Buffer.from(body.data, 'base64url').toString('utf-8');
}

/**
 * Extract body from email parts recursively
 */
function extractBody(payload) {
  const result = { html: '', text: '' };

  if (payload.body?.data) {
    const content = decodeBody(payload.body);
    if (payload.mimeType === 'text/html') {
      result.html = content;
    } else if (payload.mimeType === 'text/plain') {
      result.text = content;
    }
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const partResult = extractBody(part);
      if (partResult.html) result.html = partResult.html;
      if (partResult.text) result.text = partResult.text;
    }
  }

  return result;
}

/**
 * Get header value from email
 */
function getHeader(headers, name) {
  const header = headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

/**
 * Fetch all emails from the past N days
 */
export async function fetchEmails(daysBack = DAYS_TO_FETCH) {
  const gmail = await getGmailClient();
  const query = `newer_than:${daysBack}d`;

  log(`Fetching emails from past ${daysBack} days (max ${MAX_EMAILS})...`, 'progress');

  const emails = [];
  let pageToken = null;
  let totalFetched = 0;

  do {
    // List messages matching query
    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 100,
      pageToken: pageToken || undefined
    });

    const messages = listResponse.data.messages || [];
    pageToken = listResponse.data.nextPageToken;

    // Fetch full message content for each
    for (const msg of messages) {
      // Safety check to prevent memory issues
      if (emails.length >= MAX_EMAILS) {
        log(`Reached maximum email limit (${MAX_EMAILS}), stopping fetch`, 'warn');
        break;
      }

      try {
        const fullMessage = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full'
        });

        const headers = fullMessage.data.payload?.headers || [];
        const body = extractBody(fullMessage.data.payload);

        emails.push({
          id: msg.id,
          threadId: msg.threadId,
          sender: getHeader(headers, 'From'),
          subject: getHeader(headers, 'Subject'),
          date: getHeader(headers, 'Date'),
          bodyHtml: body.html,
          bodyText: body.text,
          labels: fullMessage.data.labelIds || []
        });

        totalFetched++;

        // Rate limiting - be gentle with the API
        if (totalFetched % 10 === 0) {
          log(`Fetched ${totalFetched} emails...`, 'progress');
          await sleep(100);
        }
      } catch (error) {
        log(`Failed to fetch message ${msg.id}: ${error.message}`, 'warn');
      }
    }

    // Break outer loop if we hit the limit
    if (emails.length >= MAX_EMAILS) {
      break;
    }
  } while (pageToken);

  log(`Fetched ${emails.length} total emails`, 'success');
  return emails;
}

/**
 * Filter emails to likely newsletters
 */
export function filterNewsletters(emails) {
  const newsletterIndicators = [
    'newsletter',
    'digest',
    'weekly',
    'substack',
    'mailchimp',
    'convertkit',
    'buttondown',
    'revue',
    'list-unsubscribe',
    'unsubscribe'
  ];

  return emails.filter(email => {
    const combined = `${email.sender} ${email.subject} ${email.bodyHtml}`.toLowerCase();
    return newsletterIndicators.some(indicator => combined.includes(indicator));
  });
}

// Run fetch if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const emails = await fetchEmails();
    const newsletters = filterNewsletters(emails);
    log(`Found ${newsletters.length} newsletters out of ${emails.length} emails`, 'success');

    // Print summary
    for (const email of newsletters.slice(0, 10)) {
      console.log(`- ${email.sender}: ${email.subject}`);
    }
    if (newsletters.length > 10) {
      console.log(`... and ${newsletters.length - 10} more`);
    }
  } catch (error) {
    log(`Failed to fetch emails: ${error.message}`, 'error');
    process.exit(1);
  }
}
