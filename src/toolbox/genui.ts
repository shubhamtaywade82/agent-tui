import { z } from 'zod';
import { defineTool } from '@nemesis-oss/ollama-sdk';
import { createDefaultRegistry, createLanguageAdapter } from '@nemesis-oss/termina-genui';
import type { CommandContext } from '../tools.js';

const registry = createDefaultRegistry();
const adapter = createLanguageAdapter(registry);

export const GENUI_TEMPLATES: Record<string, string> = {
  dashboard: [
    'root = Container("column", 1, "round", [header, status, bar])',
    'header = Text("System Monitor", "cyan", true, false)',
    'status = StatusMessage("All agentic services healthy", "success")',
    'bar = ProgressBar(94, "Resource Capacity")',
  ].join('\n'),

  form: [
    'root = Container("column", 1, "round", [title, info, env, region])',
    'title = Text("Target Environment Configuration", "yellow", true, false)',
    'info = Alert("Select Target", "Choose deployment cluster", "info")',
    'env = Select("environment", "Deployment Env", ["production", "staging", "dev"])',
    'region = Select("region", "Cloud Region", ["us-east-1", "eu-central-1", "ap-south-1"])',
  ].join('\n'),

  monitor: [
    'root = Container("column", 1, "round", [header, memAlert, load])',
    'header = Text("Hardware Health", "green", true, false)',
    'memAlert = Alert("Memory Alert", "Host memory usage reached 82%", "warning")',
    'load = LoadingBar("Synchronizing vector index...")',
  ].join('\n'),
};

export const renderUiTool = defineTool({
  name: 'render_ui',
  description: 'Validate and render declarative terminal UI components (Container, Text, Badge, Alert, StatusMessage, ProgressBar, LoadingBar, Table, CodeBlock) using openui-lang DSL in chat.',
  schema: z.object({
    code: z.string().describe('openui-lang code (e.g. root = Container("column", 1, "round", [header])\\nheader = Text("Title", "cyan", true, false))'),
  }),
  execute: async ({ code }: { code: string }) => {
    const parsed = adapter.parse(code);
    if (parsed.errors && parsed.errors.length > 0) {
      return `GenUI Syntax Error: ${parsed.errors.map((e) => e.message).join('; ')}\nUse syntax: identifier = Component(args...); root = Container(...)`;
    }
    return `\`\`\`openui-lang\n${code.trim()}\n\`\`\``;
  },
});

export function handleGenUiCommand(arg: string, ctx: CommandContext): boolean {
  const key = arg.trim().toLowerCase() || 'dashboard';
  const template = GENUI_TEMPLATES[key];
  if (!template) {
    const valid = Object.keys(GENUI_TEMPLATES).join(', ');
    ctx.showToast?.(`Unknown template "${arg}". Available: ${valid}`, 'warning', 3000);
    return true;
  }
  ctx.addSystemCard?.(`\`\`\`openui-lang\n${template}\n\`\`\``);
  ctx.showToast?.(`Loaded GenUI template: ${key}`, 'info', 2000);
  return true;
}
