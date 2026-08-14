import { getEnv } from '@knowledge/config';

export interface EmbeddingResponse {
  embedding: number[];
  model: string;
}

export interface CompletionResponse {
  text: string;
  model: string;
}

export class AIGatewayClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || getEnv().LITELLM_URL;
  }

  async createEmbedding(text: string, modelAlias = 'embedding-model'): Promise<EmbeddingResponse> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelAlias,
        input: text,
      }),
    });

    if (!res.ok) {
      throw new Error(`Embedding request failed with status ${res.status}`);
    }

    const data = (await res.json()) as any;
    return {
      embedding: data.data[0].embedding,
      model: data.model || modelAlias,
    };
  }

  async generateText(prompt: string, modelAlias = 'generation-model'): Promise<CompletionResponse> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelAlias,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Completion request failed with status ${res.status}`);
    }

    const data = (await res.json()) as any;
    return {
      text: data.choices[0].message.content,
      model: data.model || modelAlias,
    };
  }
}
