/**
 * src/components/ui/link-button/LinkButton.tsx
 *
 * A chromeless clickable text element. Uses `<Box onClick>` + `<Text>` —
 * no border, no padding, no button chrome. The text is styled (default:
 * cyan + underlined) to signal clickability.
 *
 * Contrast with:
 *   - `Link`    — for URLs. Uses OSC 8 terminal hyperlinks; click handled
 *                 by the terminal emulator itself, no `Box onClick`.
 *   - `Button`  — for prominent actions. Bordered box, bold styling.
 *
 * Use `LinkButton` for inline clickable text like "click to expand",
 * "click to copy", "show more", "hide", etc. — anywhere you'd use an
 * HTML `<a href="#" onClick={...}>` or a Material-UI "text button".
 *
 * The click handler receives the termina-core `MouseEvent` so you can
 * distinguish left-click from right-click, check for modifier keys
 * (shift/ctrl/meta), etc.
 *
 * Requires mouse tracking to be enabled: `render(<App/>, {mouse: true})`.
 * In terminals without mouse support, the LinkButton renders as styled
 * text with no click behavior — it's still visually a link, just not
 * interactive. (Use `useInput` if you need keyboard activation too.)
 *
 * Props:
 *   - label:    the visible text
 *   - onClick:  click handler (receives MouseEvent)
 *   - color, bold, underline, dimColor: standard Text styling
 *   - icon:     optional icon/emoji before the label (e.g. '📋', '▶')
 *
 * Usage:
 *   <LinkButton label="click to expand" onClick={() => setExpanded(!expanded)} />
 *   <LinkButton icon="📋" label="copy" onClick={() => copyToClipboard(text)} />
 */
import React from 'react';
import { Box, Text, type MouseEvent } from '@nemesis-oss/termina-core';

export interface LinkButtonProps {
  /** The visible text. */
  readonly label: string;
  /** Click handler — receives the termina-core MouseEvent. */
  readonly onClick?: (event: MouseEvent) => void;
  /** Optional icon/emoji rendered before the label (e.g. '📋', '▶', '✓'). */
  readonly icon?: string;
  /** Text color. @default 'cyan' */
  readonly color?: string;
  /** Bold the label. @default false */
  readonly bold?: boolean;
  /** Underline the label. @default true (signals clickability) */
  readonly underline?: boolean;
  /** Dim the label. @default false */
  readonly dimColor?: boolean;
}

export const LinkButton: React.FC<LinkButtonProps> = ({
  label,
  onClick,
  icon,
  color = 'cyan',
  bold = false,
  underline = true,
  dimColor = false,
}) => {
  return (
    <Box onClick={onClick}>
      {icon ? (
        <Text color={color} bold={bold} underline={underline} dimColor={dimColor}>
          {icon} {label}
        </Text>
      ) : (
        <Text color={color} bold={bold} underline={underline} dimColor={dimColor}>
          {label}
        </Text>
      )}
    </Box>
  );
};
