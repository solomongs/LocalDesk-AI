export interface ImportedMcpServer {
  name: string;
  transport: 'stdio' | 'streamable-http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled: false;
  source: 'Claude/Cursor' | 'VS Code' | 'OpenCode' | 'Generic';
  requiredSecretKeys: string[];
  notes: string[];
}

export interface McpImportResult { servers: ImportedMcpServer[]; warnings: string[] }
const dangerousNames = new Set(['__proto__', 'constructor', 'prototype']);
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(v => typeof v === 'string'); }
function placeholder(value: string): boolean { return /^\$\{(?:env|input):[A-Za-z_][A-Za-z0-9_.-]*\}$/.test(value); }
const secretFlag = /^--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|secret|password|passwd|authorization|auth|credential|credentials|client[-_]?secret|key)$/i;
const credentialText = /(?:\b(?:authorization|proxy-authorization|x-api-key)\s*:|\bbearer\s+\S|\b(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|CLIENT_SECRET)\s*=|\b(?:ghp_|github_pat_|sk-[A-Za-z0-9]))/i;

function credentialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password || Array.from(url.searchParams.keys()).some(key => /token|key|secret|auth|password|signature/i.test(key)));
  } catch { return false; }
}

function sanitizeCommandArgs(input: string[], required: string[], notes: string[]): string[] {
  const args = [...input];
  const redact = (index: number) => {
    if (placeholder(args[index])) return;
    args[index] = `\${input:CLI_SECRET_${index}}`;
    required.push(`args.${index}`);
    notes.push(`A credential-bearing argument at position ${index + 1} was removed. Enter it explicitly before connecting.`);
  };
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    const separator = value.indexOf('=');
    if (separator > 0 && secretFlag.test(value.slice(0, separator))) {
      const key = value.slice(0, separator);
      args[index] = `${key}=\${input:CLI_SECRET_${index}}`;
      required.push(`args.${index}`);
      notes.push(`A credential-bearing argument (${key}) was removed. Enter it explicitly before connecting.`);
    } else if (secretFlag.test(value) && index + 1 < args.length) {
      redact(++index);
    } else if (credentialText.test(value) || credentialUrl(value) || /--?(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|secret)\s+\S/i.test(value)) {
      redact(index);
    }
  }
  return args;
}

