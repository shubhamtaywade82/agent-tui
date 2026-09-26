import { useState, useEffect } from 'react';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

interface HealthStatus {
  connected: boolean;
  memoryUsage: number;
  tokenCount: number;
  models: string[];
}

export const useOllama = () => {
  const [client, setClient] = useState<OllamaClient | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [healthCheck, setHealthCheck] = useState<HealthStatus>({
    connected: false,
    memoryUsage: 0,
    tokenCount: 0,
    models: []
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const initializeClient = async () => {
      try {
        // Multi-endpoint configuration without restrictive hardcoded model lists
        const ollamaClient = new OllamaClient({
          endpoints: [
            {
              name: 'local-gpu',
              baseUrl: process.env.OLLAMA_HOST || 'http://localhost:11434',
              priority: 10,
            },
            ...(process.env.OLLAMA_API_KEY
              ? [
                  {
                    name: 'cloud-replica',
                    baseUrl: process.env.OLLAMA_CLOUD_URL || 'https://ollama.internal.net',
                    apiKey: process.env.OLLAMA_API_KEY,
                    priority: 5,
                  },
                ]
              : []),
          ],
          timeoutMs: 120000,
          retries: 3,
          endpointHealth: {
            strategy: 'least-connections',
            maxConcurrentPerEndpoint: 4
          }
        });

        // Get available models
        const availableModels = await ollamaClient.listModels();
        setModels(availableModels.map(model => model.name));

        // Perform health check
        const health = await ollamaClient.healthCheck();
        const isConnected = health.some(h => h.reachable);
        let memoryUsage = 0;
        try {
          const ps = await ollamaClient.ps();
          const totalMemory = ps.models.reduce((acc, model) => acc + (model.size_vram ?? 0), 0);
          memoryUsage = totalMemory / 1024 / 1024;
        } catch {
          // Keep 0 if ps is not reachable
        }

        setHealthCheck({
          connected: isConnected,
          memoryUsage,
          tokenCount: 0,
          models: availableModels.map(model => model.name)
        });

        setClient(ollamaClient);
      } catch (error) {
        console.error('Failed to initialize Ollama client:', error);
        setHealthCheck(prev => ({ ...prev, connected: false }));
      } finally {
        setIsLoading(false);
      }
    };

    initializeClient();
  }, []);

  return { client, models, healthCheck, isLoading };
};