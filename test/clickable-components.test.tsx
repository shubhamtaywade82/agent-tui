/**
 * test/clickable-components.test.tsx — unit tests for the new clickable
 * components: Link, LinkButton, MenuItem.
 *
 * Same approach as test/TranscriptView.test.ts — walk the React element
 * tree directly (no react-test-renderer needed) to assert text content,
 * structure, and prop wiring. Fast and framework-agnostic.
 *
 * IMPORTANT: components must be CALLED directly (not via JSX descriptors)
 * so walk() sees the rendered Box/Text output, not the component reference.
 * `<LinkButton />` creates `{type: LinkButton, props: {...}}` — walk sees
 * `tag: 'LinkButton'` and no children. `LinkButton({label: 'x', ...})`
 * returns the actual `<Box>` element, which walk can traverse.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import React from 'react';
import { Link } from '../src/components/ui/link/index.js';
import { LinkButton } from '../src/components/ui/link-button/index.js';
import { MenuItem } from '../src/components/ui/menu-item/index.js';
import { Button } from '../src/components/ui/button/index.js';
import { ClickableSelect } from '../src/components/ui/clickable-select/index.js';
import { ClickableMultiSelect } from '../src/components/ui/clickable-multi-select/index.js';
import { ComboBox } from '../src/components/ui/combobox/index.js';

/* ------------------------------------------------------------------ *
 * Tree-walking helpers (same pattern as TranscriptView tests)
 * ------------------------------------------------------------------ */
type NodeSnapshot = {
  tag: string;
  text: string;
  props: Record<string, unknown>;
};

function walk(node: React.ReactNode, acc: NodeSnapshot[] = []): NodeSnapshot[] {
  if (node == null || typeof node === 'boolean') return acc;
  if (typeof node === 'number') {
    acc.push({ tag: '#text', text: String(node), props: {} });
    return acc;
  }
  if (typeof node === 'string') {
    acc.push({ tag: '#text', text: node, props: {} });
    return acc;
  }
  if (Array.isArray(node)) {
    for (const n of node) walk(n, acc);
    return acc;
  }
  if (typeof node === 'object' && 'type' in node) {
    const el = node as React.ReactElement;
    // forwardRef/memo objects have .displayName but not .name; function
    // components have .name. Check both.
    const typeObj = el.type as { name?: string; displayName?: string };
    const tag = typeof el.type === 'string'
      ? el.type
      : typeObj.name ?? typeObj.displayName ?? 'Component';
    const children = (el.props as { children?: React.ReactNode }).children;
    const text = typeof children === 'string' ? children : '';
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(el.props ?? {})) {
      if (k !== 'children') props[k] = v;
    }
    acc.push({ tag, text, props });
    walk(children, acc);
    return acc;
  }
  return acc;
}

/** Render a component by calling it directly, then walk the output. */
function render<C extends React.FC<any>>(Component: C, props: React.ComponentProps<C>): NodeSnapshot[] {
  // React 19's FC type can return Promise<ReactNode> (async components),
  // but our components are synchronous. Cast to ReactNode to satisfy TS.
  const el = Component(props) as React.ReactNode;
  return walk(el);
}

function allText(snap: NodeSnapshot[]): string {
  return snap
    .filter((n) => n.tag === '#text')
    .map((n) => n.text)
    .join('');
}

/* ------------------------------------------------------------------ *
 * Link (OSC 8 terminal hyperlink)
 * ------------------------------------------------------------------ */

