import React from 'react';
import { z } from 'zod';
import { z as zv4 } from 'zod/v4';
import { defineTool } from '@nemesis-oss/ollama-sdk';
import { Box, Text } from '@nemesis-oss/termina-core';
import {
  Gauge,
  Sparkline,
  DiffView,
  TokenCounter,
  Divider,
  JSONViewer,
} from '@nemesis-oss/termina-ui';
import {
  createDefaultComponents,
  createGenUIRegistry,
  createLanguageAdapter,
  defineGenUIComponent,
  type GenUIActionDispatcher,
  type GenUIComponent,
  type GenUIRenderContext,
} from '@nemesis-oss/termina-genui';
import type { CommandContext } from '../tools.js';

function createExtendedComponents(): GenUIComponent<any>[] {
  return [
    ...createDefaultComponents(),
    defineGenUIComponent({
      name: 'Gauge',
      description: 'Circular/horizontal metric gauge displaying percentage and value',
      schema: zv4.object({
        value: zv4.number(),
        label: zv4.string().optional(),
        width: zv4.number().optional(),
        showValue: zv4.boolean().optional(),
      }) as any,
      render: (props: any) => React.createElement(Gauge, {
        value: props.value ?? 0,
        label: props.label,
        width: props.width ?? 20,
        showValue: props.showValue ?? true,
      }),
    }),
    defineGenUIComponent({
      name: 'Sparkline',
      description: 'Inline sparkline micro-chart showing trend over an array of numbers',
      schema: zv4.object({
        data: zv4.array(zv4.number()),
        width: zv4.number().optional(),
      }) as any,
      render: (props: any) => React.createElement(Sparkline, {
        data: props.data ?? [],
        width: props.width,
      }),
    }),
    defineGenUIComponent({
      name: 'DiffView',
      description: 'Unified diff comparison viewer showing additions and deletions',
      schema: zv4.object({
        patch: zv4.string(),
      }) as any,
      render: (props: any) => React.createElement(DiffView, {
        patch: props.patch ?? '',
      }),
    }),
    defineGenUIComponent({
      name: 'TokenCounter',
      description: 'Visual budget and token usage counter with limit threshold color',
      schema: zv4.object({
        count: zv4.number(),
        limit: zv4.number().optional(),
        label: zv4.string().optional(),
      }) as any,
      render: (props: any) => React.createElement(TokenCounter, {
        count: props.count ?? 0,
        limit: props.limit,
        label: props.label,
      }),
    }),
    defineGenUIComponent({
      name: 'Divider',
      description: 'Horizontal divider line with optional title heading',
      schema: zv4.object({
        title: zv4.string().optional(),
      }) as any,
      render: (props: any) => React.createElement(Divider, {
        title: props.title,
      }),
    }),
    defineGenUIComponent({
      name: 'Confirm',
      description: 'Confirmation action button pair for approvals',
      schema: zv4.object({
        label: zv4.string(),
        confirmAction: zv4.string(),
        cancelAction: zv4.string().optional(),
      }) as any,
      render: (props: any, ctx: GenUIRenderContext) => React.createElement(
        Box,
        { flexDirection: 'row', gap: 2 },
        React.createElement(
          Box,
          {
            borderStyle: 'round',
            borderColor: 'green',
            paddingX: 1,
            onClick: () => void ctx.dispatchAction(props.confirmAction, ctx.runtime.getValues()),
          },
          React.createElement(Text, { color: 'green', bold: true }, `[ ✔ ${props.label || 'Confirm'} ]`),
        ),
        React.createElement(
          Box,
          {
            borderStyle: 'round',
            borderColor: 'red',
            paddingX: 1,
            onClick: () => void ctx.dispatchAction(props.cancelAction ?? 'cancel', ctx.runtime.getValues()),
          },
          React.createElement(Text, { color: 'red', bold: true }, '[ ✖ Cancel ]'),
        ),
      ),
    }),
    defineGenUIComponent({
      name: 'JsonViewer',
      description: 'Interactive hierarchical JSON inspector for complex data payloads',
      schema: zv4.object({
        data: zv4.any(),
        maxDepth: zv4.number().optional(),
      }) as any,
      render: (props: any) => React.createElement(JSONViewer, {
        data: props.data,
        maxDepth: props.maxDepth,
      }),
    }),
  ];
}

