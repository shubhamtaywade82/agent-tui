import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

// Initialize OpenTelemetry
const sdk = new NodeSDK({
  instrumentations: [getNodeAutoInstrumentations()]
});
sdk.start();

// Create client with observability
export const createObservableClient = () => {
  const client = new OllamaClient({
    // ... other config
    enableOpenTelemetry: true
  });

  return client;
};