/**
 * Newsletter Digest System - Main Orchestration
 *
 * New Architecture:
 * 1. Fetch & extract emails
 * 2. Embed & cluster into 12 groups
 * 3. Gemini selects top 4 articles for deep analysis
 * 4. Gemini writes summaries for each cluster (isolated calls, no contamination)
 * 5. Claude writes deep analysis of only the top 4 articles
 * 6. Combine and publish to Notion
 */

import dotenv from 'dotenv';
import { writeFile, mkdir } from 'fs/promises';

import { fetchEmails, filterNewsletters } from './gmail/fetch.js';
import { processEmails } from './processing/extract.js';
import { generateEmbeddings } from './processing/embed.js';
import {
  clusterArticles,
  generateClusterLabel
} from './processing/cluster.js';
import { writeClusterSummary, selectTopArticles } from './ai/gemini.js';
import { writeDeepAnalysis, assembleDigest, estimateWordCount } from './ai/claude.js';
import { publishToNotion, verifyDatabase } from './notion/publish.js';
import { log, formatDateRange, sleep } from './utils/helpers.js';

dotenv.config();

// Validate required environment variables at startup
const REQUIRED_ENV_VARS = [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'NOTION_API_KEY',
  'NOTION_DATABASE_ID'
];

for (const envVar of REQUIRED_ENV_VARS) {
  if (!process.env[envVar]) {
    throw new Error(`Required environment variable ${envVar} is missing`);
  }
}

const CACHE_DIR = new URL('../cache/', import.meta.url).pathname;
const CLUSTER_COUNT = parseInt(process.env.CLUSTER_COUNT || '12', 10);
const DAYS_TO_FETCH = parseInt(process.env.DAYS_TO_FETCH || '7', 10);
const TOP_ARTICLES_COUNT = parseInt(process.env.TOP_ARTICLES_COUNT || '4', 10);

// Validate configuration values
if (isNaN(CLUSTER_COUNT) || CLUSTER_COUNT < 1 || CLUSTER_COUNT > 50) {
  throw new Error(`Invalid CLUSTER_COUNT: must be between 1-50`);
}
if (isNaN(DAYS_TO_FETCH) || DAYS_TO_FETCH < 1 || DAYS_TO_FETCH > 90) {
  throw new Error(`Invalid DAYS_TO_FETCH: must be between 1-90`);
}

/**
 * Save intermediate results for recovery
 */
async function saveCache(name, data) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(
    `${CACHE_DIR}${name}.json`,
    JSON.stringify(data, null, 2)
  );
}

/**
 * Main pipeline
 */
