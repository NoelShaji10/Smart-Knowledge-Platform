import { AIGatewayClient } from './client';

let gatewayInstance: AIGatewayClient | null = null;

export function getAIGateway(): AIGatewayClient {
  if (!gatewayInstance) {
    gatewayInstance = new AIGatewayClient();
  }
  return gatewayInstance;
}