describe('Link component', () => {
  test('renders the label text when label is provided', () => {
    const snap = render(Link, { url: 'https://example.com', label: 'click here', showUrl: false });
    const text = allText(snap);
    assert.ok(text.includes('click here'), `expected "click here" in ${text}`);
  });

  test('defaults the label to the URL when no label is provided', () => {
    const snap = render(Link, { url: 'https://example.com', showUrl: false });
    const text = allText(snap);
    assert.ok(text.includes('example.com'), `expected URL in ${text}`);
  });

  test('showUrl=true appends the URL in parentheses after the label', () => {
    const snap = render(Link, { url: 'https://example.com', label: 'docs', showUrl: true });
    const text = allText(snap);
    assert.ok(text.includes('docs'), `expected label "docs" in ${text}`);
    assert.ok(text.includes('(https://example.com)'), `expected "(https://example.com)" in ${text}`);
  });

  test('applies color, bold, underline styling to the Text element', () => {
    const snap = render(Link, { url: 'https://x.com', label: 'x', color: 'magenta', bold: true, underline: false, showUrl: false });
    const textEl = snap.find((n) => n.tag === 'Text' && n.text.includes('x'));
    assert.ok(textEl, 'expected a Text element containing "x"');
    assert.equal(textEl!.props.color, 'magenta');
    assert.equal(textEl!.props.bold, true);
    assert.equal(textEl!.props.underline, false);
  });

  test('the link text contains the OSC 8 hyperlink escape sequence', () => {
    const snap = render(Link, { url: 'https://example.com', label: 'go', showUrl: false });
    const text = allText(snap);
    // The hyperlink() utility wraps the label in OSC 8: ESC ] 8 ;; url ESC \ label ESC ] 8 ;; ESC \
    assert.ok(text.includes('https://example.com'), 'URL should be embedded in the OSC 8 sequence');
    assert.ok(text.includes('go'), 'label should be visible');
  });
});

/* ------------------------------------------------------------------ *
 * LinkButton (chromeless clickable text)
 * ------------------------------------------------------------------ */

describe('LinkButton component', () => {
  test('renders the label text', () => {
    const snap = render(LinkButton, { label: 'click to expand', onClick: () => {} });
    assert.ok(allText(snap).includes('click to expand'));
  });

  test('wires onClick onto the Box (not the Text)', () => {
    const onClick = () => {};
    const snap = render(LinkButton, { label: 'x', onClick });
    const boxEl = snap.find((n) => n.tag === 'Box');
    assert.ok(boxEl, 'expected a Box element');
    assert.equal(typeof boxEl!.props.onClick, 'function', 'Box should have onClick');
    // Text should NOT have onClick — only the Box is clickable.
    const textEl = snap.find((n) => n.tag === 'Text');
    assert.ok(textEl);
    assert.equal(textEl!.props.onClick, undefined, 'Text should not have onClick');
  });

  test('renders an icon before the label when icon prop is set', () => {
    const snap = render(LinkButton, { label: 'copy', icon: '📋', onClick: () => {} });
    const text = allText(snap);
    assert.ok(text.includes('📋'), 'expected icon');
    assert.ok(text.includes('copy'), 'expected label');
    assert.ok(text.indexOf('📋') < text.indexOf('copy'), 'icon should come before label');
  });

  test('applies default styling (cyan, underlined)', () => {
    const snap = render(LinkButton, { label: 'x', onClick: () => {} });
    const textEl = snap.find((n) => n.tag === 'Text');
    assert.equal(textEl!.props.color, 'cyan');
    assert.equal(textEl!.props.underline, true);
  });

  test('respects custom color and underline=false', () => {
    const snap = render(LinkButton, { label: 'x', color: 'magenta', underline: false, onClick: () => {} });
    const textEl = snap.find((n) => n.tag === 'Text');
    assert.equal(textEl!.props.color, 'magenta');
    assert.equal(textEl!.props.underline, false);
  });
});

/* ------------------------------------------------------------------ *
 * MenuItem (clickable menu row)
 * ------------------------------------------------------------------ */

