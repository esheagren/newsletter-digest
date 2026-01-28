/**
 * Notion publishing module
 */

import { Client } from '@notionhq/client';
import { splitForNotion, log, withRetry } from '../utils/helpers.js';
import dotenv from 'dotenv';

dotenv.config();

const notion = new Client({
  auth: process.env.NOTION_API_KEY
});

const DATABASE_ID = process.env.NOTION_DATABASE_ID;

if (!DATABASE_ID) {
  throw new Error('NOTION_DATABASE_ID environment variable is required');
}

/**
 * Convert markdown-ish text to Notion blocks
 */
function textToNotionBlocks(text) {
  const blocks = [];
  const lines = text.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (!line.trim()) {
      i++;
      continue;
    }

    // Heading 1
    if (line.startsWith('# ')) {
      blocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: {
          rich_text: [{ type: 'text', text: { content: line.slice(2).trim() } }]
        }
      });
      i++;
      continue;
    }

    // Heading 2
    if (line.startsWith('## ')) {
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content: line.slice(3).trim() } }]
        }
      });
      i++;
      continue;
    }

    // Heading 3
    if (line.startsWith('### ')) {
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: {
          rich_text: [{ type: 'text', text: { content: line.slice(4).trim() } }]
        }
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (line.match(/^---+$/)) {
      blocks.push({
        object: 'block',
        type: 'divider',
        divider: {}
      });
      i++;
      continue;
    }

    // Bullet list
    if (line.startsWith('- ') || line.startsWith('* ')) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [{ type: 'text', text: { content: line.slice(2).trim() } }]
        }
      });
      i++;
      continue;
    }

    // Numbered list
    const numberedMatch = line.match(/^\d+\.\s+(.+)/);
    if (numberedMatch) {
      blocks.push({
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: {
          rich_text: [{ type: 'text', text: { content: numberedMatch[1].trim() } }]
        }
      });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      blocks.push({
        object: 'block',
        type: 'quote',
        quote: {
          rich_text: [{ type: 'text', text: { content: line.slice(2).trim() } }]
        }
      });
      i++;
      continue;
    }

    // Regular paragraph - collect consecutive lines
    let paragraph = line;
    i++;
    while (i < lines.length && lines[i].trim() && !lines[i].match(/^[#\-*>\d]/)) {
      paragraph += ' ' + lines[i].trim();
      i++;
    }

    // Split if too long for Notion
    const chunks = splitForNotion(paragraph.trim(), 2000);
    for (const chunk of chunks) {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: chunk } }]
        }
      });
    }
  }

  return blocks;
}

/**
 * Create a new page in the Notion database
 */
export async function publishToNotion(digest, metadata = {}) {
  const dateRange = metadata.dateRange || 'This Week';
  const title = `Weekly Digest: ${dateRange}`;

  log(`Publishing to Notion: "${title}"...`, 'progress');

  // Convert digest to Notion blocks
  const blocks = textToNotionBlocks(digest);

  // Notion API has a limit of 100 blocks per request
  const BLOCK_BATCH_SIZE = 100;

  const page = await withRetry(async () => {
    // Create the page first
    const response = await notion.pages.create({
      parent: {
        database_id: DATABASE_ID
      },
      properties: {
        // Title property (adjust property name if different in your database)
        Name: {
          title: [
            {
              text: {
                content: title
              }
            }
          ]
        },
        // Date property (optional)
        ...(metadata.date && {
          Date: {
            date: {
              start: metadata.date.toISOString().split('T')[0]
            }
          }
        }),
        // Status property (optional)
        Status: {
          select: {
            name: 'Published'
          }
        }
      },
      // Add first batch of blocks
      children: blocks.slice(0, BLOCK_BATCH_SIZE)
    });

    return response;
  }, 3, 2000);

  // Add remaining blocks in batches
  if (blocks.length > BLOCK_BATCH_SIZE) {
    for (let i = BLOCK_BATCH_SIZE; i < blocks.length; i += BLOCK_BATCH_SIZE) {
      const batch = blocks.slice(i, i + BLOCK_BATCH_SIZE);
      await withRetry(async () => {
        await notion.blocks.children.append({
          block_id: page.id,
          children: batch
        });
      }, 3, 1000);

      log(`Added blocks ${i + 1}-${Math.min(i + BLOCK_BATCH_SIZE, blocks.length)} of ${blocks.length}`, 'progress');
    }
  }

  log(`Published to Notion: ${page.url}`, 'success');

  return {
    pageId: page.id,
    url: page.url,
    title,
    blockCount: blocks.length
  };
}

/**
 * Update an existing Notion page
 */
export async function updateNotionPage(pageId, updates) {
  return await notion.pages.update({
    page_id: pageId,
    properties: updates
  });
}

/**
 * Verify database connection and schema
 */
export async function verifyDatabase() {
  try {
    const database = await notion.databases.retrieve({
      database_id: DATABASE_ID
    });

    log(`Connected to Notion database: ${database.title[0]?.plain_text || DATABASE_ID}`, 'success');

    // Check for required properties
    const properties = Object.keys(database.properties);
    const hasTitle = properties.some(p =>
      database.properties[p].type === 'title'
    );

    if (!hasTitle) {
      log('Warning: Database may not have a title property', 'warn');
    }

    return {
      connected: true,
      databaseId: DATABASE_ID,
      properties: properties
    };
  } catch (error) {
    log(`Failed to connect to Notion database: ${error.message}`, 'error');
    return {
      connected: false,
      error: error.message
    };
  }
}

export { DATABASE_ID };
