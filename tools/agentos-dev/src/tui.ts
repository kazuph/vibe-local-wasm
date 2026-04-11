/**
 * TUI module — DECSTBM fixed footer + ANSI color utilities.
 *
 * Implements the same fixed-footer pattern as vibe-coder.py (ochyai/vibe-local):
 *   - 3-row footer pinned to the bottom (separator, status, hints)
 *   - Scrollable output region above the footer
 *   - ANSI color helpers for consistent styling
 *
 * References:
 *   - DECSTBM: CSI Pt ; Pb r  (Set Top and Bottom Margins)
 *   - VT100:   https://vt100.net/docs/vt100-ug/chapter3.html
 */

import { stdout } from "node:process";

// ── ANSI escape helpers ──────────────────────────────────────────────

const ESC = "\x1b";
const CSI = `${ESC}[`;

/** Reset all attributes. */
export const RESET = `${CSI}0m`;

/** Foreground colors. */
export const FG = {
  black: `${CSI}30m`,
  red: `${CSI}31m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  blue: `${CSI}34m`,
  magenta: `${CSI}35m`,
  cyan: `${CSI}36m`,
  white: `${CSI}37m`,
  gray: `${CSI}90m`,
  brightRed: `${CSI}91m`,
  brightGreen: `${CSI}92m`,
  brightYellow: `${CSI}93m`,
  brightBlue: `${CSI}94m`,
  brightMagenta: `${CSI}95m`,
  brightCyan: `${CSI}96m`,
  brightWhite: `${CSI}97m`,
} as const;

/** Text styles. */
export const STYLE = {
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  underline: `${CSI}4m`,
  inverse: `${CSI}7m`,
} as const;

// ── Color formatting functions ───────────────────────────────────────

export function bold(text: string): string {
  return `${STYLE.bold}${text}${RESET}`;
}
export function dim(text: string): string {
  return `${STYLE.dim}${text}${RESET}`;
}
export function red(text: string): string {
  return `${FG.red}${text}${RESET}`;
}
export function green(text: string): string {
  return `${FG.green}${text}${RESET}`;
}
export function yellow(text: string): string {
  return `${FG.yellow}${text}${RESET}`;
}
export function blue(text: string): string {
  return `${FG.blue}${text}${RESET}`;
}
export function cyan(text: string): string {
  return `${FG.cyan}${text}${RESET}`;
}
export function gray(text: string): string {
  return `${FG.gray}${text}${RESET}`;
}
export function magenta(text: string): string {
  return `${FG.magenta}${text}${RESET}`;
}

// ── Semantic color helpers (matching vibe-coder.py roles) ────────────

/** Tool name / invocation. */
export function toolColor(text: string): string {
  return `${FG.cyan}${text}${RESET}`;
}

/** Error messages. */
export function errorColor(text: string): string {
  return `${FG.brightRed}${STYLE.bold}${text}${RESET}`;
}

/** Status / informational messages. */
export function infoColor(text: string): string {
  return `${FG.blue}${text}${RESET}`;
}

/** User prompt indicator. */
export function promptColor(text: string): string {
  return `${FG.green}${STYLE.bold}${text}${RESET}`;
}

// ── DECSTBM Fixed Footer ────────────────────────────────────────────

const FOOTER_ROWS = 3; // separator + status + hints

export type FooterState = {
  model: string;
  mode: string;
  project: string;
  sessionId: string;
  tokenCount?: number;
  status?: string; // "idle" | "generating" | "tool:xxx" | custom
};

/**
 * Manages a fixed footer at the bottom of the terminal using DECSTBM
 * (DEC Set Top and Bottom Margins) escape sequences.
 *
 * The terminal is split into two regions:
 *   - Top: scrollable output area (rows 1 .. height - FOOTER_ROWS)
 *   - Bottom: fixed 3-row footer (separator, status line, hint bar)
 *
 * All writes to the footer happen atomically via single process.stdout.write()
 * calls to avoid visual tearing (same pattern as vibe-coder.py).
 */
export class FixedFooter {
  private enabled: boolean;
  private state: FooterState;
  private rows: number;
  private cols: number;
  private resizeHandler: (() => void) | null = null;

  constructor(initialState: FooterState) {
    this.state = { ...initialState };
    this.rows = stdout.rows ?? 24;
    this.cols = stdout.columns ?? 80;
    this.enabled = stdout.isTTY === true && !process.env.VIBE_NO_SCROLL;
  }

  /** Set up the scroll region and draw the initial footer. */
  setup(): void {
    if (!this.enabled) return;

    this.rows = stdout.rows ?? 24;
    this.cols = stdout.columns ?? 80;

    // Listen for terminal resize (SIGWINCH)
    this.resizeHandler = () => {
      this.rows = stdout.rows ?? 24;
      this.cols = stdout.columns ?? 80;
      this.applyScrollRegion();
      this.draw();
    };
    stdout.on("resize", this.resizeHandler);

    this.applyScrollRegion();
    this.draw();
  }

  /** Remove scroll region and clear footer. Call on exit. */
  teardown(): void {
    if (!this.enabled) return;

    // Remove resize listener
    if (this.resizeHandler) {
      stdout.removeListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }

    // Reset scroll region to full terminal
    stdout.write(`${CSI}r`);
    // Move cursor to bottom and clear footer rows
    const footerStart = this.rows - FOOTER_ROWS + 1;
    let clearBuf = "";
    for (let i = 0; i < FOOTER_ROWS; i++) {
      clearBuf += `${CSI}${footerStart + i};1H${CSI}2K`;
    }
    // Move cursor to just above where footer was
    clearBuf += `${CSI}${footerStart - 1};1H`;
    stdout.write(clearBuf);
  }

  /** Update footer state and redraw. */
  update(partial: Partial<FooterState>): void {
    Object.assign(this.state, partial);
    if (this.enabled) {
      this.draw();
    }
  }

  /** Check if the footer is enabled (TTY + no VIBE_NO_SCROLL). */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Get current state (read-only). */
  getState(): Readonly<FooterState> {
    return this.state;
  }

  // ── Private ──────────────────────────────────────────────────────

  private applyScrollRegion(): void {
    const scrollBottom = this.rows - FOOTER_ROWS;
    if (scrollBottom < 1) return;

    // DECSTBM: set scroll region to rows 1..scrollBottom
    stdout.write(`${CSI}1;${scrollBottom}r`);
    // Move cursor into scroll region
    stdout.write(`${CSI}${scrollBottom};1H`);
  }

  private draw(): void {
    if (!this.enabled) return;

    const scrollBottom = this.rows - FOOTER_ROWS;
    if (scrollBottom < 1) return;

    // Save cursor position (DECSC)
    const saveCursor = `${ESC}7`;
    // Restore cursor position (DECRC)
    const restoreCursor = `${ESC}8`;

    const footerStartRow = scrollBottom + 1;

    // Build footer content
    const separator = this.buildSeparator();
    const statusLine = this.buildStatusLine();
    const hintBar = this.buildHintBar();

    // Write all three rows in a single write() to prevent tearing
    // (atomic write pattern from vibe-coder.py)
    stdout.write(
      saveCursor +
      `${CSI}${footerStartRow};1H${CSI}2K${separator}` +
      `${CSI}${footerStartRow + 1};1H${CSI}2K${statusLine}` +
      `${CSI}${footerStartRow + 2};1H${CSI}2K${hintBar}` +
      restoreCursor,
    );
  }

  private buildSeparator(): string {
    const width = Math.min(this.cols, 200);
    return `${FG.gray}${"─".repeat(width)}${RESET}`;
  }

  private buildStatusLine(): string {
    const { model, mode, project, tokenCount, status } = this.state;

    const modeDisplay =
      mode === "act" ? `${FG.green}${STYLE.bold}ACT${RESET}` :
      mode === "plan" ? `${FG.yellow}${STYLE.bold}PLAN${RESET}` :
      mode === "yolo" ? `${FG.brightRed}${STYLE.bold}YOLO${RESET}` :
      `${FG.gray}${mode}${RESET}`;

    const parts: string[] = [
      `${FG.cyan}${model || "no model"}${RESET}`,
      modeDisplay,
      `${FG.blue}${project || "no project"}${RESET}`,
    ];

    if (tokenCount !== undefined && tokenCount > 0) {
      parts.push(`${FG.gray}${tokenCount} tok${RESET}`);
    }

    if (status && status !== "idle") {
      parts.push(`${FG.yellow}${status}${RESET}`);
    }

    const sep = ` ${FG.gray}│${RESET} `;
    return ` ${parts.join(sep)} `;
  }

  private buildHintBar(): string {
    const hints = [
      "/help",
      "/plan",
      "/approve",
      "/model",
      "/compact",
      "/exit",
      "ESC=stop",
    ];
    return ` ${hints.map((h) => `${FG.gray}${h}${RESET}`).join("  ")} `;
  }
}

// ── Output formatting helpers ────────────────────────────────────────

/** Format a tool execution event for CLI output. */
export function formatToolEvent(
  name: string,
  status: string,
  input?: string,
): string {
  const statusIcon =
    status === "success" ? `${FG.green}✓${RESET}` :
    status === "error" ? `${FG.red}✗${RESET}` :
    `${FG.yellow}⟳${RESET}`;

  const inputPreview = input
    ? ` ${FG.gray}${input.slice(0, 80)}${input.length > 80 ? "…" : ""}${RESET}`
    : "";

  return `${statusIcon} ${toolColor(name)}${inputPreview}`;
}

/** Format a sub-agent status line. */
export function formatSubAgent(
  id: string,
  status: string,
  prompt?: string,
): string {
  const statusDisplay =
    status === "running" ? `${FG.yellow}●${RESET}` :
    status === "done" ? `${FG.green}●${RESET}` :
    status === "error" ? `${FG.red}●${RESET}` :
    `${FG.gray}○${RESET}`;

  const promptPreview = prompt
    ? ` ${FG.gray}${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}${RESET}`
    : "";

  return `${statusDisplay} ${cyan(`agent:${id.slice(0, 8)}`)}${promptPreview}`;
}