async function run() {
  const startTime = Date.now();
  const stats = {
    emailsFetched: 0,
    newslettersFound: 0,
    articlesExtracted: 0,
    clustersFormed: 0,
    topArticlesSelected: 0,
    tokensUsed: { claude: { input: 0, output: 0 } }
  };

  try {
    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - DAYS_TO_FETCH);
    const dateRange = formatDateRange(startDate, endDate);

    log(`Starting newsletter digest for ${dateRange}`, 'info');

    // Step 1: Verify Notion connection
    log('Step 1: Verifying Notion database connection...', 'progress');
    const notionStatus = await verifyDatabase();
    if (!notionStatus.connected) {
      throw new Error(`Notion connection failed: ${notionStatus.error}`);
    }

    // Step 2: Fetch emails
    log('Step 2: Fetching emails from Gmail...', 'progress');
    const emails = await fetchEmails(DAYS_TO_FETCH);
    stats.emailsFetched = emails.length;

    if (emails.length === 0) {
      log('No emails found in the specified date range', 'warn');
      return;
    }

    // Step 3: Filter newsletters
    log('Step 3: Filtering for newsletters...', 'progress');
    const newsletters = filterNewsletters(emails);
    stats.newslettersFound = newsletters.length;

    if (newsletters.length === 0) {
      log('No newsletters found in emails', 'warn');
      return;
    }

    log(`Found ${newsletters.length} newsletters out of ${emails.length} emails`, 'success');

    // Step 4: Extract content
    log('Step 4: Extracting newsletter content...', 'progress');
    const articles = processEmails(newsletters);
    stats.articlesExtracted = articles.length;
    await saveCache('articles', articles);

    if (articles.length === 0) {
      log('No articles could be extracted', 'warn');
      return;
    }

    // Step 5: Generate embeddings
    log('Step 5: Generating embeddings...', 'progress');
    const embeddedArticles = await generateEmbeddings(articles);
    await saveCache('embeddings', embeddedArticles.map(e => ({
      articleId: e.article.id,
      embedding: e.embedding
    })));

    // Step 6: Cluster articles into 12 groups
    log('Step 6: Clustering articles by topic...', 'progress');
    const { clusters } = clusterArticles(embeddedArticles, CLUSTER_COUNT);
    stats.clustersFormed = clusters.length;

    // Generate labels for clusters
    for (const cluster of clusters) {
      cluster.label = generateClusterLabel(cluster);
    }

    await saveCache('clusters', clusters.map(c => ({
      id: c.id,
      label: c.label,
      articleCount: c.articles.length,
      articleIds: c.articles.map(a => a.id)
    })));

    log(`Created ${clusters.length} topic clusters`, 'success');

    // Step 7: Gemini selects top articles for deep analysis
    log('Step 7: Selecting top articles for deep analysis...', 'progress');
    const topSelection = await selectTopArticles(articles, TOP_ARTICLES_COUNT);
    stats.topArticlesSelected = topSelection.selected.length;

    await saveCache('top-articles', {
      selected: topSelection.selected.map(a => ({ id: a.id, subject: a.subject, source: a.source })),
      reasoning: topSelection.reasoning
    });

    log(`Selected ${topSelection.selected.length} articles for deep analysis`, 'success');

    // Step 8: Gemini writes cluster summaries (isolated calls - no contamination)
    log('Step 8: Writing cluster summaries with Gemini...', 'progress');

    // Remove top articles from clusters to avoid repetition
    const topArticleIds = new Set(topSelection.selected.map(a => a.id));

    const clusterSummaries = [];
    for (const cluster of clusters) {
      // Filter out top articles from this cluster
      const clusterArticles = cluster.articles.filter(a => !topArticleIds.has(a.id));

      if (clusterArticles.length === 0) {
        log(`Skipping empty cluster: ${cluster.label}`, 'warn');
        continue;
      }

      try {
        const summary = await writeClusterSummary(
          { ...cluster, articles: clusterArticles },
          cluster.label
        );
        clusterSummaries.push(summary);
      } catch (error) {
        log(`Failed to write summary for cluster "${cluster.label}": ${error.message}`, 'error');
        // Continue with other clusters
      }
    }

    await saveCache('cluster-summaries', clusterSummaries);

    log(`Wrote ${clusterSummaries.length} cluster summaries`, 'success');

    // Step 9: Claude writes deep analysis of top articles
    log('Step 9: Waiting 60s for rate limit reset before Claude...', 'progress');
    await sleep(60000);

    log('Writing deep analysis with Claude...', 'progress');
    const deepAnalysisResult = await writeDeepAnalysis(topSelection.selected, {
      dateRange,
      totalArticles: articles.length
    });

    stats.tokensUsed.claude = deepAnalysisResult.usage;

    await saveCache('deep-analysis', {
      content: deepAnalysisResult.analysis
    });

    // Step 10: Assemble final digest
    log('Step 10: Assembling final digest...', 'progress');
    const finalDigest = assembleDigest(
      deepAnalysisResult.analysis,
      clusterSummaries,
      {
        dateRange,
        totalArticles: articles.length
      }
    );

    const wordCount = estimateWordCount(finalDigest);
    log(`Digest assembled: ${wordCount} words`, 'success');

    await saveCache('digest', {
      content: finalDigest,
      wordCount
    });

    // Step 11: Publish to Notion
    log('Step 11: Publishing to Notion...', 'progress');
    const notionResult = await publishToNotion(finalDigest, {
      dateRange,
      date: endDate
    });

    // Summary
    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
    log('='.repeat(50), 'info');
    log('DIGEST COMPLETE', 'success');
    log('='.repeat(50), 'info');
    log(`Date Range: ${dateRange}`, 'info');
    log(`Emails Fetched: ${stats.emailsFetched}`, 'info');
    log(`Newsletters Found: ${stats.newslettersFound}`, 'info');
    log(`Articles Extracted: ${stats.articlesExtracted}`, 'info');
    log(`Clusters Formed: ${stats.clustersFormed}`, 'info');
    log(`Top Articles Analyzed: ${stats.topArticlesSelected}`, 'info');
    log(`Final Word Count: ${wordCount}`, 'info');
    log(`Claude Tokens: ${stats.tokensUsed.claude.input} in / ${stats.tokensUsed.claude.output} out`, 'info');
    log(`Notion Page: ${notionResult.url}`, 'info');
    log(`Elapsed Time: ${elapsedTime}s`, 'info');

    return {
      success: true,
      stats,
      notionUrl: notionResult.url,
      wordCount
    };

  } catch (error) {
    log(`Pipeline failed: ${error.message}`, 'error');
    console.error(error.stack);

    // Save error state for debugging
    await saveCache('error', {
      message: error.message,
      name: error.name,
      stats: {
        emailsFetched: stats.emailsFetched,
        newslettersFound: stats.newslettersFound,
        articlesExtracted: stats.articlesExtracted,
        clustersFormed: stats.clustersFormed
      },
      timestamp: new Date().toISOString()
    });

    throw error;
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then(result => {
      if (result?.success) {
        process.exit(0);
      }
    })
    .catch(error => {
      process.exit(1);
    });
}

export { run };
