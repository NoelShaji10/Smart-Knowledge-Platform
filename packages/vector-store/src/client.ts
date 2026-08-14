import { QdrantClient } from '@qdrant/js-client-rest';
import { getEnv } from '@knowledge/config';

let qdrantInstance: QdrantClient | null = null;

export const COLLECTION_DOCUMENT_CHUNKS = 'document_chunks';
export const VECTOR_DIMENSION = 1536; // Default for text-embedding-3-small

export function getQdrantClient(): QdrantClient {
  if (!qdrantInstance) {
    const env = getEnv();
    qdrantInstance = new QdrantClient({
      url: env.QDRANT_URL,
    });
  }
  return qdrantInstance;
}