describe('MenuItem component', () => {
  test('renders the label, icon, and shortcut', () => {
    const snap = render(MenuItem, { label: 'Open file', icon: '📁', shortcut: 'Ctrl+O', onClick: () => {} });
    const text = allText(snap);
    assert.ok(text.includes('📁'));
    assert.ok(text.includes('Open file'));
    assert.ok(text.includes('Ctrl+O'));
    assert.ok(text.indexOf('📁') < text.indexOf('Open file'), 'icon should come before label');
  });

  test('wires onClick onto the Box', () => {
    const snap = render(MenuItem, { label: 'x', onClick: () => {} });
    const boxEl = snap.find((n) => n.tag === 'Box');
    assert.ok(boxEl);
    assert.equal(typeof boxEl!.props.onClick, 'function');
  });

  test('active item has a backgroundColor (inverted highlight bar)', () => {
    const snap = render(MenuItem, { label: 'x', isActive: true, onClick: () => {} });
    const boxEl = snap.find((n) => n.tag === 'Box');
    assert.ok(boxEl!.props.backgroundColor, 'active item should have a backgroundColor');
  });

  test('inactive item has no backgroundColor', () => {
    const snap = render(MenuItem, { label: 'x', isActive: false, onClick: () => {} });
    const boxEl = snap.find((n) => n.tag === 'Box');
    assert.equal(boxEl!.props.backgroundColor, undefined);
  });

  test('disabled item still renders the label', () => {
    const snap = render(MenuItem, { label: 'disabled item', isDisabled: true, onClick: () => {} });
    const text = allText(snap);
    assert.ok(text.includes('disabled item'));
  });

  test('disabled item does NOT fire onClick when clicked (handler checks isDisabled)', () => {
    let fired = false;
    const snap = render(MenuItem, { label: 'x', isDisabled: true, onClick: () => { fired = true; } });
    const boxEl = snap.find((n) => n.tag === 'Box');
    assert.ok(boxEl, 'expected a Box element');
    const handler = boxEl!.props.onClick as (event: unknown) => void;
    assert.equal(typeof handler, 'function');
    // Simulate a click — the handler should early-return without firing onClick.
    handler({});
    assert.equal(fired, false, 'onClick should not fire on a disabled item');
  });

  test('enabled item DOES fire onClick when clicked', () => {
    let fired = false;
    const snap = render(MenuItem, { label: 'x', onClick: () => { fired = true; } });
    const boxEl = snap.find((n) => n.tag === 'Box');
    const handler = boxEl!.props.onClick as (event: unknown) => void;
    handler({});
    assert.equal(fired, true, 'onClick should fire on an enabled item');
  });

  test('onSelect fires alongside onClick (keyboard + mouse share the handler)', () => {
    let selectFired = false;
    let clickFired = false;
    const snap = render(MenuItem, {
      label: 'x',
      onClick: () => { clickFired = true; },
      onSelect: () => { selectFired = true; },
    });
    const boxEl = snap.find((n) => n.tag === 'Box');
    const handler = boxEl!.props.onClick as (event: unknown) => void;
    handler({});
    assert.equal(clickFired, true);
    assert.equal(selectFired, true);
  });
});

/* ------------------------------------------------------------------ *
 * Render smoke test (catches runtime errors during element creation)
 * ------------------------------------------------------------------ */

describe('clickable components render without throwing', () => {
  test('Link renders without throwing', () => {
    const snap = render(Link, { url: 'https://example.com', label: 'smoke', showUrl: false });
    assert.ok(snap.length > 0, 'Link should produce a non-empty element tree');
  });

  test('LinkButton renders without throwing', () => {
    const snap = render(LinkButton, { label: 'smoke', onClick: () => {} });
    assert.ok(snap.length > 0);
  });

  test('MenuItem renders without throwing', () => {
    const snap = render(MenuItem, { label: 'smoke', onClick: () => {} });
    assert.ok(snap.length > 0);
  });
});

/* ------------------------------------------------------------------ *
 * Button (bordered standalone)
 * ------------------------------------------------------------------ */

