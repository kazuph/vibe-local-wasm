import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema & types
// ---------------------------------------------------------------------------

export const askUserInputSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
});

export type AskUserInput = z.infer<typeof askUserInputSchema>;

export type AskUserResult = {
  ok: boolean;
  answer: string;
  selected_index?: number;
  error?: string;
};

export type PendingQuestion = {
  id: string;
  question: string;
  options?: string[];
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
};

// ---------------------------------------------------------------------------
// UserQuestionBus
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export class UserQuestionBus extends EventEmitter {
  private readonly pendingMap = new Map<string, PendingQuestion>();

  /**
   * Actor side — emit a question and wait for the CLI to provide an answer.
   */
  async ask(input: AskUserInput, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<AskUserResult> {
    const parsed = askUserInputSchema.parse(input);
    const id = randomUUID();

    return new Promise<AskUserResult>((outerResolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const pending: PendingQuestion = {
        id,
        question: parsed.question,
        options: parsed.options,
        resolve: (rawAnswer: string) => {
          if (timer !== undefined) clearTimeout(timer);
          this.pendingMap.delete(id);

          const result = this._processAnswer(rawAnswer, parsed.options);
          outerResolve({ ok: true, ...result });
        },
        reject: (error: Error) => {
          if (timer !== undefined) clearTimeout(timer);
          this.pendingMap.delete(id);
          outerResolve({ ok: false, answer: "", error: error.message });
        },
      };

      this.pendingMap.set(id, pending);

      // Notify CLI (or any listener) that a question is pending
      this.emit("question", pending);

      // Optional timeout
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pendingMap.has(id)) {
            pending.reject(new Error("AskUserQuestion timed out"));
          }
        }, timeoutMs);
      }
    });
  }

  /**
   * CLI side — resolve a pending question by id.
   * Returns true if the question was found and answered, false otherwise.
   */
  answer(id: string, answer: string): boolean {
    const pending = this.pendingMap.get(id);
    if (pending === undefined) return false;
    pending.resolve(answer);
    return true;
  }

  /**
   * Returns all currently pending questions.
   */
  getPending(): PendingQuestion[] {
    return Array.from(this.pendingMap.values());
  }

  /**
   * Returns true if there are any pending questions.
   */
  hasPending(): boolean {
    return this.pendingMap.size > 0;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _processAnswer(
    raw: string,
    options: string[] | undefined,
  ): { answer: string; selected_index?: number } {
    if (options === undefined || options.length === 0) {
      return { answer: raw };
    }

    // 1. Numeric string — treat as 1-indexed selection
    const asNumber = Number(raw.trim());
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
      const idx = asNumber - 1;
      return { answer: options[idx] as string, selected_index: idx };
    }

    // 2. Exact case-sensitive match
    const exactIdx = options.indexOf(raw);
    if (exactIdx !== -1) {
      return { answer: raw, selected_index: exactIdx };
    }

    // 3. Case-insensitive match
    const lower = raw.toLowerCase();
    const ciIdx = options.findIndex((o) => o.toLowerCase() === lower);
    if (ciIdx !== -1) {
      return { answer: raw, selected_index: ciIdx };
    }

    // 4. Free-text that didn't match any option — return as-is with no index
    return { answer: raw };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const defaultQuestionBus: UserQuestionBus = new UserQuestionBus();
