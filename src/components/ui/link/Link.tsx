/**
 * src/components/ui/link/Link.tsx
 *
 * A clickable URL rendered as an OSC 8 terminal hyperlink.
 *
 * In terminals that support OSC 8 (iTerm2, Kitty, WezTerm, GNOME Terminal,
 * Windows Terminal, etc.), the label renders as a real Cmd+Click-able URL —
 * the terminal emulator handles the click itself, no `Box onClick` needed.
 * In unsupported terminals, the label shows as plain styled text and the
 * URL is printed after it in parentheses so the user can copy it.
 *
 * This is the "real link" component — contrast with `LinkButton` which is
 * a chromeless clickable TEXT (uses `Box onClick`, no URL, dispatches an
 * arbitrary action). Use `Link` when you have a URL; use `LinkButton` when
 * you have an action.
 *
 * Built on top of `hyperlink(url, label)` from `@nemesis-oss/termina-core`,
 * which wraps the label in the OSC 8 escape sequence. The wrapper is
 * zero-width in layout, so it doesn't affect column measurements.
 *
 * Props:
 *   - url:     the URL to open on Cmd+Click
 *   - label:   the visible text (defaults to the URL itself)
 *   - color, bold, underline, dimColor: standard Text styling
 *   - showUrl: if true (default for unsupported terminals), append " (url)"
 *              after the label so the URL is visible. OSC 8 capable
 *              terminals don't need this because the label IS the link.
 *
 * Usage:
 *   <Link url="https://github.com/shubhamtaywade82/agent-tui" label="View repo" />
 *   <Link url="https://example.com" />  // label defaults to the URL
 */
import React from 'react';
import { Text, Box, hyperlink, detectTerminalCapabilities } from '@nemesis-oss/termina-core';

export interface LinkProps {
  /** The URL to open on Cmd+Click. */
  readonly url: string;
  /** The visible text. Defaults to the URL itself. */
  readonly label?: string;
  /** Text color (chalk color name or hex). @default 'cyan' */
  readonly color?: string;
  /** Bold the label. @default false */
  readonly bold?: boolean;
  /** Underline the label. @default true (links are underlined by convention) */
  readonly underline?: boolean;
  /** Dim the label. @default false */
  readonly dimColor?: boolean;
  /**
   * Whether to append " (url)" after the label so the URL is visible.
   * Default 'auto' — only appends when the terminal does NOT support OSC 8.
   * Set to true to always show, false to never show.
   * @default 'auto'
   */
  readonly showUrl?: 'auto' | boolean;
}

export const Link: React.FC<LinkProps> = ({
  url,
  label,
  color = 'cyan',
  bold = false,
  underline = true,
  dimColor = false,
  showUrl = 'auto',
}) => {
  const text = label ?? url;
  const linkText = hyperlink(url, text);

  // Decide whether to show the URL after the label.
  // 'auto' = show only if the terminal doesn't support OSC 8 hyperlinks.
  // Access process.stdout directly (without useStdout hook) so the
  // component is pure and testable outside a React render context.
  let shouldShowUrl: boolean;
  if (showUrl === 'auto') {
    // detectTerminalCapabilities probes the environment + stream once and
    // is memoized internally. Falls back to 'no capabilities' on non-TTY
    // stdout (e.g. piped output), which means the URL is shown.
    try {
      const stream = typeof process !== 'undefined' && process.stdout
        ? { isTTY: (process.stdout as { isTTY?: boolean }).isTTY }
        : { isTTY: false };
      const caps = detectTerminalCapabilities(
        (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>,
        stream,
      );
      // caps.hyperlinks is true when the terminal advertises OSC 8 support.
      shouldShowUrl = !caps.hyperlinks;
    } catch {
      // If capability detection fails, assume no OSC 8 support — show URL.
      shouldShowUrl = true;
    }
  } else {
    shouldShowUrl = showUrl;
  }

  return (
    <Box>
      <Text color={color} bold={bold} underline={underline} dimColor={dimColor}>
        {linkText}
      </Text>
      {shouldShowUrl && (
        <Text dimColor> ({url})</Text>
      )}
    </Box>
  );
};
