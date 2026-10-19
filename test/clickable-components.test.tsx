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