/** Parse and normalize configuration only. Importing never starts commands, contacts servers, or resolves secrets. */
export function importMcpConfig(text: string): McpImportResult {
  if (text.length > 1024 * 1024) throw new Error('MCP configuration is too large. Import a JSON file smaller than 1 MB.');
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new Error('This is not valid JSON. Export the MCP configuration as JSON and try again.'); }
  if (!object(input)) throw new Error('MCP configuration must be a JSON object.');
  let source: ImportedMcpServer['source'] = 'Generic';
  let entries: Record<string, unknown>;
  if (object(input.mcpServers)) { entries = input.mcpServers; source = 'Claude/Cursor'; }
  else if (object(input.servers)) { entries = input.servers; source = 'VS Code'; }
  else if (object(input.mcp)) { entries = input.mcp; source = 'OpenCode'; }
  else throw new Error('No MCP servers found. Supported JSON containers are mcpServers, servers, and mcp.');
  if (Object.keys(entries).length > 100) throw new Error('Import at most 100 MCP profiles at a time.');
  const servers: ImportedMcpServer[] = [];
  const warnings: string[] = [];
  for (const [name, value] of Object.entries(entries)) {
    if (dangerousNames.has(name) || !name.trim() || name.length > 120 || !object(value)) { warnings.push(`Skipped an invalid server entry: ${name.slice(0, 120)}`); continue; }
    const secretKeys: string[] = [];
    const notes: string[] = [];
    const cleaned = (candidate: unknown, location: 'env' | 'headers'): Record<string, string> | undefined => {
      if (!object(candidate)) return undefined;
      const result: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [key, raw] of Object.entries(candidate)) {
        if (dangerousNames.has(key) || typeof raw !== 'string' || key.length > 200) continue;
        if (placeholder(raw)) { result[key] = raw; notes.push(`${location}.${key} requires explicit variable resolution before connecting.`); }
        else { secretKeys.push(`${location}.${key}`); notes.push(`${location}.${key} was removed from the import. Enter it explicitly if this server requires it.`); }
      }
      return Object.keys(result).length ? result : undefined;
    };
    const base = { name, enabled: false as const, source, requiredSecretKeys: secretKeys, notes };
    const env = cleaned(value.env ?? value.environment, 'env');
    const headers = cleaned(value.headers, 'headers');
    const url = typeof value.url === 'string' ? value.url : undefined;
    if (url) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { warnings.push(`${name}: invalid server URL.`); continue; }
      if (parsed.username || parsed.password || parsed.hash || !['https:', 'http:'].includes(parsed.protocol)) { warnings.push(`${name}: URL credentials, fragments, and non-HTTP transports are not supported.`); continue; }
      if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) { warnings.push(`${name}: use HTTPS for remote MCP servers.`); continue; }
      for (const key of Array.from(parsed.searchParams.keys())) {
        if (/token|key|secret|auth|password|signature/i.test(key)) {
          parsed.searchParams.delete(key);
          secretKeys.push(`url.${key}`);
          notes.push(`A credential-like URL parameter (${key}) was removed. Configure it explicitly before connecting.`);
        }
      }
      const transport = value.type === 'sse' || value.transport === 'sse' ? 'sse' : 'streamable-http';
      if (transport === 'sse') notes.push('Legacy SSE transport requires migration to Streamable HTTP before connecting.');
      servers.push({ ...base, transport, url: parsed.toString(), env, headers });
      continue;
    }
    const rawCommand = value.command;
    const command = typeof rawCommand === 'string' ? rawCommand : strings(rawCommand) ? rawCommand[0] : undefined;
    const originalArgs = strings(rawCommand) ? rawCommand.slice(1) : strings(value.args) ? value.args : [];
    const args = sanitizeCommandArgs(originalArgs, secretKeys, notes);
    if (!command || command.length > 2000 || /[\r\n\0]/.test(command) || args.length > 100 || args.some(arg => arg.length > 10000 || arg.includes('\0'))) { warnings.push(`${name}: invalid or missing command.`); continue; }
    if (credentialText.test(command) || credentialUrl(command) || /--?(?:api[-_]?key|token|password|secret)\s+\S/i.test(command)) { warnings.push(`${name}: move credentials out of the command field before importing.`); continue; }
    notes.push('A local MCP server can access your computer with your user permissions. Review the command before connecting.');
    servers.push({ ...base, transport: 'stdio', command, args, env, headers });
  }
  if (!servers.length) throw new Error(warnings.join(' ') || 'No supported MCP server entries were found.');
  return { servers, warnings };
}

export function hasUnresolvedMcpVariables(server: ImportedMcpServer): boolean {
  return [server.command ?? '', server.url ?? '', ...(server.args ?? []), ...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})].some(value => {
    try { return /\$\{[^}]+\}/.test(decodeURIComponent(value)); } catch { return /\$\{[^}]+\}/.test(value); }
  });
}

export interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown> }

export async function listMcpTools(server: ImportedMcpServer, confirmed: boolean): Promise<unknown> {
  if (!confirmed) throw new Error('Review and confirm the MCP server before connecting.');
  if (hasUnresolvedMcpVariables(server)) throw new Error('Resolve imported environment or input variables before connecting.');
  if (server.transport === 'sse') throw new Error('Use a Streamable HTTP server URL; legacy SSE is not supported.');
  const { nativeTransport } = await import('./native');
  return nativeTransport.invoke('mcp_list_tools', { server, confirmed: true });
}

export async function callMcpTool(server: ImportedMcpServer, name: string, args: Record<string, unknown>, confirmed: boolean): Promise<unknown> {
  if (!confirmed) throw new Error('Review and confirm this MCP tool call before running it.');
  if (hasUnresolvedMcpVariables(server)) throw new Error('Resolve imported variables before running this tool.');
  if (!name || name.length > 200) throw new Error('Choose a valid MCP tool.');
  const { nativeTransport } = await import('./native');
  return nativeTransport.invoke('mcp_call_tool', { server, name, arguments: args, confirmed: true });
}
