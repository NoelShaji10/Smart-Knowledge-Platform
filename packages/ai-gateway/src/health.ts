import { getEnv } from '@knowledge/config';

export async function checkAIGatewayHealth(): Promise<{ healthy: boolean; error?: string }> {
  try {
    const url = getEnv().LITELLM_URL;
    const res = await fetch(`${url}/health`);
    return { healthy: res.ok };
  } catch (err: any) {
    return { healthy: false, error: err?.message || 'LiteLLM ping failed' };
  }
}