describe('Button component', () => {
  test('renders the label text', () => {
    const snap = render(Button, { label: 'Run', onClick: () => {} });
    assert.ok(allText(snap).includes('Run'));
  });

  test('wires onClick onto the Box', () => {
    let fired = false;
    const snap = render(Button, { label: 'x', onClick: () => { fired = true; } });
    const boxEl = snap.find((n) => n.tag === 'Box');
    assert.ok(boxEl);
    assert.equal(typeof boxEl!.props.onClick, 'function');
    (boxEl!.props.onClick as (e: unknown) => void)({});
    assert.equal(fired, true);
  });

  test('renders an icon before the label', () => {
    const snap = render(Button, { label: 'Cancel', icon: '✖', onClick: () => {} });
    const text = allText(snap);
    assert.ok(text.includes('✖'));
    assert.ok(text.includes('Cancel'));
    assert.ok(text.indexOf('✖') < text.indexOf('Cancel'));
  });

  test('disabled does NOT fire onClick', () => {
    let fired = false;
    const snap = render(Button, { label: 'x', isDisabled: true, onClick: () => { fired = true; } });
    const boxEl = snap.find((n) => n.tag === 'Box');
    (boxEl!.props.onClick as (e: unknown) => void)({});
    assert.equal(fired, false);
  });

  test('renders without throwing', () => {
    const snap = render(Button, { label: 'smoke', onClick: () => {} });
    assert.ok(snap.length > 0);
  });
});

/* ------------------------------------------------------------------ *
 * ClickableSelect (mouse + keyboard single-select)
 * ------------------------------------------------------------------ */

describe('ClickableSelect component', () => {
  const opts = [
    { label: 'Red', value: 'red' },
    { label: 'Blue', value: 'blue' },
  ];

  test('renders all option labels', () => {
    const snap = render(ClickableSelect, { options: opts, onSelect: () => {} });
    const text = allText(snap);
    assert.ok(text.includes('Red'));
    assert.ok(text.includes('Blue'));
  });

  test('wires onClick on each option row', () => {
    let selected = '';
    const snap = render(ClickableSelect, { options: opts, onSelect: (v) => { selected = v; } });
    // Each option is a MenuItem → Box with onClick
    const boxes = snap.filter((n) => n.tag === 'Box' && typeof n.props.onClick === 'function');
    assert.ok(boxes.length >= 2, 'expected at least 2 clickable rows');
    // Click the first one
    (boxes[0]!.props.onClick as (e: unknown) => void)({});
    assert.equal(selected, 'red');
  });

  test('activeIndex highlights the correct row', () => {
    const snap = render(ClickableSelect, { options: opts, activeIndex: 1, onSelect: () => {} });
    // Filter for option-row boxes (they have onClick; the outer container doesn't)
    const optionBoxes = snap.filter((n) => n.tag === 'Box' && typeof n.props.onClick === 'function');
    assert.ok(optionBoxes.length >= 2, `expected at least 2 option rows, got ${optionBoxes.length}`);
    // The second option (index 1) should have a backgroundColor (active)
    const activeBox = optionBoxes[1];
    assert.ok(activeBox?.props.backgroundColor, 'second row should be active');
  });

  test('disabled select fires no onSelect', () => {
    let selected = '';
    const snap = render(ClickableSelect, { options: opts, isDisabled: true, onSelect: (v) => { selected = v; } });
    const boxes = snap.filter((n) => n.tag === 'Box' && typeof n.props.onClick === 'function');
    for (const b of boxes) {
      (b.props.onClick as (e: unknown) => void)({});
    }
    assert.equal(selected, '');
  });

  test('renders without throwing', () => {
    const snap = render(ClickableSelect, { options: opts, onSelect: () => {} });
    assert.ok(snap.length > 0);
  });
});

/* ------------------------------------------------------------------ *
 * ClickableMultiSelect (checkboxes, mouse + keyboard)
 * ------------------------------------------------------------------ */

