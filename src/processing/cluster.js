/**
 * K-means clustering module
 */

import { kmeans } from 'ml-kmeans';
import { cosineSimilarity, log } from '../utils/helpers.js';

const DEFAULT_CLUSTER_COUNT = 8;
const MAIN_CLUSTER_THRESHOLD = 5; // Clusters 0-4 are "main", 5-7 are "miscellaneous"

/**
 * Normalize vectors for cosine similarity clustering
 */
function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map(v => v / magnitude);
}

/**
 * Perform K-means clustering on embedded articles
 */
export function clusterArticles(embeddedArticles, k = DEFAULT_CLUSTER_COUNT) {
  log(`Clustering ${embeddedArticles.length} articles into ${k} groups...`, 'progress');

  // Handle edge cases
  if (embeddedArticles.length === 0) {
    return { clusters: [], assignments: [] };
  }

  if (embeddedArticles.length <= k) {
    // Fewer articles than clusters - each article is its own cluster
    const clusters = embeddedArticles.map((item, i) => ({
      id: i,
      articles: [item.article],
      centroid: item.embedding,
      type: i < MAIN_CLUSTER_THRESHOLD ? 'main' : 'miscellaneous'
    }));
    return { clusters, assignments: embeddedArticles.map((_, i) => i) };
  }

  // Normalize embeddings for cosine similarity
  const normalizedData = embeddedArticles.map(item =>
    normalizeVector(item.embedding)
  );

  // Run K-means
  const result = kmeans(normalizedData, k, {
    initialization: 'kmeans++',
    maxIterations: 100
  });

  // Group articles by cluster
  const clusterGroups = new Map();
  for (let i = 0; i < result.clusters.length; i++) {
    const clusterId = result.clusters[i];
    if (!clusterGroups.has(clusterId)) {
      clusterGroups.set(clusterId, []);
    }
    clusterGroups.get(clusterId).push(embeddedArticles[i].article);
  }

  // Sort clusters by size (descending)
  const sortedClusters = Array.from(clusterGroups.entries())
    .map(([id, articles]) => ({
      originalId: id,
      articles,
      size: articles.length,
      centroid: result.centroids[id]
    }))
    .sort((a, b) => b.size - a.size);

  // Assign types: first 5 are main, rest are miscellaneous
  const clusters = sortedClusters.map((cluster, index) => ({
    id: index,
    originalId: cluster.originalId,
    articles: cluster.articles,
    centroid: cluster.centroid,
    type: index < MAIN_CLUSTER_THRESHOLD ? 'main' : 'miscellaneous',
    size: cluster.size
  }));

  // Log cluster distribution
  const mainCount = clusters.filter(c => c.type === 'main').reduce((sum, c) => sum + c.size, 0);
  const miscCount = clusters.filter(c => c.type === 'miscellaneous').reduce((sum, c) => sum + c.size, 0);
  log(`Clustered into ${k} groups: ${mainCount} in main topics, ${miscCount} in miscellaneous`, 'success');

  return {
    clusters,
    assignments: result.clusters
  };
}

/**
 * Merge small miscellaneous clusters into one
 */
export function mergeMiscellaneousClusters(clusters) {
  const mainClusters = clusters.filter(c => c.type === 'main');
  const miscClusters = clusters.filter(c => c.type === 'miscellaneous');

  if (miscClusters.length === 0) {
    return mainClusters;
  }

  // Merge all misc articles into one cluster
  const miscArticles = miscClusters.flatMap(c => c.articles);

  const mergedMisc = {
    id: mainClusters.length,
    articles: miscArticles,
    type: 'miscellaneous',
    size: miscArticles.length,
    label: 'Long Tail / Miscellaneous'
  };

  return [...mainClusters, mergedMisc];
}

/**
 * Find representative articles for a cluster (closest to centroid)
 */
export function findRepresentativeArticles(cluster, embeddedArticles, count = 3) {
  if (!cluster.centroid || cluster.articles.length <= count) {
    return cluster.articles;
  }

  const articleIds = new Set(cluster.articles.map(a => a.id));
  const clusterEmbeddings = embeddedArticles.filter(e =>
    articleIds.has(e.article.id)
  );

  // Calculate similarity to centroid
  const withSimilarity = clusterEmbeddings.map(item => ({
    article: item.article,
    similarity: cosineSimilarity(item.embedding, cluster.centroid)
  }));

  // Sort by similarity (descending) and take top N
  return withSimilarity
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, count)
    .map(item => item.article);
}

/**
 * Generate a topic label for a cluster based on common words
 */
export function generateClusterLabel(cluster) {
  // Combine all subjects and content
  const allText = cluster.articles
    .map(a => `${a.subject} ${a.content}`)
    .join(' ')
    .toLowerCase();

  // Common words to ignore
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'this',
    'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
    'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all', 'each',
    'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
    'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
    'just', 'also', 'now', 'here', 'there', 'then', 'once', 'your', 'our',
    'their', 'its', 'about', 'into', 'through', 'during', 'before', 'after',
    'above', 'below', 'between', 'under', 'again', 'further', 'while'
  ]);

  // Extract words and count frequency
  const words = allText.match(/\b[a-z]{4,}\b/g) || [];
  const wordCounts = new Map();

  for (const word of words) {
    if (!stopWords.has(word)) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }
  }

  // Get top 3 words
  const topWords = Array.from(wordCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word]) => word.charAt(0).toUpperCase() + word.slice(1));

  return topWords.join(' / ') || `Topic ${cluster.id + 1}`;
}

export { DEFAULT_CLUSTER_COUNT, MAIN_CLUSTER_THRESHOLD };
