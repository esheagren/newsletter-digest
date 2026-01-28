/**
 * Gemini AI curation module
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFile } from 'fs/promises';
import { log, withRetry } from '../utils/helpers.js';
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

const PROMPTS_DIR = new URL('../../prompts/', import.meta.url).pathname;

/**
 * Load prompt template from file
 */
async function loadPrompt(name) {
  const path = `${PROMPTS_DIR}${name}.txt`;
  return await readFile(path, 'utf-8');
}

/**
 * Format articles for AI consumption
 */
function formatArticlesForAI(articles) {
  return articles.map((article, i) => {
    const links = article.links?.slice(0, 5).map(l => `  - ${l.text}: ${l.url}`).join('\n') || '';
    return `
### Article ${i + 1}: ${article.subject}
**Source:** ${article.source}
**Date:** ${article.date.toLocaleDateString()}
**Word Count:** ${article.wordCount}

${article.content}

${links ? `**Key Links:**\n${links}` : ''}
---
`.trim();
  }).join('\n\n');
}

/**
 * Determine curation strategy based on article count
 */
function getCurationStrategy(articleCount) {
  if (articleCount >= 30) {
    return {
      strategy: 'heavy',
      keepFull: 2,
      synthesize: true,
      description: 'Heavy compression - keep 2-3 best, heavily synthesize rest'
    };
  }
  if (articleCount >= 10) {
    return {
      strategy: 'moderate',
      keepFull: 4,
      synthesize: true,
      description: 'Moderate compression - keep 3-4 best, light synthesis'
    };
  }
  if (articleCount >= 3) {
    return {
      strategy: 'light',
      keepFull: articleCount - 1,
      synthesize: false,
      description: 'Light curation - keep most articles, minimal synthesis'
    };
  }
  return {
    strategy: 'passthrough',
    keepFull: articleCount,
    synthesize: false,
    description: 'Pass through - too few to synthesize'
  };
}

/**
 * Curate a main topic cluster
 */
export async function curateMainCluster(cluster, clusterLabel) {
  const articles = cluster.articles;
  const strategy = getCurationStrategy(articles.length);

  log(`Curating main cluster "${clusterLabel}" (${articles.length} articles, ${strategy.strategy} strategy)`, 'progress');

  if (strategy.strategy === 'passthrough') {
    return {
      label: clusterLabel,
      articles: articles,
      summary: null,
      strategy: strategy.strategy
    };
  }

  const promptTemplate = await loadPrompt('gemini-main-cluster');
  const formattedArticles = formatArticlesForAI(articles);

  const prompt = promptTemplate
    .replace('{{CLUSTER_LABEL}}', clusterLabel)
    .replace('{{ARTICLE_COUNT}}', articles.length.toString())
    .replace('{{STRATEGY}}', strategy.description)
    .replace('{{KEEP_FULL}}', strategy.keepFull.toString())
    .replace('{{ARTICLES}}', formattedArticles);

  const result = await withRetry(async () => {
    const response = await model.generateContent(prompt);
    return response.response.text();
  }, 3, 2000);

  return {
    label: clusterLabel,
    originalArticleCount: articles.length,
    curatedContent: result,
    strategy: strategy.strategy
  };
}

/**
 * Curate the miscellaneous/long tail cluster
 */
export async function curateMiscCluster(cluster) {
  const articles = cluster.articles;

  log(`Curating miscellaneous cluster (${articles.length} articles)`, 'progress');

  if (articles.length === 0) {
    return {
      label: 'Long Tail',
      articles: [],
      summary: null
    };
  }

  if (articles.length <= 3) {
    return {
      label: 'Long Tail',
      articles: articles,
      summary: null,
      strategy: 'passthrough'
    };
  }

  const promptTemplate = await loadPrompt('gemini-misc-cluster');
  const formattedArticles = formatArticlesForAI(articles);

  const prompt = promptTemplate
    .replace('{{ARTICLE_COUNT}}', articles.length.toString())
    .replace('{{ARTICLES}}', formattedArticles);

  const result = await withRetry(async () => {
    const response = await model.generateContent(prompt);
    return response.response.text();
  }, 3, 2000);

  return {
    label: 'Long Tail',
    originalArticleCount: articles.length,
    curatedContent: result,
    strategy: 'misc'
  };
}

/**
 * Select best articles of the week
 */
export async function selectBestOfWeek(allArticles) {
  log(`Selecting best of week from ${allArticles.length} articles...`, 'progress');

  if (allArticles.length <= 5) {
    return {
      selected: allArticles,
      reasoning: 'All articles included due to small total count'
    };
  }

  const promptTemplate = await loadPrompt('gemini-best-of');

  // Only send summaries to reduce token usage
  const summaries = allArticles.map((article, i) => ({
    index: i,
    source: article.source,
    subject: article.subject,
    preview: article.content.slice(0, 500),
    wordCount: article.wordCount
  }));

  const prompt = promptTemplate
    .replace('{{ARTICLE_COUNT}}', allArticles.length.toString())
    .replace('{{ARTICLES}}', JSON.stringify(summaries, null, 2));

  const result = await withRetry(async () => {
    const response = await model.generateContent(prompt);
    return response.response.text();
  }, 3, 2000);

  // Parse the response to extract selected indices
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const indices = parsed.selected || parsed.indices || [];
      const selected = indices
        .filter(i => i >= 0 && i < allArticles.length)
        .map(i => allArticles[i]);

      return {
        selected: selected.slice(0, 5),
        reasoning: parsed.reasoning || result
      };
    }
  } catch (e) {
    log('Failed to parse best-of selection, using fallback', 'warn');
  }

  // Fallback: return first 5 by word count
  const sorted = [...allArticles].sort((a, b) => b.wordCount - a.wordCount);
  return {
    selected: sorted.slice(0, 5),
    reasoning: 'Fallback selection by article length'
  };
}

/**
 * Track token usage (approximate)
 */
export function estimateTokens(text) {
  // Rough estimate: 4 characters per token
  return Math.ceil(text.length / 4);
}
