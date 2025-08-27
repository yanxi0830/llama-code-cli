/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolResult,
  ToolEditConfirmationDetails,
  ToolConfirmationOutcome,
} from './tools.js';
import { FunctionDeclaration } from '@google/genai';
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import * as Diff from 'diff';
import { DEFAULT_DIFF_OPTIONS } from './diffOptions.js';
import { tildeifyPath } from '../utils/paths.js';
import { ModifiableDeclarativeTool, ModifyContext } from './modifiable-tool.js';
import { SchemaValidator } from '../utils/schemaValidator.js';

const memoryToolSchemaData: FunctionDeclaration = {
  name: 'save_memory',
  description:
    'Saves a specific piece of information or fact to your long-term memory. Use this when the user explicitly asks you to remember something, or when they state a clear, concise fact that seems important to retain for future interactions.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      fact: {
        type: 'string',
        description:
          'The specific fact or piece of information to remember. Should be a clear, self-contained statement.',
      },
      scope: {
        type: 'string',
        description:
          'Where to save the memory: "global" saves to user-level ~/.qwen/LLAMA.md (shared across all projects), "project" saves to current project\'s LLAMA.md (project-specific). If not specified, will prompt user to choose.',
        enum: ['global', 'project'],
      },
    },
    required: ['fact'],
  },
};

const memoryToolDescription = `
Saves a specific piece of information or fact to your long-term memory.

Use this tool:

- When the user explicitly asks you to remember something (e.g., "Remember that I like pineapple on pizza", "Please save this: my cat's name is Whiskers").
- When the user states a clear, concise fact about themselves, their preferences, or their environment that seems important for you to retain for future interactions to provide a more personalized and effective assistance.

Do NOT use this tool:

- To remember conversational context that is only relevant for the current session.
- To save long, complex, or rambling pieces of text. The fact should be relatively short and to the point.
- If you are unsure whether the information is a fact worth remembering long-term. If in doubt, you can ask the user, "Should I remember that for you?"

## Parameters

- \`fact\` (string, required): The specific fact or piece of information to remember. This should be a clear, self-contained statement. For example, if the user says "My favorite color is blue", the fact would be "My favorite color is blue".
- \`scope\` (string, optional): Where to save the memory:
  - "global": Saves to user-level ~/.qwen/LLAMA.md (shared across all projects)
  - "project": Saves to current project's LLAMA.md (project-specific)
  - If not specified, the tool will ask the user where they want to save the memory.
`;

export const GEMINI_CONFIG_DIR = '.qwen';
export const DEFAULT_CONTEXT_FILENAME = 'LLAMA.md';
export const MEMORY_SECTION_HEADER = '## Qwen Added Memories';

// This variable will hold the currently configured filename for LLAMA.md context files.
// It defaults to DEFAULT_CONTEXT_FILENAME but can be overridden by setGeminiMdFilename.
let currentGeminiMdFilename: string | string[] = DEFAULT_CONTEXT_FILENAME;

export function setGeminiMdFilename(newFilename: string | string[]): void {
  if (Array.isArray(newFilename)) {
    if (newFilename.length > 0) {
      currentGeminiMdFilename = newFilename.map((name) => name.trim());
    }
  } else if (newFilename && newFilename.trim() !== '') {
    currentGeminiMdFilename = newFilename.trim();
  }
}

export function getCurrentGeminiMdFilename(): string {
  if (Array.isArray(currentGeminiMdFilename)) {
    return currentGeminiMdFilename[0];
  }
  return currentGeminiMdFilename;
}

export function getAllGeminiMdFilenames(): string[] {
  if (Array.isArray(currentGeminiMdFilename)) {
    return currentGeminiMdFilename;
  }
  return [currentGeminiMdFilename];
}

interface SaveMemoryParams {
  fact: string;
  modified_by_user?: boolean;
  modified_content?: string;
  scope?: 'global' | 'project';
}

