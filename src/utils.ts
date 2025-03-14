import { OpenAI } from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { KnowledgeDocument, SearchResult } from './types';

/**
 * Calculates cosine similarity between two vectors
 * @param vecA First vector
 * @param vecB Second vector
 * @returns Similarity score between 0 and 1
 */
export function calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length !== vecB.length) {
    return 0;
  }
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);
  
  if (normA === 0 || normB === 0) {
    return 0;
  }
  
  return dotProduct / (normA * normB);
}

/**
 * Converts text content to chunks of appropriate size
 * @param content Text content to chunk
 * @param maxChunkLength Maximum length of each chunk
 * @returns Array of text chunks
 */
export function chunkContent(content: string, maxChunkLength: number = 2000): string[] {
  // If content is small enough, return as a single chunk
  if (content.length <= maxChunkLength) {
    return [content];
  }
  
  // Split by paragraphs first
  const paragraphs = content.split(/\n\s*\n/);
  const chunks: string[] = [];
  let currentChunk = "";
  
  for (const paragraph of paragraphs) {
    // If adding this paragraph would exceed max length and we already have content
    if ((currentChunk + paragraph).length > maxChunkLength && currentChunk.length > 0) {
      // Store current chunk and start a new one
      chunks.push(currentChunk);
      currentChunk = paragraph;
    } else {
      // Add paragraph to current chunk
      currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
    }
  }
  
  // Add the last chunk if it has content
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

/**
 * Creates a synonym map for common terms
 * @returns Map of words to their synonyms
 */
export function getSynonymMap(): Record<string, string[]> {
  return {
    'cancel': ['cancelation', 'cancelling', 'reschedule', 'abort', 'terminate'],
    'appointment': ['meeting', 'session', 'consultation', 'booking', 'reservation'],
    'reschedule': ['change', 'move', 'adjust', 'shift', 'postpone'],
    'virtual': ['online', 'remote', 'digital', 'video', 'teleconference'],
    'policy': ['rule', 'guideline', 'regulation', 'procedure', 'protocol'],
    'fee': ['charge', 'cost', 'payment', 'price', 'expense'],
    'late': ['tardy', 'delayed', 'behind schedule', 'not on time'],
    'available': ['free', 'open', 'vacant', 'accessible', 'obtainable'],
    'unavailable': ['busy', 'occupied', 'booked', 'reserved', 'taken'],
    'doctor': ['physician', 'specialist', 'practitioner', 'clinician'],
    'location': ['place', 'venue', 'site', 'facility', 'address'],
    'time': ['schedule', 'slot', 'hour', 'period', 'duration']
  };
}

/**
 * Extract the most relevant excerpt from document content based on a query
 * @param content Document content
 * @param query Search query
 * @param maxLength Maximum length of excerpt
 * @returns Relevant excerpt
 */
export function extractRelevantExcerpt(content: string, query: string, maxLength: number = 300): string {
  // Split into sentences
  const sentences = content.match(/[^.!?]+[.!?]+/g) || [];
  
  if (sentences.length === 0) {
    return content.substring(0, maxLength) + (content.length > maxLength ? '...' : '');
  }
  
  // Calculate relevance score for each sentence
  const queryWords = query.toLowerCase().split(/\s+/);
  const synonymMap = getSynonymMap();
  
  // Expand query with synonyms
  const expandedQueryWords = new Set<string>();
  queryWords.forEach(word => {
    expandedQueryWords.add(word);
    
    // Add synonyms
    for (const [term, synonyms] of Object.entries(synonymMap)) {
      if (word === term || synonyms.includes(word)) {
        expandedQueryWords.add(term);
        synonyms.forEach(syn => expandedQueryWords.add(syn));
      }
    }
  });
  
  // Score each sentence
  const sentenceScores = sentences.map(sentence => {
    const sentenceLower = sentence.toLowerCase();
    let score = 0;
    
    expandedQueryWords.forEach(word => {
      if (sentenceLower.includes(word)) {
        score += 1;
      }
    });
    
    return score;
  });
  
  // Find the most relevant sentence
  const bestSentenceIndex = sentenceScores.indexOf(Math.max(...sentenceScores));
  
  // Get context (sentences before and after)
  const contextSize = 2; // Number of sentences to include before and after
  const startIdx = Math.max(0, bestSentenceIndex - contextSize);
  const endIdx = Math.min(sentences.length, bestSentenceIndex + contextSize + 1);
  
  // Join sentences to form excerpt
  let excerpt = sentences.slice(startIdx, endIdx).join(' ');
  
  // Trim if too long
  if (excerpt.length > maxLength) {
    excerpt = excerpt.substring(0, maxLength - 3) + '...';
  }
  
  return excerpt;
}

/**
 * Generate embeddings for documents using OpenAI API
 * @param openai OpenAI client
 * @param documents Array of documents to generate embeddings for
 * @returns Updated documents with embeddings
 */
export async function generateEmbeddingsForDocuments(
  openai: OpenAI, 
  documents: KnowledgeDocument[],
  batchSize: number = 20
): Promise<KnowledgeDocument[]> {
  // Filter for documents without embeddings
  const docsNeedingEmbeddings = documents.filter(doc => !doc.metadata?.embedding);
  
  if (docsNeedingEmbeddings.length === 0) {
    return documents;
  }
  
  console.log(`Generating embeddings for ${docsNeedingEmbeddings.length} documents`);
  
  // Process in batches
  for (let i = 0; i < docsNeedingEmbeddings.length; i += batchSize) {
    const batch = docsNeedingEmbeddings.slice(i, i + batchSize);
    
    // Process each document in batch
    await Promise.all(
      batch.map(async (doc) => {
        try {
          const input = doc.title + "\n\n" + doc.content.substring(0, 8000);
          const embeddingResponse = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input
          });
          
          // Store embedding in document metadata
          if (!doc.metadata) doc.metadata = {};
          doc.metadata.embedding = embeddingResponse.data[0].embedding;
          
          // Update the original document in the main array
          const docIndex = documents.findIndex(d => d.id === doc.id);
          if (docIndex >= 0) {
            documents[docIndex].metadata = doc.metadata;
          }
        } catch (error) {
          console.error(`Failed to generate embedding for ${doc.id}:`, error);
        }
      })
    );
    
    // Avoid rate limits
    if (i + batchSize < docsNeedingEmbeddings.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  
  return documents;
}

/**
 * Save documents and embeddings to disk
 * @param knowledgeBasePath Path to knowledge base directory
 * @param documents Knowledge base documents
 * @param vectorStore Vector store data
 */
export async function persistKnowledgeBase(
  knowledgeBasePath: string,
  documents: KnowledgeDocument[],
  vectorStore: {documentId: string, embedding: number[]}[]
): Promise<void> {
  try {
    const vectorStorePath = path.join(knowledgeBasePath, 'vector-store.json');
    
    const persistData = {
      knowledgeBase: documents,
      vectorStore,
      timestamp: new Date().toISOString()
    };
    
    await fs.writeFile(
      vectorStorePath,
      JSON.stringify(persistData),
      'utf8'
    );
    
    console.log(`Persisted knowledge base with ${documents.length} documents and ${vectorStore.length} embeddings`);
  } catch (error) {
    console.error('Error persisting knowledge base:', error);
  }
}

/**
 * Basic keyword search as fallback when semantic search is unavailable
 * @param query Search query
 * @param documents Documents to search through
 * @param maxResults Maximum number of results to return
 * @returns Search results
 */
export function basicKeywordSearch(
  query: string, 
  documents: KnowledgeDocument[], 
  maxResults: number = 3
): SearchResult[] {
  // Convert query to lowercase for case-insensitive matching
  const lowerQuery = query.toLowerCase();
  
  // Split query into keywords
  const keywords = lowerQuery.split(/\s+/).filter(k => k.length > 2);
  
  // Get synonym map
  const synonymMap = getSynonymMap();
  
  // Expand keywords with synonyms
  const expandedKeywords = new Set<string>();
  keywords.forEach(keyword => {
    expandedKeywords.add(keyword);
    
    // Add synonyms
    for (const [word, synonyms] of Object.entries(synonymMap)) {
      if (keyword === word || synonyms.includes(keyword)) {
        expandedKeywords.add(word);
        synonyms.forEach(syn => expandedKeywords.add(syn));
      }
    }
  });
  
  // Score each document
  const results = documents.map(doc => {
    const lowerContent = doc.content.toLowerCase();
    const lowerTitle = doc.title.toLowerCase();
    
    // Calculate relevance score with expanded keywords
    let score = 0;
    
    // Title matches are weighted more heavily
    expandedKeywords.forEach(keyword => {
      // Title matches
      if (lowerTitle.includes(keyword)) {
        score += 10;
      }
      
      // Content matches
      const contentMatches = (lowerContent.match(new RegExp(keyword, 'g')) || []).length;
      score += contentMatches;
    });
    
    // Extract a relevant excerpt
    const excerpt = extractRelevantExcerpt(doc.content, query);
    
    return {
      documentId: doc.id,
      title: doc.title,
      excerpt,
      relevanceScore: score
    };
  });
  
  // Sort by relevance score and take top results
  return results
    .filter(result => result.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, maxResults);
}