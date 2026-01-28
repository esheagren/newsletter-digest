/**
 * Newsletter content extraction module
 */

import * as cheerio from 'cheerio';
import { convert } from 'html-to-text';
import { generateArticleId, log } from '../utils/helpers.js';

/**
 * Common newsletter footer patterns to remove
 */
const FOOTER_PATTERNS = [
  /unsubscribe/i,
  /manage\s*(your)?\s*preferences/i,
  /update\s*(your)?\s*subscription/i,
  /view\s*(this)?\s*(email)?\s*in\s*(your)?\s*browser/i,
  /sent\s*(to|by)/i,
  /you('re)?\s*receiving\s*this/i,
  /forward\s*to\s*a\s*friend/i,
  /copyright\s*©/i,
  /all\s*rights\s*reserved/i,
  /privacy\s*policy/i,
  /terms\s*(of\s*service|&\s*conditions)/i
];

/**
 * Common header patterns to remove
 */
const HEADER_PATTERNS = [
  /view\s*(this)?\s*(email)?\s*in\s*(your)?\s*browser/i,
  /having\s*trouble\s*viewing/i,
  /click\s*here\s*to\s*view/i,
  /email\s*not\s*displaying/i
];

/**
 * Elements typically containing navigation/boilerplate
 */
const REMOVE_SELECTORS = [
  'header',
  'footer',
  'nav',
  '.footer',
  '.header',
  '.navigation',
  '.unsubscribe',
  '.email-footer',
  '.social-links',
  '.social-icons',
  '[class*="unsubscribe"]',
  '[class*="footer"]',
  '[class*="header"]',
  '[role="navigation"]',
  'style',
  'script',
  'noscript'
];

/**
 * Extract clean content from newsletter HTML
 */
export function extractContent(html, source, subject) {
  if (!html) return null;

  let $;
  try {
    $ = cheerio.load(html);
  } catch (error) {
    log(`Failed to parse HTML for "${subject}": ${error.message}`, 'error');
    return null;
  }

  // Remove unwanted elements
  for (const selector of REMOVE_SELECTORS) {
    $(selector).remove();
  }

  // Remove elements matching footer patterns
  $('*').each((_, el) => {
    const text = $(el).text();
    const isFooter = FOOTER_PATTERNS.some(pattern => pattern.test(text));
    const isHeader = HEADER_PATTERNS.some(pattern => pattern.test(text));

    if ((isFooter || isHeader) && text.length < 500) {
      $(el).remove();
    }
  });

  // Extract links before converting to text
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (href && !href.startsWith('mailto:') && !href.includes('unsubscribe') && text) {
      links.push({ text, url: href });
    }
  });

  // Convert to plain text
  const content = convert($.html(), {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'table', format: 'dataTable' }
    ]
  });

  // Clean up whitespace
  const cleanContent = content
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  // Remove any remaining footer content
  const lines = cleanContent.split('\n');
  const filteredLines = [];
  let footerStarted = false;

  for (const line of lines) {
    if (!footerStarted && FOOTER_PATTERNS.some(p => p.test(line))) {
      footerStarted = true;
    }
    if (!footerStarted) {
      filteredLines.push(line);
    }
  }

  return {
    content: filteredLines.join('\n').trim(),
    links: dedupeLinks(links)
  };
}

/**
 * Remove duplicate links
 */
function dedupeLinks(links) {
  const seen = new Set();
  return links.filter(link => {
    const key = link.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Parse sender email to get source name
 */
function parseSource(sender) {
  // Try to extract name from "Name <email>" format
  const nameMatch = sender.match(/^([^<]+)</);
  if (nameMatch) {
    return nameMatch[1].trim().replace(/"/g, '');
  }

  // Try to extract domain from email
  const emailMatch = sender.match(/@([^>]+)/);
  if (emailMatch) {
    return emailMatch[1].split('.')[0];
  }

  return sender;
}

/**
 * Process a batch of emails into article objects
 */
export function processEmails(emails) {
  const articles = [];

  for (const email of emails) {
    const source = parseSource(email.sender);
    const extracted = extractContent(email.bodyHtml || email.bodyText, source, email.subject);

    if (!extracted || extracted.content.length < 100) {
      log(`Skipping short/empty email: ${email.subject}`, 'warn');
      continue;
    }

    const date = new Date(email.date);

    articles.push({
      id: generateArticleId(source, email.subject, email.date),
      emailId: email.id,
      source,
      subject: email.subject,
      date: isNaN(date.getTime()) ? new Date() : date,
      content: extracted.content,
      links: extracted.links,
      wordCount: extracted.content.split(/\s+/).length
    });
  }

  log(`Extracted ${articles.length} articles from ${emails.length} emails`, 'success');
  return articles;
}

/**
 * Get newsletter format type (for specialized parsing)
 */
export function detectNewsletterFormat(html, sender) {
  const lowerSender = sender.toLowerCase();
  const lowerHtml = html?.toLowerCase() || '';

  if (lowerSender.includes('substack') || lowerHtml.includes('substack')) {
    return 'substack';
  }
  if (lowerHtml.includes('mailchimp') || lowerHtml.includes('mc_cid')) {
    return 'mailchimp';
  }
  if (lowerHtml.includes('convertkit')) {
    return 'convertkit';
  }
  if (lowerHtml.includes('buttondown')) {
    return 'buttondown';
  }
  return 'generic';
}

// Test extraction if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  // Test with sample HTML
  const sampleHtml = `
    <html>
      <body>
        <div class="header">View in browser</div>
        <div class="content">
          <h1>Weekly Tech Digest</h1>
          <p>This week in tech, we saw amazing developments in AI...</p>
          <p>Here are the top stories:</p>
          <ul>
            <li><a href="https://example.com/story1">Story 1</a></li>
            <li><a href="https://example.com/story2">Story 2</a></li>
          </ul>
        </div>
        <div class="footer">
          <p>Unsubscribe from this newsletter</p>
          <p>Copyright © 2024</p>
        </div>
      </body>
    </html>
  `;

  const result = extractContent(sampleHtml, 'Test Newsletter', 'Weekly Digest');
  console.log('Extracted content:');
  console.log(result.content);
  console.log('\nLinks found:', result.links.length);
}
