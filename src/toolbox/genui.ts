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
import { Link } from '../components/ui/link/index.js';
import { LinkButton } from '../components/ui/link-button/index.js';
import { MenuItem } from '../components/ui/menu-item/index.js';
import { Button } from '../components/ui/button/index.js';
import { ClickableSelect } from '../components/ui/clickable-select/index.js';
import { ClickableMultiSelect } from '../components/ui/clickable-multi-select/index.js';
import { ComboBox } from '../components/ui/combobox/index.js';
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
    // --- Clickable components (step 5 batch 7) ---
    // Link: a clickable URL rendered as an OSC 8 terminal hyperlink.
    // The terminal emulator handles the click itself (Cmd+Click opens the
    // URL) — no GenUI action is dispatched. In terminals without OSC 8
    // support, the URL is shown after the label in parentheses.
    defineGenUIComponent({
      name: 'Link',
      description: 'A clickable URL rendered as a terminal hyperlink (OSC 8). The terminal handles the click — no action is dispatched. Use for external resources the model should cite.',
      schema: zv4.object({
        url: zv4.string(),
        label: zv4.string().optional(),
      }) as any,
      render: (props: any) => React.createElement(Link, {
        url: props.url,
        label: props.label,
      }),
    }),
    // LinkButton: chromeless clickable text that dispatches a GenUI action.
    // Use for inline interactions like "click to expand", "show more", "copy".
    // The click calls ctx.dispatchAction(props.action, ctx.runtime.getValues()).
    defineGenUIComponent({
      name: 'LinkButton',
      description: 'A chromeless clickable text element (no border, no button chrome). Dispatches the named action on click. Use for inline interactions like "click to expand" or "show more".',
      schema: zv4.object({
        label: zv4.string(),
        action: zv4.string(),
        icon: zv4.string().optional(),
      }) as any,
      render: (props: any, ctx: GenUIRenderContext) => React.createElement(LinkButton, {
        label: props.label,
        icon: props.icon,
        onClick: () => {
          if (props.action) {
            void ctx.dispatchAction(props.action, ctx.runtime.getValues());
          }
        },
      }),
    }),
    // MenuItem: a clickable menu row with icon + label + optional shortcut.
    // Dispatches the named action on click OR keyboard select. The parent
    // menu is responsible for tracking which item is isActive (hover or
    // keyboard focus). Use for dropdown menus, context menus, command palettes.
    defineGenUIComponent({
      name: 'MenuItem',
      description: 'A clickable menu row — icon + label + optional shortcut hint. Dispatches the named action on click. The parent menu tracks isActive (hover or keyboard focus). Use for dropdown menus, context menus, and command palettes.',
      schema: zv4.object({
        label: zv4.string(),
        action: zv4.string(),
        icon: zv4.string().optional(),
        shortcut: zv4.string().optional(),
        isActive: zv4.boolean().optional(),
        isDisabled: zv4.boolean().optional(),
      }) as any,
      render: (props: any, ctx: GenUIRenderContext) => React.createElement(MenuItem, {
        label: props.label,
        icon: props.icon,
        shortcut: props.shortcut,
        isActive: props.isActive,
        isDisabled: props.isDisabled,
        onClick: () => {
          if (props.action) {
            void ctx.dispatchAction(props.action, ctx.runtime.getValues());
          }
        },
      }),
    }),
    // --- Clickable form components (step 5 batch 7.2) ---
    // Button: a bordered standalone button (not the GenUI default Button
    // which is already in createDefaultComponents). This variant supports
    // color variants (primary/secondary/danger/success) + icon.
    defineGenUIComponent({
      name: 'StyledButton',
      description: 'A bordered action button with color variant support (primary/secondary/danger/success) and optional icon. Dispatches the named action on click.',
      schema: zv4.object({
        label: zv4.string(),
        action: zv4.string(),
        variant: zv4.enum(['primary', 'secondary', 'danger', 'success']).optional(),
        icon: zv4.string().optional(),
        isDisabled: zv4.boolean().optional(),
      }) as any,
      render: (props: any, ctx: GenUIRenderContext) => React.createElement(Button, {
        label: props.label,
        variant: props.variant,
        icon: props.icon,
        isDisabled: props.isDisabled,
        onClick: () => {
          if (props.action) {
            void ctx.dispatchAction(props.action, ctx.runtime.getValues());
          }
        },
      }),
    }),
    // ClickableSelect: mouse + keyboard single-select dropdown.
    // Each option is a clickable row. The parent tracks activeIndex.
    defineGenUIComponent({
      name: 'ClickableSelect',
      description: 'A mouse + keyboard driven single-selection dropdown. Each option row is clickable. Dispatches the named action with the selected value on click.',
      schema: zv4.object({
        action: zv4.string(),
        options: zv4.array(zv4.object({
          label: zv4.string(),
          value: zv4.string(),
          icon: zv4.string().optional(),
          shortcut: zv4.string().optional(),
        })),
        activeIndex: zv4.number().optional(),
        isDisabled: zv4.boolean().optional(),
      }) as any,
      render: (props: any, ctx: GenUIRenderContext) => React.createElement(ClickableSelect, {
        options: props.options,
        activeIndex: props.activeIndex ?? -1,
        isDisabled: props.isDisabled,
        onSelect: (value: string) => {
          if (props.action) {
            // Merge the selected value into the form state before dispatching.
            ctx.runtime.setValue('__selected', value);
            void ctx.dispatchAction(props.action, ctx.runtime.getValues());
          }
        },
      }),
    }),
    // ClickableMultiSelect: checkboxes, mouse + keyboard multi-select.
    defineGenUIComponent({
      name: 'ClickableMultiSelect',
      description: 'A mouse + keyboard multi-selection dropdown with checkboxes (✓/☐). Each row is click-to-toggle. Dispatches the named action with all selected values on each toggle.',
      schema: zv4.object({
        action: zv4.string(),
        options: zv4.array(zv4.object({
          label: zv4.string(),
          value: zv4.string(),
        })),
        selectedValues: zv4.array(zv4.string()).optional(),
        isDisabled: zv4.boolean().optional(),
      }) as any,
      render: (props: any, ctx: GenUIRenderContext) => {
        const selected = new Set<string>(props.selectedValues ?? []);
        return React.createElement(ClickableMultiSelect, {
          options: props.options,
          selectedValues: selected,
          isDisabled: props.isDisabled,
          onToggle: (_value: string, _isSelected: boolean) => {
            // After toggling, read the current selection from the runtime
            // form state (the parent should have updated it via an action).
            // For GenUI, we dispatch the action with the toggle info.
            if (props.action) {
              void ctx.dispatchAction(props.action, ctx.runtime.getValues());
            }
          },
        });
      },
    }),
    // ComboBox: text input + clickable filtered dropdown (autocomplete).
    defineGenUIComponent({
      name: 'ComboBox',
      description: 'A text input with a filtered dropdown of clickable suggestions (autocomplete / typeahead). Dispatches the named action when a suggestion is selected.',
      schema: zv4.object({
        action: zv4.string(),
        options: zv4.array(zv4.object({
          label: zv4.string(),
          value: zv4.string(),
        })),
        placeholder: zv4.string().optional(),
        maxSuggestions: zv4.number().optional(),
        isDisabled: zv4.boolean().optional(),
      }) as any,
      render: (props: any, ctx: GenUIRenderContext) => {
        // The ComboBox is controlled — we need state for the input value.
        // GenUI components are supposed to be stateless (the runtime owns
        // form state via ctx.runtime.setValue/getValue), so we wire the
        // input to the runtime's form state under a generated key.
        const valueKey = `__combo_${props.action}`;
        const value = (ctx.runtime.getValue(valueKey) as string) ?? '';
        return React.createElement(ComboBox, {
          value,
          onChange: (v: string) => ctx.runtime.setValue(valueKey, v),
          options: props.options,
          placeholder: props.placeholder,
          maxSuggestions: props.maxSuggestions,
          isDisabled: props.isDisabled,
          onSelect: (selectedValue: string) => {
            ctx.runtime.setValue(valueKey, selectedValue);
            if (props.action) {
              void ctx.dispatchAction(props.action, ctx.runtime.getValues());
            }
          },
        });
      },
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
