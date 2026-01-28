/**
 * Newsletter Digest System - Main Orchestration
 *
 * Ingests newsletter emails, clusters by topic, curates with Gemini,
 * writes final digest with Claude, and publishes to Notion.
 */

import dotenv from 'dotenv';
import { writeFile, mkdir } from 'fs/promises';

import { fetchEmails, filterNewsletters } from './gmail/fetch.js';
import { processEmails } from './processing/extract.js';
import { generateEmbeddings } from './processing/embed.js';
import {
  clusterArticles,
  mergeMiscellaneousClusters,
  generateClusterLabel
} from './processing/cluster.js';
import { curateMainCluster, curateMiscCluster, selectBestOfWeek } from './ai/gemini.js';
import { writeDigest, estimateWordCount } from './ai/claude.js';
import { publishToNotion, verifyDatabase } from './notion/publish.js';
import { log, formatDateRange } from './utils/helpers.js';

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
const CLUSTER_COUNT = parseInt(process.env.CLUSTER_COUNT || '8', 10);
const DAYS_TO_FETCH = parseInt(process.env.DAYS_TO_FETCH || '7', 10);

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
  // recursive: true makes this operation idempotent and safe for concurrent calls
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
    tokensUsed: { gemini: 0, claude: { input: 0, output: 0 } }
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

    // Step 6: Cluster articles
    log('Step 6: Clustering articles by topic...', 'progress');
    const { clusters } = clusterArticles(embeddedArticles, CLUSTER_COUNT);
    stats.clustersFormed = clusters.length;

    // Generate labels for clusters
    for (const cluster of clusters) {
      cluster.label = generateClusterLabel(cluster);
    }

    const mergedClusters = mergeMiscellaneousClusters(clusters);
    await saveCache('clusters', mergedClusters.map(c => ({
      id: c.id,
      label: c.label,
      type: c.type,
      articleCount: c.articles.length,
      articleIds: c.articles.map(a => a.id)
    })));

    // Step 7: Select best of week
    log('Step 7: Selecting best articles of the week...', 'progress');
    const bestOf = await selectBestOfWeek(articles);
    await saveCache('best-of', {
      selected: bestOf.selected.map(a => a.id),
      reasoning: bestOf.reasoning
    });

    // Step 8: Curate each cluster with Gemini
    log('Step 8: Curating clusters with Gemini...', 'progress');
    const mainClusters = mergedClusters.filter(c => c.type === 'main');
    const miscCluster = mergedClusters.find(c => c.type === 'miscellaneous');

    const curatedMain = [];
    for (const cluster of mainClusters) {
      try {
        log(`Curating cluster: ${cluster.label}`, 'progress');
        const curated = await curateMainCluster(cluster, cluster.label);
        curatedMain.push(curated);
      } catch (error) {
        throw new Error(`Failed to curate cluster "${cluster.label}": ${error.message}`);
      }
    }

    const curatedMisc = miscCluster
      ? await curateMiscCluster(miscCluster)
      : { label: 'Long Tail', articles: [], curatedContent: null };

    await saveCache('curated', {
      main: curatedMain,
      misc: curatedMisc
    });

    // Step 9: Write final digest with Claude
    log('Step 9: Writing final digest with Claude...', 'progress');
    const digestResult = await writeDigest(bestOf, curatedMain, curatedMisc, {
      dateRange,
      totalArticles: articles.length
    });

    stats.tokensUsed.claude = digestResult.usage;

    const wordCount = estimateWordCount(digestResult.digest);
    log(`Digest complete: ${wordCount} words`, 'success');

    await saveCache('digest', {
      content: digestResult.digest,
      metadata: digestResult.metadata
    });

    // Step 10: Publish to Notion
    log('Step 10: Publishing to Notion...', 'progress');
    const notionResult = await publishToNotion(digestResult.digest, {
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

    // Save error state for debugging (sanitized to avoid sensitive data exposure)
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
