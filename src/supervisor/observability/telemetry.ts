/**
 * OpenTelemetry — §15.1 (Trace Every Step).
 *
 * Wraps every supervisor step in an OTel span. When `OTEL_ENABLED=true`
 * and `OTEL_EXPORTER_OTLP_ENDPOINT` is set, spans are exported to the
 * configured collector. Otherwise the SDK is a no-op, which keeps tests
 * and local dev fast.
 */
import { DiagConsoleLogger, DiagLogLevel, diag, metrics, trace } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { supervisorConfig } from '../config.js';
import { logger } from './logger.js';

let sdk: NodeSDK | undefined;

if (supervisorConfig.observability.otelEnabled) {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  // The OTLP trace exporter is configured via env vars
  // (OTEL_EXPORTER_OTLP_ENDPOINT) when auto-instrumentations loads.
  sdk = new NodeSDK({
    serviceName: supervisorConfig.observability.otelServiceName,
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  logger.info('OpenTelemetry SDK started');
}

export const tracer = trace.getTracer('minicpm5-supervisor');
export const meter = metrics.getMeter('minicpm5-supervisor');

/** Convenience: run `fn` inside a span and return its result. */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attrs?: Record<string, string | number | boolean>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
    }
    try {
      const r = await fn();
      span.setStatus({ code: 1 /* OK */ });
      return r;
    } catch (e) {
      const err = e as Error;
      span.recordException(err);
      span.setStatus({ code: 2 /* ERROR */, message: err.message });
      throw e;
    } finally {
      span.end();
    }
  });
}

export const Telemetry = {
  async shutdown(): Promise<void> {
    if (sdk) await sdk.shutdown();
  },
};