export const genUiRegistry = createGenUIRegistry(createExtendedComponents());
export const genUiAdapter = createLanguageAdapter(genUiRegistry);

// Universal dispatcher routes any DSL action name and form values to listener
export function createUniversalActionDispatcher(
  onAction?: (action: string, values: Record<string, unknown>) => void,
): GenUIActionDispatcher | undefined {
  if (!onAction) return undefined;
  return {
    has: () => true,
    register: () => {},
    dispatch: async (name: string, payload: unknown) => {
      onAction(name, (payload as Record<string, unknown>) ?? {});
    },
  };
}

export const GENUI_SYSTEM_INSTRUCTIONS = `
## Interactive Terminal Generative UI (openui-lang)
You can render interactive terminal UI widgets by generating \`\`\`openui-lang code blocks.
Available components:
- Layout: Container("row"|"column", gap, borderStyle, children), Divider(title)
- Content: Text(content, color, bold, dim), Markdown(content), CodeBlock(code, language), Table(columns, data), JsonViewer(data)
- Metrics: Gauge(value, label, width), Sparkline(data), ProgressBar(percent, label), TokenCounter(count, limit, label), LoadingBar(label)
- Status: StatusMessage(message, variant), Alert(title, message, variant), Badge(text, variant)
- Inputs: TextInput(name, label, placeholder, defaultValue), Select(name, label, options)
- Actions: Button(label, action), Confirm(label, confirmAction, cancelAction)
Syntax rules:
1. Statements on separate lines: identifier = Component(args...)
2. Entry point is "root": root = Container("column", 1, "round", [header, widget, btn])
3. Positional arguments only. Double-quoted strings.
4. When users click buttons or confirm, you receive "[UI Action] actionName: {...values}" as next turn.
Use \`\`\`openui-lang when asked for dashboards, metrics, forms, approvals, or structured UI.`;

export const GENUI_TEMPLATES: Record<string, string> = {
  dashboard: [
    'root = Container("column", 1, "round", [header, status, gauge, spark])',
    'header = Text("⚡ Agent System Monitor", "cyan", true, false)',
    'status = StatusMessage("All agentic services and MCP tools online", "success")',
    'gauge = Gauge(84, "Cluster Capacity")',
    'spark = Sparkline([12, 18, 25, 40, 32, 60, 55, 78, 84])',
  ].join('\n'),

  form: [
    'root = Container("column", 1, "round", [title, info, env, region, confirm])',
    'title = Text("Target Environment Configuration", "yellow", true, false)',
    'info = Alert("Setup Environment", "Select target deployment cluster below", "info")',
    'env = Select("environment", "Deployment Env", ["production", "staging", "dev"])',
    'region = Select("region", "Cloud Region", ["us-east-1", "eu-central-1", "ap-south-1"])',
    'confirm = Confirm("Apply Deployment", "deployApp", "cancelDeploy")',
  ].join('\n'),

  diff: [
    'root = Container("column", 1, "round", [header, diff, confirm])',
    'header = Text("Proposed Patch Review", "magenta", true, false)',
    'diff = DiffView("--- a/config.json\\n+++ b/config.json\\n@@ -1,3 +1,3 @@\\n-  \\"mode\\": \\"sandbox\\"\\n+  \\"mode\\": \\"production\\"")',
    'confirm = Confirm("Approve Diff", "approvePatch", "rejectPatch")',
  ].join('\n'),
};

export const renderUiTool = defineTool({
  name: 'render_ui',
  description: 'Validate and render declarative terminal UI components (Container, Text, Badge, Alert, StatusMessage, ProgressBar, LoadingBar, Table, CodeBlock, Gauge, Sparkline, DiffView, TokenCounter, Divider, Confirm, JsonViewer) using openui-lang DSL in chat.',
  schema: z.object({
    code: z.string().describe('openui-lang code (e.g. root = Container("column", 1, "round", [header, gauge])\\nheader = Text("Title", "cyan", true, false)\\ngauge = Gauge(85, "Load"))'),
  }),
  execute: async ({ code }: { code: string }) => {
    const parsed = genUiAdapter.parse(code);
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