function getGlobalMemoryFilePath(): string {
  return path.join(homedir(), GEMINI_CONFIG_DIR, getCurrentGeminiMdFilename());
}

function getProjectMemoryFilePath(): string {
  return path.join(process.cwd(), getCurrentGeminiMdFilename());
}

function getMemoryFilePath(scope: 'global' | 'project' = 'global'): string {
  return scope === 'project'
    ? getProjectMemoryFilePath()
    : getGlobalMemoryFilePath();
}

/**
 * Ensures proper newline separation before appending content.
 */
function ensureNewlineSeparation(currentContent: string): string {
  if (currentContent.length === 0) return '';
  if (currentContent.endsWith('\n\n') || currentContent.endsWith('\r\n\r\n'))
    return '';
  if (currentContent.endsWith('\n') || currentContent.endsWith('\r\n'))
    return '\n';
  return '\n\n';
}

/**
 * Reads the current content of the memory file
 */
async function readMemoryFileContent(
  scope: 'global' | 'project' = 'global',
): Promise<string> {
  try {
    return await fs.readFile(getMemoryFilePath(scope), 'utf-8');
  } catch (err) {
    const error = err as Error & { code?: string };
    if (!(error instanceof Error) || error.code !== 'ENOENT') throw err;
    return '';
  }
}

/**
 * Computes the new content that would result from adding a memory entry
 */
function computeNewContent(currentContent: string, fact: string): string {
  let processedText = fact.trim();
  processedText = processedText.replace(/^(-+\s*)+/, '').trim();
  const newMemoryItem = `- ${processedText}`;

  const headerIndex = currentContent.indexOf(MEMORY_SECTION_HEADER);

  if (headerIndex === -1) {
    // Header not found, append header and then the entry
    const separator = ensureNewlineSeparation(currentContent);
    return (
      currentContent +
      `${separator}${MEMORY_SECTION_HEADER}\n${newMemoryItem}\n`
    );
  } else {
    // Header found, find where to insert the new memory entry
    const startOfSectionContent = headerIndex + MEMORY_SECTION_HEADER.length;
    let endOfSectionIndex = currentContent.indexOf(
      '\n## ',
      startOfSectionContent,
    );
    if (endOfSectionIndex === -1) {
      endOfSectionIndex = currentContent.length; // End of file
    }

    const beforeSectionMarker = currentContent
      .substring(0, startOfSectionContent)
      .trimEnd();
    let sectionContent = currentContent
      .substring(startOfSectionContent, endOfSectionIndex)
      .trimEnd();
    const afterSectionMarker = currentContent.substring(endOfSectionIndex);

    sectionContent += `\n${newMemoryItem}`;
    return (
      `${beforeSectionMarker}\n${sectionContent.trimStart()}\n${afterSectionMarker}`.trimEnd() +
      '\n'
    );
  }
}

class MemoryToolInvocation extends BaseToolInvocation<
  SaveMemoryParams,
  ToolResult
