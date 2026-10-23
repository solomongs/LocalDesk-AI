# Native IPC and local agent API

The production UI uses only Tauri commands. Browsers/PWAs cannot invoke them. Argument keys and serialized object keys are camelCase; command names are snake_case.

## Commands

| Command | Input | Output |
| --- | --- | --- |
| `get_system_status` | none | `SystemStatus` |
| `get_native_status` | `{engine}` | `{engine,connected,endpoint,version,error}` |
| `native_list_models` | `{engine}` | `NativeModel[]` |
| `native_chat` | `{requestId,engine,model,messages,temperature?,maxTokens?}` | `{content,model}`; also streams events |
| `native_cancel` | `{requestId}` | whether an active request was cancelled |
| `pull_ollama_model` | `{model}` | resolves after verified Ollama success; streams progress |
| `cancel_ollama_pull` | `{model}` | whether an active download was cancelled |
| `delete_ollama_model` | `{model}` | void |
| `start_ollama` | none | user-facing result string |
| `llmfit_status` | none | `{installed,path,installUrl}` |
| `get_fit_recommendations` | `{useCase?}` | `{available,source:'llmfit',recommendations,error?}` |
| `get_bridge_status` | none | `BridgeStatus` |
| `set_bridge_enabled` | `{enabled,engine}` | `BridgeStatus` |
| `list_conversations` | none | full `Conversation[]` newest first, maximum 500 |
| `save_conversation` | `{conversation}` | void |
| `delete_conversation` | `{id}` | void |
| `get_setting` | `{key}` | JSON value or null |
| `set_setting` | `{key,value}` | void |
| `mcp_list_tools` | `{server,confirmed:true}` | MCP `tools/list` result |
| `mcp_call_tool` | `{server,name,arguments,confirmed:true}` | MCP `tools/call` result |

`engine` is `ollama` or `llamacpp`. These map to fixed `http://127.0.0.1:11434` and `http://127.0.0.1:8080`; arbitrary model-engine URLs are intentionally not accepted.

`Conversation` is `{id,title,messages,updatedAt}` where updatedAt is milliseconds since Unix epoch. Message shape is `{role,content,...metadata}`. Metadata such as id and createdAt survives storage; only role and content are forwarded by the first-party chat UI.

`NativeModel` is `{id,name,sizeBytes,size,parameterSize,quantization,family,modifiedAt}`. Fields not supplied by the engine are null. `size` is a compatibility alias of `sizeBytes`.

`SystemStatus` is `{os,arch,cpuName,cpuCores,totalMemoryBytes,availableMemoryBytes,totalDiskBytes,freeDiskBytes,gpus,ollamaInstalled,llmfitInstalled}`. GPU entries are `{name,totalMemoryBytes,freeMemoryBytes,source}`. RAM and disk values are measured bytes; Windows display-driver GPU values can be estimates. No GPU found is an empty list, not a claim that no accelerator exists. llmfit output is the installed tool's actual JSON; never present its estimates as measured inference benchmarks.

`BridgeStatus` is `{enabled,host,port,baseUrl,mcpUrl,token,engine,error}`. Token is sensitive and is available only to the trusted native UI to copy into an external editor; never log, upload, place in a URL, or render it automatically. The bridge is off at every app startup. Enabling it affects only loopback.

## Events

`native-chat-chunk`: `{requestId,content,done,error}`. Content is an incremental delta. A final event has empty content, done true, and optional error. Cancellation also rejects the invocation so callers can retain any partial response.

`model-download-progress`: `{model,status,completed,total,percent}`. Ollama reports individual layers, so percent is layer-local when available; null indicates a non-byte phase. Success emits 100. A resolved invocation confirms completion; error status does not mean success.

## External coding agents

Enable **Local agent access** in the native UI, select the intended native engine, then configure the external agent's OpenAI provider with `http://127.0.0.1:11435/v1` and the copied token as its API key. `GET /v1/models` lists installed model IDs. `POST /v1/chat/completions` preserves the agent's OpenAI payload including tool calls and streams the upstream result. It supports four concurrent generation requests and binds only to IPv4 loopback.

The same token authorizes Streamable HTTP MCP at `http://127.0.0.1:11435/mcp`. It provides `list_models`, `system_status`, and `chat`. It does not expose arbitrary files or commands. The local model's ability to follow coding/tool instructions depends on the selected model.

All HTTP bridge requests require `Authorization: Bearer <token>` and a loopback Host header. Browser Origin requests are rejected. There is no CORS wildcard, LAN listener, or unauthenticated API.

## Imported MCP configurations

Server shape: `{name,transport:'stdio'|'streamable-http',command?,args?,env?,url?,headers?}`. `http` is accepted as an alias. Extra UI metadata is ignored. Legacy `sse` returns an explicit unsupported message.

Importing configuration never starts a process. The UI must explain the command/server and obtain the user's confirmation before each `confirmed:true` invocation. Stdio commands use separate executable/argument values with no shell interpolation. Use a real executable such as `node.exe`; shell command strings and `.cmd` wrappers are not expanded. A tool server can perform actions with the user's privileges, so only connect to trusted servers. Secret placeholders must be explicitly filled before connection.

HTTP MCP requires HTTPS except for localhost/loopback HTTP. Initialization negotiates protocol 2025-03-26, session IDs are reused for a single operation, and sessions are closed afterward. OAuth browser sign-in is not implemented; configured bearer headers work. Request/result size limits and process timeouts apply. MCP process stderr is not displayed or logged because it may contain secrets.

## Native security boundaries

- SQLite is under the per-user Tauri application-data directory, with a stable random per-install agent token. SQLite statements bind input values.
- No editor, general shell command, filesystem browser, or arbitrary engine URL command is exposed.
- Model-engine requests do not follow redirects or use configured HTTP proxies.
- The only non-MCP process launches are fixed Ollama serve, nvidia-smi hardware inspection, the Windows display-controller query, and a fixed llmfit recommendation command.
- Automatic updates require the configured Tauri release public key. A build with no configured key must not claim that signed updates are functional.
