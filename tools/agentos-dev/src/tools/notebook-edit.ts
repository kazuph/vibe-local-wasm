import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const notebookEditInputSchema = z.object({
  path: z.string().min(1),
  cell_index: z.number().int().min(0),
  new_source: z.string(),
  cell_type: z.enum(["code", "markdown"]).optional(),
  edit_mode: z.enum(["replace", "insert", "delete"]).default("replace"),
});

export type NotebookEditInput = z.infer<typeof notebookEditInputSchema>;

export type NotebookEditResult = {
  ok: boolean;
  path: string;
  mode: string;
  cell_index: number;
  total_cells: number;
  error?: string;
};

// Jupyter notebook cell types
type CodeCell = {
  cell_type: "code";
  source: string | string[];
  outputs: unknown[];
  execution_count: null;
  metadata: Record<string, unknown>;
};

type MarkdownCell = {
  cell_type: "markdown";
  source: string | string[];
  metadata: Record<string, unknown>;
};

type NotebookCell = CodeCell | MarkdownCell;

type Notebook = {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor?: number;
};

/**
 * Convert a string into the Jupyter source array format.
 * Each non-last line gets a "\n" suffix; empty string becomes [""].
 */
function formatSource(src: string): string[] {
  if (src === "") return [""];
  const lines = src.split("\n");
  return lines.map((line, i) => (i < lines.length - 1 ? line + "\n" : line));
}

/**
 * Create a new code cell with the given source.
 */
function makeCodeCell(source: string[]): CodeCell {
  return {
    cell_type: "code",
    source,
    outputs: [],
    execution_count: null,
    metadata: {},
  };
}

/**
 * Create a new markdown cell with the given source.
 */
function makeMarkdownCell(source: string[]): MarkdownCell {
  return {
    cell_type: "markdown",
    source,
    metadata: {},
  };
}

export async function editNotebook(
  input: NotebookEditInput,
  repoRoot: string
): Promise<NotebookEditResult> {
  const { cell_index, new_source, cell_type, edit_mode } = input;

  // 1. Resolve to absolute path
  const absPath = path.resolve(repoRoot, input.path);

  // 2. Validate path stays within repoRoot (no .. escapes)
  const relative = path.relative(repoRoot, absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      ok: false,
      path: input.path,
      mode: edit_mode,
      cell_index,
      total_cells: 0,
      error: `Path "${input.path}" escapes the repository root`,
    };
  }

  // 3. Read file
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf-8");
  } catch (err) {
    return {
      ok: false,
      path: input.path,
      mode: edit_mode,
      cell_index,
      total_cells: 0,
      error: `Failed to read file: ${String(err)}`,
    };
  }

  // 4. Parse JSON and validate it's a notebook
  let notebook: Notebook;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>)["cells"]) ||
      typeof (parsed as Record<string, unknown>)["nbformat"] !== "number"
    ) {
      throw new Error(
        'Not a valid Jupyter notebook: missing "cells" array or "nbformat"'
      );
    }
    notebook = parsed as Notebook;
  } catch (err) {
    return {
      ok: false,
      path: input.path,
      mode: edit_mode,
      cell_index,
      total_cells: 0,
      error: `Failed to parse notebook: ${String(err)}`,
    };
  }

  const cells = notebook.cells;
  const total_cells_before = cells.length;
  const source = formatSource(new_source);

  // 5. Apply edit_mode
  if (edit_mode === "replace") {
    // Error if out of bounds
    if (cell_index >= cells.length) {
      return {
        ok: false,
        path: input.path,
        mode: edit_mode,
        cell_index,
        total_cells: total_cells_before,
        error: `cell_index ${cell_index} is out of bounds (total: ${cells.length})`,
      };
    }

    const existingCell = cells[cell_index];
    const targetType = cell_type ?? existingCell.cell_type;

    if (targetType === "code") {
      cells[cell_index] = makeCodeCell(source);
    } else {
      cells[cell_index] = makeMarkdownCell(source);
    }
  } else if (edit_mode === "insert") {
    // cell_type defaults to "code" if not provided
    const insertType = cell_type ?? "code";
    let newCell: NotebookCell;

    if (insertType === "code") {
      newCell = makeCodeCell(source);
    } else {
      newCell = makeMarkdownCell(source);
    }

    // Insert AT cell_index (others shift down)
    // If cell_index >= length, append at end
    const insertAt = Math.min(cell_index, cells.length);
    cells.splice(insertAt, 0, newCell);
  } else if (edit_mode === "delete") {
    // Error if cell_index >= total_cells
    if (cell_index >= cells.length) {
      return {
        ok: false,
        path: input.path,
        mode: edit_mode,
        cell_index,
        total_cells: total_cells_before,
        error: `cell_index ${cell_index} is out of bounds (total: ${cells.length})`,
      };
    }

    cells.splice(cell_index, 1);
  }

  // 6. Write back with 2-space indent
  try {
    await fs.writeFile(absPath, JSON.stringify(notebook, null, 2), "utf-8");
  } catch (err) {
    return {
      ok: false,
      path: input.path,
      mode: edit_mode,
      cell_index,
      total_cells: total_cells_before,
      error: `Failed to write file: ${String(err)}`,
    };
  }

  return {
    ok: true,
    path: input.path,
    mode: edit_mode,
    cell_index,
    total_cells: notebook.cells.length,
  };
}