> {
  private static readonly allowlist: Set<string> = new Set();

  getDescription(): string {
    const scope = this.params.scope || 'global';
    const memoryFilePath = getMemoryFilePath(scope);
    return `${tildeifyPath(memoryFilePath)} (${scope})`;
  }

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolEditConfirmationDetails | false> {
    // If scope is not specified, prompt the user to choose
    if (!this.params.scope) {
      const globalPath = tildeifyPath(getMemoryFilePath('global'));
      const projectPath = tildeifyPath(getMemoryFilePath('project'));

      const confirmationDetails: ToolEditConfirmationDetails = {
        type: 'edit',
        title: `Choose Memory Storage Location`,
        fileName: 'Memory Storage Options',
        filePath: '',
        fileDiff: `Choose where to save this memory:\n\n"${this.params.fact}"\n\nOptions:\n- Global: ${globalPath} (shared across all projects)\n- Project: ${projectPath} (current project only)\n\nPlease specify the scope parameter: "global" or "project"`,
        originalContent: '',
        newContent: `Memory to save: ${this.params.fact}\n\nScope options:\n- global: ${globalPath}\n- project: ${projectPath}`,
        onConfirm: async (_outcome: ToolConfirmationOutcome) => {
          // This will be handled by the execution flow
        },
      };
      return confirmationDetails;
    }

    const scope = this.params.scope;
    const memoryFilePath = getMemoryFilePath(scope);
    const allowlistKey = `${memoryFilePath}_${scope}`;

    if (MemoryToolInvocation.allowlist.has(allowlistKey)) {
      return false;
    }

    // Read current content of the memory file
    const currentContent = await readMemoryFileContent(scope);

    // Calculate the new content that will be written to the memory file
    const newContent = computeNewContent(currentContent, this.params.fact);

    const fileName = path.basename(memoryFilePath);
    const fileDiff = Diff.createPatch(
      fileName,
      currentContent,
      newContent,
      'Current',
      'Proposed',
      DEFAULT_DIFF_OPTIONS,
    );

    const confirmationDetails: ToolEditConfirmationDetails = {
      type: 'edit',
      title: `Confirm Memory Save: ${tildeifyPath(memoryFilePath)} (${scope})`,
      fileName: memoryFilePath,
      filePath: memoryFilePath,
      fileDiff,
      originalContent: currentContent,
      newContent,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          MemoryToolInvocation.allowlist.add(allowlistKey);
        }
      },
    };
    return confirmationDetails;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const { fact, modified_by_user, modified_content } = this.params;

    if (!fact || typeof fact !== 'string' || fact.trim() === '') {
      const errorMessage = 'Parameter "fact" must be a non-empty string.';
      return {
        llmContent: JSON.stringify({ success: false, error: errorMessage }),
        returnDisplay: `Error: ${errorMessage}`,
      };
    }

    // If scope is not specified, prompt the user to choose
    if (!this.params.scope) {
      const errorMessage =
        'Please specify where to save this memory. Use scope parameter: "global" for user-level (~/.qwen/LLAMA.md) or "project" for current project (./LLAMA.md).';
      return {
        llmContent: JSON.stringify({ success: false, error: errorMessage }),
        returnDisplay: `${errorMessage}\n\nGlobal: ${tildeifyPath(getMemoryFilePath('global'))}\nProject: ${tildeifyPath(getMemoryFilePath('project'))}`,
      };
    }

    const scope = this.params.scope;
    const memoryFilePath = getMemoryFilePath(scope);

    try {
      if (modified_by_user && modified_content !== undefined) {
        // User modified the content in external editor, write it directly
        await fs.mkdir(path.dirname(memoryFilePath), {
          recursive: true,
        });
        await fs.writeFile(memoryFilePath, modified_content, 'utf-8');
        const successMessage = `Okay, I've updated the ${scope} memory file with your modifications.`;
        return {
          llmContent: JSON.stringify({
            success: true,
            message: successMessage,
          }),
          returnDisplay: successMessage,
        };
      } else {
        // Use the normal memory entry logic
        await MemoryTool.performAddMemoryEntry(fact, memoryFilePath, {
          readFile: fs.readFile,
          writeFile: fs.writeFile,
          mkdir: fs.mkdir,
        });
        const successMessage = `Okay, I've remembered that in ${scope} memory: "${fact}"`;
        return {
          llmContent: JSON.stringify({
            success: true,
            message: successMessage,
          }),
          returnDisplay: successMessage,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        `[MemoryTool] Error executing save_memory for fact "${fact}" in ${scope}: ${errorMessage}`,
      );
      return {
        llmContent: JSON.stringify({
          success: false,
          error: `Failed to save memory. Detail: ${errorMessage}`,
        }),
        returnDisplay: `Error saving memory: ${errorMessage}`,
      };
    }
  }
}

