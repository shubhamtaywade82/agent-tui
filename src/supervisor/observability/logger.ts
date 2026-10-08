/**
 * Pino logger — §15.1 (Observability).
 *
 * Structured JSON logs (or pretty-printed in dev) emitted to stdout. The
 * logger is the single sink for all supervisor diagnostics; OpenTelemetry
 * spans carry the trace context (§15.1).
 */
import pino from 'pino';
import { supervisorConfig } from '../config.js';

export const logger = pino({
  name: 'minicpm5-supervisor',
  level: supervisorConfig.log.level,
  transport:
    supervisorConfig.log.format === 'pretty'
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', singleLine: false },
        }
      : undefined,
  base: { service: supervisorConfig.observability.otelServiceName },
  redact: {
    paths: [
      '*.token',
      '*.apiKey',
      '*.secret',
      '*.password',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'ZAI_API_KEY',
      'MINIO_SECRET_KEY',
    ],
    censor: '[REDACTED]',
  },
});
