import {
  OllamaClient,
  createConsoleLogger,
  type RequestLifecycleHook,
} from '@nemesis-oss/ollama-sdk';

// Create client with observability
export const createObservableClient = (onLifecycleEvent?: RequestLifecycleHook) => {
  const client = new OllamaClient({
    debug: true,
    logger: createConsoleLogger('[Ollama]'),
    onLifecycleEvent,
  });

  return client;
};