export class MemoryTool
  extends BaseDeclarativeTool<SaveMemoryParams, ToolResult>
  implements ModifiableDeclarativeTool<SaveMemoryParams>
{
  static readonly Name: string = memoryToolSchemaData.name!;
  constructor() {
    super(
      MemoryTool.Name,
      'Save Memory',
      memoryToolDescription,
      Kind.Think,
      memoryToolSchemaData.parametersJsonSchema as Record<string, unknown>,
    );
  }

  override validateToolParams(params: SaveMemoryParams): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parametersJsonSchema,
      params,
    );
    if (errors) {
      return errors;
    }

    if (params.fact.trim() === '') {
      return 'Parameter "fact" must be a non-empty string.';
    }

    return null;
  }

  protected createInvocation(params: SaveMemoryParams) {
    return new MemoryToolInvocation(params);
  }

  static async performAddMemoryEntry(
    text: string,
    memoryFilePath: string,
    fsAdapter: {
      readFile: (path: string, encoding: 'utf-8') => Promise<string>;
      writeFile: (
        path: string,
        data: string,
        encoding: 'utf-8',
      ) => Promise<void>;
      mkdir: (
        path: string,
        options: { recursive: boolean },
      ) => Promise<string | undefined>;
    },
  ): Promise<void> {
    let processedText = text.trim();
    // Remove leading hyphens and spaces that might be misinterpreted as markdown list items
    processedText = processedText.replace(/^(-+\s*)+/, '').trim();
    const newMemoryItem = `- ${processedText}`;

    try {
      await fsAdapter.mkdir(path.dirname(memoryFilePath), { recursive: true });
      let content = '';
      try {
        content = await fsAdapter.readFile(memoryFilePath, 'utf-8');
      } catch (_e) {
        // File doesn't exist, will be created with header and item.
      }

      const headerIndex = content.indexOf(MEMORY_SECTION_HEADER);

      if (headerIndex === -1) {
        // Header not found, append header and then the entry
        const separator = ensureNewlineSeparation(content);
        content += `${separator}${MEMORY_SECTION_HEADER}\n${newMemoryItem}\n`;
      } else {
        // Header found, find where to insert the new memory entry
        const startOfSectionContent =
          headerIndex + MEMORY_SECTION_HEADER.length;
        let endOfSectionIndex = content.indexOf('\n## ', startOfSectionContent);
        if (endOfSectionIndex === -1) {
          endOfSectionIndex = content.length; // End of file
        }

        const beforeSectionMarker = content
          .substring(0, startOfSectionContent)
          .trimEnd();
        let sectionContent = content
          .substring(startOfSectionContent, endOfSectionIndex)
          .trimEnd();
        const afterSectionMarker = content.substring(endOfSectionIndex);

        sectionContent += `\n${newMemoryItem}`;
        content =
          `${beforeSectionMarker}\n${sectionContent.trimStart()}\n${afterSectionMarker}`.trimEnd() +
          '\n';
      }
      await fsAdapter.writeFile(memoryFilePath, content, 'utf-8');
    } catch (error) {
      console.error(
        `[MemoryTool] Error adding memory entry to ${memoryFilePath}:`,
        error,
      );
      throw new Error(
        `[MemoryTool] Failed to add memory entry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  getModifyContext(_abortSignal: AbortSignal): ModifyContext<SaveMemoryParams> {
    return {
      getFilePath: (params: SaveMemoryParams) =>
        getMemoryFilePath(params.scope || 'global'),
      getCurrentContent: async (params: SaveMemoryParams): Promise<string> =>
        readMemoryFileContent(params.scope || 'global'),
      getProposedContent: async (params: SaveMemoryParams): Promise<string> => {
        const scope = params.scope || 'global';
        const currentContent = await readMemoryFileContent(scope);
        return computeNewContent(currentContent, params.fact);
      },
      createUpdatedParams: (
        _oldContent: string,
        modifiedProposedContent: string,
        originalParams: SaveMemoryParams,
      ): SaveMemoryParams => ({
        ...originalParams,
        modified_by_user: true,
        modified_content: modifiedProposedContent,
      }),
    };
  }
}
