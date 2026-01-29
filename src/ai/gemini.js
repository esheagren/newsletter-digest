/**
 * Gemini AI module - Cluster summaries and article selection
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFile } from 'fs/promises';
import { log, withRetry } from '../utils/helpers.js';
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3-pro-preview' });

const PROMPTS_DIR = new URL('../../prompts/', import.meta.url).pathname;

/**
 * Load prompt template from file
 */
async function loadPrompt(name) {
  const path = `${PROMPTS_DIR}${name}.txt`;
  return await readFile(path, 'utf-8');
}

/**
 * Format a single article for AI consumption
 */
function formatArticle(article, index) {
  const links = article.links?.slice(0, 3).map(l => `  - [${l.text}](${l.url})`).join('\n') || '';
  const primaryLink = article.links?.[0]?.url || '';

  return `
### Article ${index + 1}: ${article.subject}
**Source:** ${article.source}
**Date:** ${article.date.toLocaleDateString()}
**Word Count:** ${article.wordCount}
**Primary Link:** ${primaryLink}

${article.content}

${links ? `**Additional Links:**\n${links}` : ''}
---
`.trim();
}

/**
 * Format articles for the selection prompt (metadata only, not full content)
 */
function formatArticleMetadata(article, index) {
  const preview = article.content.slice(0, 300).replace(/\n/g, ' ');
  const primaryLink = article.links?.[0]?.url || '';

  return `${index + 1}. "${article.subject}" (${article.source}) - ${article.wordCount} words
   Link: ${primaryLink}
   Preview: ${preview}...`;
}

/**
 * Write a complete summary for a single cluster
 * This is an isolated call - no cross-contamination with other clusters
 */
export async function writeClusterSummary(cluster, clusterLabel) {
  const articles = cluster.articles;

  log(`Writing summary for cluster "${clusterLabel}" (${articles.length} articles)`, 'progress');

  if (articles.length === 0) {
    return {
      label: clusterLabel,
      summary: 'No articles in this cluster.',
      articleCount: 0
    };
  }

  const promptTemplate = await loadPrompt('gemini-cluster-summary');
  const formattedArticles = articles.map((a, i) => formatArticle(a, i)).join('\n\n');

  const prompt = promptTemplate
    .replace('{{CLUSTER_LABEL}}', clusterLabel)
    .replace('{{ARTICLE_COUNT}}', articles.length.toString())
    .replace('{{ARTICLES}}', formattedArticles);

  const result = await withRetry(async () => {
    const response = await model.generateContent(prompt);
    return response.response.text();
  }, 3, 2000);

  return {
    label: clusterLabel,
    summary: result,
    articleCount: articles.length
  };
}

/**
 * Select the top 3-4 most important articles from all articles
 * Returns the selected article objects with full content
 */
export async function selectTopArticles(allArticles, count = 4) {
  log(`Selecting top ${count} articles from ${allArticles.length} total...`, 'progress');

  if (allArticles.length <= count) {
    return {
      selected: allArticles,
      reasoning: 'All articles included due to small total count'
    };
  }

  const promptTemplate = await loadPrompt('gemini-select-top');

  // Send metadata only, not full content
  const metadata = allArticles.map((a, i) => formatArticleMetadata(a, i)).join('\n\n');

  const prompt = promptTemplate
    .replace('{{ARTICLE_COUNT}}', allArticles.length.toString())
    .replace('{{SELECT_COUNT}}', count.toString())
    .replace('{{ARTICLES}}', metadata);

  const result = await withRetry(async () => {
    const response = await model.generateContent(prompt);
    return response.response.text();
  }, 3, 2000);

  // Parse the response to extract selected indices
  try {
    // Look for JSON in the response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const indices = parsed.selected || parsed.indices || [];

      // Convert 1-indexed to 0-indexed if needed, and filter valid indices
      const selected = indices
        .map(i => typeof i === 'number' ? (i > allArticles.length ? i - 1 : i) : parseInt(i) - 1)
        .filter(i => i >= 0 && i < allArticles.length)
        .slice(0, count)
        .map(i => allArticles[i]);

      if (selected.length > 0) {
        return {
          selected,
          reasoning: parsed.reasoning || 'Selected based on significance and analytical value'
        };
      }
    }

    // Try to find numbers in the response
    const numbers = result.match(/\b(\d{1,3})\b/g);
    if (numbers) {
      const indices = numbers
        .map(n => parseInt(n) - 1) // Assume 1-indexed
        .filter(i => i >= 0 && i < allArticles.length)
        .slice(0, count);

      if (indices.length > 0) {
        return {
          selected: indices.map(i => allArticles[i]),
          reasoning: result.slice(0, 500)
        };
      }
    }
  } catch (e) {
    log(`Failed to parse selection response: ${e.message}`, 'warn');
  }

  // Fallback: return first N articles by word count
  log('Using fallback selection by article length', 'warn');
  const sorted = [...allArticles].sort((a, b) => b.wordCount - a.wordCount);
  return {
    selected: sorted.slice(0, count),
    reasoning: 'Fallback selection by article length'
  };
}

/**
 * Estimate tokens (approximate)
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
