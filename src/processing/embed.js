/**
 * OpenAI embeddings module
 */

import OpenAI from 'openai';
import { chunk, sleep, log, withRetry } from '../utils/helpers.js';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 20; // Smaller batches to stay under token limits
const MAX_INPUT_TOKENS = 8191; // Model limit per individual text
const MAX_CHARS_PER_ARTICLE = 6000; // ~1500 tokens per article, safe margin

/**
 * Truncate text to fit within token limit
 * Using smaller limit per article so batches don't exceed total API limit
 */
function truncateForEmbedding(text, maxChars = MAX_CHARS_PER_ARTICLE) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

/**
 * Prepare article text for embedding
 */
function prepareText(article) {
  // Combine subject and content for richer embedding
  const text = `${article.subject}\n\n${article.content}`;
  return truncateForEmbedding(text);
}

/**
 * Generate embeddings for a batch of texts
 */
async function embedBatch(texts) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts
  });

  return response.data.map(d => d.embedding);
}

/**
 * Generate embeddings for all articles
 */
export async function generateEmbeddings(articles) {
  log(`Generating embeddings for ${articles.length} articles...`, 'progress');

  const results = [];
  const failed = [];
  const batches = chunk(articles, BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    log(`Processing batch ${i + 1}/${batches.length}...`, 'progress');

    const texts = batch.map(article => prepareText(article));

    try {
      const embeddings = await withRetry(
        () => embedBatch(texts),
        3,
        1000
      );

      for (let j = 0; j < batch.length; j++) {
        results.push({
          article: batch[j],
          embedding: embeddings[j]
        });
      }
    } catch (error) {
      log(`Failed to embed batch ${i + 1}: ${error.message}`, 'error');
      failed.push(...batch.map(a => a.id));
      // Continue processing other batches
    }

    // Rate limiting between batches
    if (i < batches.length - 1) {
      await sleep(200);
    }
  }

  if (failed.length > 0) {
    log(`Warning: Failed to generate embeddings for ${failed.length} articles`, 'warn');
  }

  if (results.length === 0) {
    throw new Error('Failed to generate any embeddings');
  }

  log(`Generated ${results.length} embeddings (${failed.length} failed)`, 'success');
  return results;
}

/**
 * Calculate embedding statistics for debugging
 */
export function embeddingStats(embeddings) {
  const dimensions = embeddings[0]?.embedding?.length || 0;
  const magnitudes = embeddings.map(e => {
    const mag = Math.sqrt(e.embedding.reduce((sum, v) => sum + v * v, 0));
    return mag;
  });

  return {
    count: embeddings.length,
    dimensions,
    avgMagnitude: magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length,
    minMagnitude: Math.min(...magnitudes),
    maxMagnitude: Math.max(...magnitudes)
  };
}

export { EMBEDDING_MODEL };
