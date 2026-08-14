import { getQdrantClient, COLLECTION_DOCUMENT_CHUNKS, VECTOR_DIMENSION } from './client';

export async function setupQdrantCollections(): Promise<void> {
  const client = getQdrantClient();

  const collections = await client.getCollections();
  const exists = collections.collections.some((c) => c.name === COLLECTION_DOCUMENT_CHUNKS);

  if (!exists) {
    await client.createCollection(COLLECTION_DOCUMENT_CHUNKS, {
      vectors: {
        size: VECTOR_DIMENSION,
        distance: 'Cosine',
      },
    });

    // Create payload indexes for mandatory permission filtering
    await client.createPayloadIndex(COLLECTION_DOCUMENT_CHUNKS, {
      field_name: 'workspace_id',
      field_schema: 'keyword',
    });

    await client.createPayloadIndex(COLLECTION_DOCUMENT_CHUNKS, {
      field_name: 'permitted_user_ids',
      field_schema: 'keyword',
    });
  }
}
