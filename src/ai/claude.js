/**
 * Claude AI digest writing module
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'fs/promises';
import { log, withRetry } from '../utils/helpers.js';
import dotenv from 'dotenv';

dotenv.config();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 16000; // Allow for long digest

const PROMPTS_DIR = new URL('../../prompts/', import.meta.url).pathname;

/**
 * Load prompt template from file
 */
async function loadPrompt(name) {
  const path = `${PROMPTS_DIR}${name}.txt`;
  return await readFile(path, 'utf-8');
}

/**
 * Format curated content for Claude
 */
function formatCuratedContent(bestOf, mainClusters, miscCluster) {
  let content = '';

  // Best of Week section
  content += '## BEST OF WEEK\n\n';
  if (bestOf.reasoning) {
    content += `Selection reasoning: ${bestOf.reasoning}\n\n`;
  }
  for (const article of bestOf.selected) {
    content += `### ${article.subject}\n`;
    content += `**Source:** ${article.source}\n`;
    content += `**Date:** ${article.date.toLocaleDateString()}\n\n`;
    content += `${article.content}\n\n`;
    content += '---\n\n';
  }

  // Main topic sections
  content += '## MAIN TOPICS\n\n';
  for (const cluster of mainClusters) {
    content += `### ${cluster.label}\n`;
    content += `(${cluster.originalArticleCount || cluster.articles?.length || 0} articles, ${cluster.strategy} curation)\n\n`;

    if (cluster.curatedContent) {
      content += cluster.curatedContent;
    } else if (cluster.articles) {
      for (const article of cluster.articles) {
        content += `#### ${article.subject}\n`;
        content += `${article.content.slice(0, 1000)}...\n\n`;
      }
    }
    content += '\n---\n\n';
  }

  // Long tail section
  content += '## LONG TAIL / MISCELLANEOUS\n\n';
  if (miscCluster.curatedContent) {
    content += miscCluster.curatedContent;
  } else if (miscCluster.articles) {
    for (const article of miscCluster.articles) {
      content += `### ${article.subject}\n`;
      content += `**Source:** ${article.source}\n\n`;
      content += `${article.content.slice(0, 500)}...\n\n`;
    }
  }

  return content;
}

/**
 * Write the final digest using Claude
 */
export async function writeDigest(bestOf, mainClusters, miscCluster, metadata = {}) {
  log('Writing final digest with Claude...', 'progress');

  const promptTemplate = await loadPrompt('claude-digest');
  const curatedContent = formatCuratedContent(bestOf, mainClusters, miscCluster);

  const dateRange = metadata.dateRange || 'This Week';
  const totalArticles = metadata.totalArticles || 0;

  const prompt = promptTemplate
    .replace('{{DATE_RANGE}}', dateRange)
    .replace('{{TOTAL_ARTICLES}}', totalArticles.toString())
    .replace('{{CURATED_CONTENT}}', curatedContent);

  const result = await withRetry(async () => {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    return {
      content: response.content[0].text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens
      }
    };
  }, 3, 2000);

  log(`Digest written: ${result.content.length} characters, ${result.usage.outputTokens} tokens`, 'success');

  return {
    digest: result.content,
    usage: result.usage,
    metadata: {
      model: MODEL,
      dateRange,
      totalArticles
    }
  };
}

/**
 * Estimate the word count of the digest
 */
export function estimateWordCount(text) {
  return text.split(/\s+/).length;
}

export { MODEL };
