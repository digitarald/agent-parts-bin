import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// Replaced at build time with the version in plugin.json, so the MCP handshake
// always reports the shipped release.
declare const __PLUGIN_VERSION__: string;

export const MAX_JSON_LENGTH = 1_048_576;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';
type JsonError = { code: 'INVALID_JSON'; message: string };
type PointerError = { code: 'INVALID_POINTER' | 'NOT_FOUND'; message: string };

export type ValidationResult =
  | { valid: true; type: JsonType }
  | { valid: false; error: JsonError };

export type LookupResult =
  | { found: true; value: JsonValue }
  | { found: false; error: JsonError | PointerError };

const JSON_LIMIT_MESSAGE = 'JSON input exceeds the maximum of 1,048,576 characters (UTF-16 code units).';
const JSON_PARSE_MESSAGE = 'JSON input is not valid JSON.';
const JSON_NUMBER_RANGE_MESSAGE = 'Unsupported numeric range: JSON numbers must decode to finite JavaScript numbers.';
const NOT_FOUND_MESSAGE = 'JSON Pointer does not resolve to an existing value.';

function hasNonFiniteNumber(value: JsonValue): boolean {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'number' && !Number.isFinite(current)) return true;
    if (current !== null && typeof current === 'object') {
      for (const child of Object.values(current)) pending.push(child);
    }
  }
  return false;
}

function parseJson(json: string):
  | { ok: true; value: JsonValue }
  | { ok: false; error: JsonError } {
  if (typeof json !== 'string') {
    return { ok: false, error: { code: 'INVALID_JSON', message: 'JSON input must be a string.' } };
  }
  if (json.length > MAX_JSON_LENGTH) {
    return { ok: false, error: { code: 'INVALID_JSON', message: JSON_LIMIT_MESSAGE } };
  }
  let value: JsonValue;
  try {
    value = JSON.parse(json) as JsonValue;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Native parser messages can include the submitted JSON.
    return { ok: false, error: { code: 'INVALID_JSON', message: JSON_PARSE_MESSAGE } };
  }
  if (hasNonFiniteNumber(value)) {
    return { ok: false, error: { code: 'INVALID_JSON', message: JSON_NUMBER_RANGE_MESSAGE } };
  }
  return { ok: true, value };
}

/** Validate bounded JSON with finite decoded numbers, without echoing input in errors. */
export function validateJson(json: string): ValidationResult {
  const parsed = parseJson(json);
  if (!parsed.ok) return { valid: false, error: parsed.error };

  const value = parsed.value;
  const type: JsonType = value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value as Exclude<JsonType, 'null' | 'array'>;
  return { valid: true, type };
}

/**
 * Resolve the string form of an RFC 6901 JSON Pointer (not a URI fragment).
 * Malformed/oversized JSON or non-finite decoded numbers are INVALID_JSON; bad syntax is INVALID_POINTER;
 * missing members and traversal through primitives are NOT_FOUND.
 */
export function getJsonValue(json: string, pointer: string): LookupResult {
  const parsed = parseJson(json);
  if (!parsed.ok) return { found: false, error: parsed.error };

  if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/'))) {
    return {
      found: false,
      error: { code: 'INVALID_POINTER', message: 'JSON Pointer must be empty or begin with "/".' }
    };
  }
  if (/~(?:[^01]|$)/u.test(pointer)) {
    return {
      found: false,
      error: { code: 'INVALID_POINTER', message: 'JSON Pointer only permits the escapes ~0 and ~1.' }
    };
  }
  if (pointer === '') return { found: true, value: parsed.value };

  let value = parsed.value;
  for (const encoded of pointer.slice(1).split('/')) {
    // Decode in this order so ~01 becomes ~1, not /.
    const token = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/u.test(token)) {
      return {
        found: false,
        error: {
          code: 'INVALID_POINTER',
          message: 'Array indices must be non-negative integers without leading zeros; "-" is not supported.'
        }
      };
    }
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, token)) {
      return { found: false, error: { code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE } };
    }
    value = Array.isArray(value)
      ? value[Number(token)] as JsonValue
      : value[token] as JsonValue;
  }
  return { found: true, value };
}

function toolResult(result: ValidationResult | LookupResult): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result
  };
}

const jsonInput = z.string()
  .max(MAX_JSON_LENGTH, JSON_LIMIT_MESSAGE)
  .describe('JSON text, at most 1,048,576 characters measured in UTF-16 code units.');

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

const toolDefinitions = [
  {
    name: 'validate_json',
    register(server: McpServer) {
      server.registerTool(this.name, {
        title: 'Validate JSON',
        description: 'Validate supplied JSON without files, network, or persistence. Returns '
          + '{valid:true,type} or {valid:false,error:{code:"INVALID_JSON",message}}. '
          + 'Types are object, array, string, number, boolean, and null. '
          + 'Every number in the document must decode to a finite JavaScript number; unsupported numeric ranges return INVALID_JSON. '
          + 'The input schema rejects non-string or oversized arguments (maximum 1,048,576 UTF-16 code units). '
          + 'Errors never echo the JSON text.',
        inputSchema: { json: jsonInput },
        annotations
      }, ({ json }) => toolResult(validateJson(json)));
    }
  },
  {
    name: 'get_json_value',
    register(server: McpServer) {
      server.registerTool(this.name, {
        title: 'Get JSON value',
        description: 'Read a value from supplied JSON with an RFC 6901 JSON Pointer. '
          + 'An empty pointer returns the root; ~0 escapes ~ and ~1 escapes /. '
          + 'Returns {found:true,value} (including null) or {found:false,error:{code,message}}. '
          + 'Error codes: INVALID_JSON, INVALID_POINTER, NOT_FOUND. '
          + 'Every number in the document must decode to a finite JavaScript number; unsupported numeric ranges return INVALID_JSON. '
          + 'Array indices must have no leading zeros; "-" is invalid. Only own object members are read. '
          + 'The input schema rejects non-string or oversized arguments (maximum JSON length: 1,048,576 UTF-16 code units). '
          + 'No files, network, persistence, or input text in errors.',
        inputSchema: {
          json: jsonInput,
          pointer: z.string().describe('RFC 6901 string pointer: empty for the root, otherwise starting with /.')
        },
        annotations
      }, ({ json, pointer }) => toolResult(getJsonValue(json, pointer)));
    }
  }
] as const;

export const TOOL_NAMES = Object.freeze(toolDefinitions.map(tool => tool.name));

export function createServer(): McpServer {
  const server = new McpServer({ name: 'json-configuration', version: __PLUGIN_VERSION__ });
  for (const tool of toolDefinitions) tool.register(server);
  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await server.close();
    throw error;
  }
}

// URL decoding and path comparison handle relocated paths, spaces, and Windows drive-letter casing.
// Node resolves the module URL through symlinks but not argv, so compare real paths (macOS /var -> /private/var).
const realPath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const entrypoint = process.argv[1];
if (entrypoint && relative(realPath(entrypoint), realPath(fileURLToPath(import.meta.url))) === '') {
  main().catch(error => {
    console.error('Failed to start the JSON configuration MCP server:', error);
    process.exitCode = 1;
  });
}