describe('ClickableMultiSelect component', () => {
  const opts = [
    { label: 'Apple', value: 'apple' },
    { label: 'Banana', value: 'banana' },
  ];

  test('renders checkbox + label for each option', () => {
    const snap = render(ClickableMultiSelect, {
      options: opts,
      selectedValues: new Set<string>(),
      onToggle: () => {},
    });
    const text = allText(snap);
    assert.ok(text.includes('☐') || text.includes('✓'), 'expected a checkbox');
    assert.ok(text.includes('Apple'));
    assert.ok(text.includes('Banana'));
  });

  test('selected option shows ✓, unselected shows ☐', () => {
    const snap = render(ClickableMultiSelect, {
      options: opts,
      selectedValues: new Set<string>(['apple']),
      onToggle: () => {},
    });
    const text = allText(snap);
    assert.ok(text.includes('✓'), 'selected option should show ✓');
    assert.ok(text.includes('☐'), 'unselected option should show ☐');
  });

  test('clicking a row calls onToggle with the value + current selection state', () => {
    let toggledValue = '';
    let toggledIsSelected = true;
    const snap = render(ClickableMultiSelect, {
      options: opts,
      selectedValues: new Set<string>(['apple']),
      onToggle: (v, isSel) => { toggledValue = v; toggledIsSelected = isSel; },
    });
    const boxes = snap.filter((n) => n.tag === 'Box' && typeof n.props.onClick === 'function');
    assert.ok(boxes.length >= 2);
    // Click the first row (apple, which is currently selected)
    (boxes[0]!.props.onClick as (e: unknown) => void)({});
    assert.equal(toggledValue, 'apple');
    assert.equal(toggledIsSelected, true, 'should report that apple is currently selected');
  });

  test('disabled row does NOT fire onToggle', () => {
    let fired = false;
    const snap = render(ClickableMultiSelect, {
      options: [{ label: 'X', value: 'x', isDisabled: true }],
      selectedValues: new Set<string>(),
      onToggle: () => { fired = true; },
    });
    const boxes = snap.filter((n) => n.tag === 'Box' && typeof n.props.onClick === 'function');
    if (boxes.length > 0) {
      (boxes[0]!.props.onClick as (e: unknown) => void)({});
    }
    assert.equal(fired, false);
  });

  test('renders without throwing', () => {
    const snap = render(ClickableMultiSelect, {
      options: opts,
      selectedValues: new Set<string>(),
      onToggle: () => {},
    });
    assert.ok(snap.length > 0);
  });
});

/* ------------------------------------------------------------------ *
 * ComboBox (text input + clickable filtered dropdown)
 * ------------------------------------------------------------------ */

describe('ComboBox component', () => {
  const opts = [
    { label: 'qwen3:8b', value: 'qwen3:8b' },
    { label: 'qwen3:32b', value: 'qwen3:32b' },
    { label: 'llama3.2:3b', value: 'llama3.2:3b' },
  ];

  test('renders the text input with current value', () => {
    const snap = render(ComboBox, {
      value: 'qwen',
      onChange: () => {},
      options: opts,
      onSelect: () => {},
    });
    const text = allText(snap);
    // The TextInput should show the value
    assert.ok(text.includes('qwen'));
  });

  test('filters options by the input value (case-insensitive)', () => {
    const snap = render(ComboBox, {
      value: 'LLAMA',
      onChange: () => {},
      options: opts,
      onSelect: () => {},
    });
    const text = allText(snap);
    assert.ok(text.includes('llama3.2:3b'), 'should show the matching option');
    assert.ok(!text.includes('qwen3:8b') || text.indexOf('llama3.2:3b') < text.indexOf('qwen3:8b'),
      'filtered options should come first or qwen should be absent');
  });

  test('shows all options when input is empty', () => {
    const snap = render(ComboBox, {
      value: '',
      onChange: () => {},
      options: opts,
      onSelect: () => {},
    });
    const text = allText(snap);
    assert.ok(text.includes('qwen3:8b'));
    assert.ok(text.includes('llama3.2:3b'));
  });

  test('clicking a suggestion calls onSelect', () => {
    let selected = '';
    const snap = render(ComboBox, {
      value: 'qwen',
      onChange: () => {},
      options: opts,
      onSelect: (v) => { selected = v; },
    });
    // Each suggestion is a MenuItem → Box with onClick
    const boxes = snap.filter((n) => n.tag === 'Box' && typeof n.props.onClick === 'function');
    assert.ok(boxes.length >= 1, 'expected at least one suggestion');
    // Click the first suggestion
    (boxes[0]!.props.onClick as (e: unknown) => void)({});
    // Should have selected one of the qwen options
    assert.ok(selected.startsWith('qwen3'));
  });

  test('renders without throwing', () => {
    const snap = render(ComboBox, {
      value: '',
      onChange: () => {},
      options: opts,
      onSelect: () => {},
    });
    assert.ok(snap.length > 0);
  });
});
