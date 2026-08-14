import { describe, it, expect } from 'vitest';
import { COLLECTION_DOCUMENT_CHUNKS, VECTOR_DIMENSION } from './client';

describe('qdrant vector store constants', () => {
  it('defines collection name and dimension correctly', () => {
    expect(COLLECTION_DOCUMENT_CHUNKS).toBe('document_chunks');
    expect(VECTOR_DIMENSION).toBe(1536);
  });
});
