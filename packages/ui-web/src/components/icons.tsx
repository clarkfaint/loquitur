/**
 * The player's icon set (F§10.1). Every glyph is drawn from basic shapes — polygons, rectangles,
 * circles and arcs — inside one 24-unit box, so the set is original to Lectern, ships no artwork, and
 * inherits the ink colour and size of the control that holds it.
 *
 * Icons are decorative: the control around one carries its own accessible name, so every glyph here
 * is hidden from assistive technology and cannot be focused.
 */

import type { ReactNode, SVGProps } from "react";

/** One icon's own knobs: any SVG prop a caller wants to override (width, height, class, and so on). */
export type IconProps = SVGProps<SVGSVGElement>;

/** The shared frame: one viewBox, round joins, the current ink colour, and nothing read aloud. */
function Frame({ children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      className="lectern-icon"
      fill="none"
      focusable="false"
      height={20}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      width={20}
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Play: one solid triangle pointing right. */
export function PlayIcon(props: IconProps) {
  return (
    <Frame {...props}>
      <polygon fill="currentColor" points="8 5 19 12 8 19" stroke="none" />
    </Frame>
  );
}

/** Pause: two solid bars. */
export function PauseIcon(props: IconProps) {
  return (
    <Frame {...props}>
      <rect fill="currentColor" height={14} stroke="none" width={4} x={7} y={5} />
      <rect fill="currentColor" height={14} stroke="none" width={4} x={13} y={5} />
    </Frame>
  );
}

/** Previous sentence: a triangle pointing left against a bar. */
export function PreviousIcon(props: IconProps) {
  return (
    <Frame {...props}>
      <polygon fill="currentColor" points="18 5 9 12 18 19" stroke="none" />
      <path d="M6 5v14" />
    </Frame>
  );
}

/** Next sentence: the same triangle mirrored, against a bar. */
export function NextIcon(props: IconProps) {
  return (
    <Frame {...props}>
      <polygon fill="currentColor" points="6 5 15 12 6 19" stroke="none" />
      <path d="M18 5v14" />
    </Frame>
  );
}

/** Speed: a gauge arc with a needle resting to the right. */
export function SpeedIcon(props: IconProps) {
  return (
    <Frame {...props}>
      <path d="M4 17a8 8 0 0 1 16 0" />
      <path d="M12 17l5-6" />
    </Frame>
  );
}

/** Voice: a speaker cone with two sound arcs. */
export function VoiceIcon(props: IconProps) {
  return (
    <Frame {...props}>
      <polygon points="4 10 8 10 12 6 12 18 8 14 4 14" />
      <path d="M15 9a4 4 0 0 1 0 6" />
      <path d="M18 6a8 8 0 0 1 0 12" />
    </Frame>
  );
}

/** Sleep timer: a clock face with one hand. */
export function TimerIcon(props: IconProps) {
  return (
    <Frame {...props}>
      <circle cx={12} cy={13} r={7} />
      <path d="M12 10v3h3" />
      <path d="M9 3h6" />
    </Frame>
  );
}

/** Close: two crossing strokes. */
export function CloseIcon(props: IconProps) {
  return (
    <Frame {...props}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </Frame>
  );
}

/** Bookmark: a pennant with a notched foot. */
export function BookmarkIcon(props: IconProps) {
  return (
    <Frame {...props}>
      <path d="M7 4h10v16l-5-4-5 4z" />
    </Frame>
  );
}
