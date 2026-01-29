/**
 * Claude AI module - Deep analysis of top articles only
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
const MAX_TOKENS = 16000; // For deep analysis section

const PROMPTS_DIR = new URL('../../prompts/', import.meta.url).pathname;

/**
 * Load prompt template from file
 */
async function loadPrompt(name) {
  const path = `${PROMPTS_DIR}${name}.txt`;
  return await readFile(path, 'utf-8');
}

/**
 * Format a single article with full content for Claude
 */
function formatArticleForAnalysis(article, index) {
  const links = article.links?.slice(0, 5).map(l => `- [${l.text}](${l.url})`).join('\n') || '';
  const primaryLink = article.links?.[0]?.url || '';

  return `
## Article ${index + 1}: ${article.subject}

**Source:** ${article.source}
**Date:** ${article.date.toLocaleDateString()}
**Word Count:** ${article.wordCount}
**Primary Link:** ${primaryLink}

### Full Content

${article.content}

${links ? `### Links from Article\n${links}` : ''}

---
`.trim();
}

/**
 * Write deep analysis of the top selected articles
 * Claude receives FULL content of only 3-4 articles - no contamination possible
 */
export async function writeDeepAnalysis(selectedArticles, metadata = {}) {
  log(`Writing deep analysis for ${selectedArticles.length} top articles with Claude...`, 'progress');

  const promptTemplate = await loadPrompt('claude-deep-analysis');

  // Format each article with full content
  const formattedArticles = selectedArticles
    .map((article, i) => formatArticleForAnalysis(article, i))
    .join('\n\n');

  const dateRange = metadata.dateRange || 'This Week';
  const totalArticles = metadata.totalArticles || 0;

  const prompt = promptTemplate
    .replace('{{DATE_RANGE}}', dateRange)
    .replace('{{TOTAL_ARTICLES}}', totalArticles.toString())
    .replace('{{SELECTED_COUNT}}', selectedArticles.length.toString())
    .replace('{{ARTICLES}}', formattedArticles);

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

  log(`Deep analysis complete: ${result.content.length} characters`, 'success');

  return {
    analysis: result.content,
    usage: result.usage
  };
}

/**
 * Combine Claude's deep analysis with Gemini's cluster summaries into final digest
 */
export function assembleDigest(deepAnalysis, clusterSummaries, metadata = {}) {
  const dateRange = metadata.dateRange || 'This Week';
  const totalArticles = metadata.totalArticles || 0;

  let digest = `# Weekly Research Digest\n\n`;
  digest += `**${dateRange}** | ${totalArticles} articles processed\n\n`;
  digest += `---\n\n`;

  // Executive summary placeholder
  digest += `## Executive Summary\n\n`;
  digest += `This digest covers ${totalArticles} articles across ${clusterSummaries.length} topic areas. `;
  digest += `The deep analysis section examines the most significant pieces in detail.\n\n`;
  digest += `---\n\n`;

  // Claude's deep analysis of top articles
  digest += `## Top Stories: Deep Analysis\n\n`;
  digest += deepAnalysis;
  digest += `\n\n---\n\n`;

  // Gemini's cluster summaries
  digest += `## Topic Coverage\n\n`;
  for (const cluster of clusterSummaries) {
    if (cluster.summary && cluster.articleCount > 0) {
      digest += cluster.summary;
      digest += `\n\n---\n\n`;
    }
  }

  // Open questions section
  digest += `## Open Questions\n\n`;
  digest += `*What remains uncertain or warrants continued monitoring across these topics.*\n\n`;

  return digest;
}

/**
 * Estimate word count
 */
export function estimateWordCount(text) {
  return text.split(/\s+/).length;
}

export { MODEL };
