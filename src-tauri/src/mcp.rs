use crate::state::AppState;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

const MAX_MESSAGE: usize = 4 * 1024 * 1024;
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub url: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}
fn validate(server: &McpServer, confirmed: bool) -> Result<(), String> {
    if !confirmed {
        return Err(
            "Confirm this MCP connection before running its process or contacting its server."
                .into(),
        );
    }
    if server.name.is_empty() || server.name.len() > 120 {
        return Err("Invalid MCP server name.".into());
    }
    if server.args.len() > 100
        || server
            .args
            .iter()
            .any(|a| a.len() > 8192 || a.contains('\0'))
    {
        return Err("MCP command arguments are too large or invalid.".into());
    }
    if server.env.len() > 100 || server.headers.len() > 100 {
        return Err("MCP configuration is too large.".into());
    }
    for (name, value) in server.env.iter().chain(server.headers.iter()) {
        if name.is_empty()
            || name.len() > 200
            || value.len() > 8192
            || name.contains('\0')
            || value.contains('\0')
        {
            return Err("Invalid MCP environment or header entry.".into());
        }
        if value.contains("${") || value.contains("{{") {
            return Err(format!("Set a value for {name} before connecting. Imported secret placeholders are not executed."));
        }
    }
    Ok(())
}

pub async fn list_tools(
    state: AppState,
    server: McpServer,
    confirmed: bool,
) -> Result<Value, String> {
    execute(state, server, confirmed, "tools/list", json!({})).await
}
pub async fn call_tool(
    state: AppState,
    server: McpServer,
    name: String,
    arguments: Value,
    confirmed: bool,
) -> Result<Value, String> {
    if name.is_empty() || name.len() > 200 || !arguments.is_object() {
        return Err("Provide a tool name and a JSON object of arguments.".into());
    }
    execute(
        state,
        server,
        confirmed,
        "tools/call",
        json!({"name":name,"arguments":arguments}),
    )
    .await
}
async fn execute(
    state: AppState,
    server: McpServer,
    confirmed: bool,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    validate(&server, confirmed)?;
    if serde_json::to_vec(&params)
        .map_err(|_| "Invalid tool arguments.")?
        .len()
        > MAX_MESSAGE
    {
        return Err("Tool arguments are too large.".into());
    }
    match server.transport.as_str(){
  "stdio"=>tokio::time::timeout(Duration::from_secs(120),stdio(server,method,params)).await.map_err(|_|"The MCP tool timed out after 120 seconds.".to_string())?,
  "http"|"streamable-http"=>http(state,server,method,params).await,
  "sse"=>Err("Legacy SSE MCP transport is not supported. Import the server's Streamable HTTP endpoint instead.".into()),
  _=>Err("Unsupported MCP transport.".into())
 }
}
async fn json_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Value, String> {
    let mut output = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|_| "Could not read the MCP process response.".to_string())?;
        if available.is_empty() {
            return Err("The MCP process exited before responding.".into());
        }
        let count = available
            .iter()
            .position(|b| *b == b'\n')
            .map(|n| n + 1)
            .unwrap_or(available.len());
        if output.len() + count > MAX_MESSAGE {
            return Err("MCP response exceeded the size limit.".into());
        }
        let done = available[count - 1] == b'\n';
        output.extend_from_slice(&available[..count]);
        reader.consume(count);
        if done {
            if output.iter().all(|b| b.is_ascii_whitespace()) {
                output.clear();
                continue;
            }
            return serde_json::from_slice(&output).map_err(|_| {
                "MCP stdout must contain newline-delimited JSON-RPC, not logs.".into()
            });
        }
    }
}
async fn read_id<R: AsyncBufRead + Unpin>(reader: &mut R, id: u64) -> Result<Value, String> {
    for _ in 0..100 {
        let value = json_line(reader).await?;
        if value.get("id").and_then(Value::as_u64) == Some(id) {
            return rpc_result(value);
        }
    }
    Err("The MCP process sent too many unrelated messages.".into())
}
fn rpc_result(value: Value) -> Result<Value, String> {
    if let Some(error) = value.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("MCP server reported an error.")
            .chars()
            .take(400)
            .collect());
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| "MCP response has no result.".into())
}
fn initialization() -> Value {
    json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"LocalDesk AI","version":"0.2.0"}}})
}
async fn stdio(server: McpServer, method: &str, params: Value) -> Result<Value, String> {
    let command = server
        .command
        .as_deref()
        .filter(|v| !v.is_empty() && v.len() < 2000 && !v.contains('\0'))
        .ok_or("Choose the MCP server executable.")?;
    let mut process = Command::new(command);
    process
        .args(&server.args)
        .envs(&server.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    process.creation_flags(0x08000000);
    let mut child=process.spawn().map_err(|_|"Could not start the MCP process. Check its executable and installation. On Windows, use an executable such as node.exe rather than a shell command string.".to_string())?;
    let result = async {
        let mut stdin = child.stdin.take().ok_or("MCP stdin is unavailable.")?;
        let mut stdout = BufReader::new(child.stdout.take().ok_or("MCP stdout is unavailable.")?);
        let mut bytes = serde_json::to_vec(&initialization())
            .map_err(|_| "Could not encode MCP initialization.")?;
        bytes.push(b'\n');
        stdin
            .write_all(&bytes)
            .await
            .map_err(|_| "Could not initialize MCP process.")?;
        stdin
            .flush()
            .await
            .map_err(|_| "Could not flush MCP input.")?;
        read_id(&mut stdout, 1).await?;
        let initialized = json!({"jsonrpc":"2.0","method":"notifications/initialized"});
        let request = json!({"jsonrpc":"2.0","id":2,"method":method,"params":params});
        for message in [initialized, request] {
            let mut bytes =
                serde_json::to_vec(&message).map_err(|_| "Could not encode MCP request.")?;
            bytes.push(b'\n');
            stdin
                .write_all(&bytes)
                .await
                .map_err(|_| "Could not send MCP request.")?;
        }
        stdin
            .flush()
            .await
            .map_err(|_| "Could not flush MCP request.")?;
        read_id(&mut stdout, 2).await
    }
    .await;
    let _ = child.start_kill();
    let _ = child.wait().await;
    result
}
fn endpoint(server: &McpServer) -> Result<url::Url, String> {
    let url = url::Url::parse(server.url.as_deref().ok_or("MCP URL is required.")?)
        .map_err(|_| "Invalid MCP URL.".to_string())?;
    let local = matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    );
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(
            "Use MCP headers for credentials; URL credentials and fragments are not accepted."
                .into(),
        );
    }
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("Remote MCP connections require HTTPS. HTTP is allowed only on your own loopback interface.".into());
    }
    Ok(url)
}
async fn decode_response(response: reqwest::Response, id: u64) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err(format!(
            "MCP server returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    let sse = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.starts_with("text/event-stream"))
        .unwrap_or(false);
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    let mut event = String::new();
    let mut total = 0usize;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "MCP response interrupted.")?;
        total = total.saturating_add(chunk.len());
        if total > MAX_MESSAGE {
            return Err("MCP response exceeded the size limit.".into());
        }
        body.extend_from_slice(&chunk);
        if sse {
            while let Some(index) = body.iter().position(|b| *b == b'\n') {
                let line = body.drain(..=index).collect::<Vec<_>>();
                let line = std::str::from_utf8(&line)
                    .map_err(|_| "MCP server returned invalid text.")?
                    .trim_end_matches(['\r', '\n']);
                if line.is_empty() {
                    if !event.is_empty() {
                        if let Ok(value) = serde_json::from_str::<Value>(event.trim()) {
                            if value.get("id").and_then(Value::as_u64) == Some(id) {
                                return rpc_result(value);
                            }
                        }
                        event.clear();
                    }
                } else if let Some(data) = line.strip_prefix("data:") {
                    event.push_str(data.trim_start());
                    event.push('\n');
                }
            }
        }
    }
    if !sse {
        if let Ok(value) = serde_json::from_slice::<Value>(&body) {
            return rpc_result(value);
        }
    }
    if !event.is_empty() {
        if let Ok(value) = serde_json::from_str::<Value>(event.trim()) {
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                return rpc_result(value);
            }
        }
    }
    Err(
        "The MCP endpoint did not return a JSON-RPC result. Use its Streamable HTTP endpoint."
            .into(),
    )
}
async fn http(
    state: AppState,
    server: McpServer,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let url = endpoint(&server)?;
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/json, text/event-stream"),
    );
    for (name, value) in &server.headers {
        if ["host", "content-length", "connection", "origin"]
            .contains(&name.to_ascii_lowercase().as_str())
        {
            return Err("MCP configuration contains a reserved HTTP header.".into());
        }
        headers.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "Invalid MCP header name.")?,
            reqwest::header::HeaderValue::from_str(value)
                .map_err(|_| "Invalid MCP header value.")?,
        );
    }
    let first = state
        .client
        .post(url.clone())
        .headers(headers.clone())
        .json(&initialization())
        .timeout(Duration::from_secs(45))
        .send()
        .await
        .map_err(|_| "Could not reach the MCP endpoint.".to_string())?;
    let session = first.headers().get("mcp-session-id").cloned();
    decode_response(first, 1).await?;
    if let Some(session) = session.clone() {
        headers.insert("mcp-session-id", session);
    }
    headers.insert(
        "mcp-protocol-version",
        reqwest::header::HeaderValue::from_static("2025-03-26"),
    );
    let notification = state
        .client
        .post(url.clone())
        .headers(headers.clone())
        .json(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "Could not finish MCP initialization.".to_string())?;
    if !notification.status().is_success() {
        return Err("MCP initialization was not accepted.".into());
    }
    let response = state
        .client
        .post(url.clone())
        .headers(headers.clone())
        .json(&json!({"jsonrpc":"2.0","id":2,"method":method,"params":params}))
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|_| "The MCP tool could not be reached or timed out.".to_string())?;
    let result = decode_response(response, 2).await;
    if session.is_some() {
        let _ = state
            .client
            .delete(url)
            .headers(headers)
            .timeout(Duration::from_secs(5))
            .send()
            .await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn server(url: &str) -> McpServer {
        McpServer {
            name: "test".into(),
            transport: "http".into(),
            command: None,
            args: vec![],
            env: HashMap::new(),
            url: Some(url.into()),
            headers: HashMap::new(),
        }
    }
    #[test]
    fn remote_mcp_requires_tls() {
        assert!(endpoint(&server("http://example.com/mcp")).is_err());
        assert!(endpoint(&server("http://127.0.0.1:1234/mcp")).is_ok());
        assert!(endpoint(&server("https://example.com/mcp")).is_ok());
        assert!(endpoint(&server("https://secret@example.com/mcp")).is_err());
    }
    #[test]
    fn confirmations_are_required() {
        assert!(validate(&server("https://example.com"), false).is_err());
    }
    #[tokio::test]
    async fn large_stdio_response_is_rejected() {
        let data = vec![b'a'; MAX_MESSAGE + 1];
        let mut reader = BufReader::new(data.as_slice());
        assert!(json_line(&mut reader).await.is_err());
    }
}
