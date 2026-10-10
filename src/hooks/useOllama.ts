import { useState, useEffect } from 'react';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { loadConfig } from '../config.js';
import { buildOllamaClientOptions } from '../ollama-endpoints.js';

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
    models: [],
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const initializeClient = async () => {
      try {
        const cfg = loadConfig();
        const ollamaClient = new OllamaClient(buildOllamaClientOptions(cfg.provider.ollama, cfg.wallTimeMs));

        const availableModels = await ollamaClient.listModels();
        setModels(availableModels.map((model) => model.name));

        const health = await ollamaClient.healthCheck();
        const isConnected = health.some((h) => h.reachable);
        let memoryUsage = 0;
        try {
          const ps = await ollamaClient.ps();
          const totalMemory = ps.models.reduce((acc, model) => acc + (model.size_vram ?? 0), 0);
          memoryUsage = totalMemory / 1024 / 1024;
        } catch {
          // local ps() may be unavailable when only cloud is reachable
        }

        setHealthCheck({
          connected: isConnected,
          memoryUsage,
          tokenCount: 0,
          models: availableModels.map((model) => model.name),
        });

        setClient(ollamaClient);
      } catch (error) {
        console.error('Failed to initialize Ollama client:', error);
        setHealthCheck((prev) => ({ ...prev, connected: false }));
      } finally {
        setIsLoading(false);
      }
    };

    void initializeClient();
  }, []);

  return { client, models, healthCheck, isLoading };
};
