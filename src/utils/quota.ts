import {
  QuotaManager,
  createOllamaCloudFreeTierQuota,
  OllamaQuotaExceededError
} from '@nemesis-oss/ollama-sdk';

export const createQuotaManager = () => {
  const quota = createOllamaCloudFreeTierQuota({
    session: { maxTokens: 50000 },
    weekly: { maxTokens: 200000 }
  });

  return quota;
};

export const chatWithQuota = async (
  client: any,
  quota: QuotaManager,
  prompt: string
) => {
  try {
    quota.assertCanProceed();

    const response = await client.chatText({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: prompt }]
    });

    quota.recordUsage(response);
    return response;
  } catch (error) {
    if (error instanceof OllamaQuotaExceededError) {
      console.warn('Quota exceeded. Please wait for reset.');
    }
    throw error;
  }
};