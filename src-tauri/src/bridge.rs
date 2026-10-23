use crate::{
    native,
    state::AppState,
    types::{ChatMessage, Engine},
};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::{Mutex, RwLock};

pub const PORT: u16 = 11435;
#[derive(Clone)]
pub struct BridgeManager {
    pub inner: Arc<BridgeInner>,
}
pub struct BridgeInner {
    pub enabled: AtomicBool,
    pub engine: RwLock<Engine>,
    pub token: String,
    pub task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub error: RwLock<Option<String>>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub enabled: bool,
    pub host: &'static str,
    pub port: u16,
    pub base_url: String,
    pub mcp_url: String,
    pub token: String,
    pub engine: Engine,
    pub error: Option<String>,
}
impl BridgeManager {
    pub fn new(token: String) -> Self {
        Self {
            inner: Arc::new(BridgeInner {
                enabled: AtomicBool::new(false),
                engine: RwLock::new(Engine::Ollama),
                token,
                task: Mutex::new(None),
                error: RwLock::new(None),
            }),
        }
    }
    pub async fn status(&self) -> BridgeStatus {
        BridgeStatus {
            enabled: self.inner.enabled.load(Ordering::SeqCst),
            host: "127.0.0.1",
            port: PORT,
            base_url: format!("http://127.0.0.1:{PORT}/v1"),
            mcp_url: format!("http://127.0.0.1:{PORT}/mcp"),
            token: self.inner.token.clone(),
            engine: *self.inner.engine.read().await,
            error: self.inner.error.read().await.clone(),
        }
    }
}
pub async fn set_enabled(
    state: AppState,
    enabled: bool,
    engine: Engine,
) -> Result<BridgeStatus, String> {
    let bridge = state.bridge.clone();
    let mut slot = bridge.inner.task.lock().await;
    *bridge.inner.engine.write().await = engine;
    if !enabled {
        bridge.inner.enabled.store(false, Ordering::SeqCst);
        if let Some(task) = slot.take() {
            task.abort();
            let _ = task.await;
        }
        *bridge.inner.error.write().await = None;
        return Ok(bridge.status().await);
    }
    if slot.is_some() && bridge.inner.enabled.load(Ordering::SeqCst) {
        return Ok(bridge.status().await);
    }
    let listener = match tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, PORT)).await
    {
        Ok(listener) => listener,
        Err(_) => {
            let error=format!("Port {PORT} is already in use. Close the other LocalDesk instance or service and retry.");
            *bridge.inner.error.write().await = Some(error.clone());
            return Err(error);
        }
    };
    let router = router(state.clone());
    bridge.inner.enabled.store(true, Ordering::SeqCst);
    *bridge.inner.error.write().await = None;
    let running = bridge.clone();
    *slot = Some(tokio::spawn(async move {
        let result = axum::serve(listener, router).await;
        running.inner.enabled.store(false, Ordering::SeqCst);
        if result.is_err() {
            *running.inner.error.write().await =
                Some("The local agent bridge stopped unexpectedly.".into());
        }
    }));
    Ok(bridge.status().await)
}
fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(chat))
        .route("/mcp", post(mcp))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), authorize))
        .with_state(state)
}
fn token_matches(header: Option<&str>, token: &str) -> bool {
    let Some(candidate) = header.and_then(|h| h.strip_prefix("Bearer ")) else {
        return false;
    };
    if candidate.len() != token.len() {
        return false;
    }
    candidate
        .as_bytes()
        .iter()
        .zip(token.as_bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}
async fn authorize(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if !state.bridge.inner.enabled.load(Ordering::SeqCst) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"Local agent access is disabled."})),
        )
            .into_response();
    }
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if !["127.0.0.1:11435", "localhost:11435"].contains(&host) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"Only loopback Host headers are accepted."})),
        )
            .into_response();
    }
    if request.headers().contains_key(header::ORIGIN) {
        return (
            StatusCode::FORBIDDEN,
            Json(
                json!({"error":"Browser-origin requests are not allowed on this local agent API."}),
            ),
        )
            .into_response();
    }
    if !token_matches(
        request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok()),
        &state.bridge.inner.token,
    ) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"A valid LocalDesk API token is required."})),
        )
            .into_response();
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        header::HeaderValue::from_static("nosniff"),
    );
    response
}
async fn health() -> Json<Value> {
    Json(json!({"status":"ok","application":"LocalDesk AI","version":"0.2.0"}))
}
async fn models(State(state): State<AppState>) -> Response {
    let engine = *state.bridge.inner.engine.read().await;
    match native::models(&state,engine).await{Ok(models)=>Json(json!({"object":"list","data":models.iter().map(|m|json!({"id":m.id,"object":"model","owned_by":"localdesk"})).collect::<Vec<_>>()})).into_response(),Err(error)=>(StatusCode::BAD_GATEWAY,Json(json!({"error":{"message":error,"type":"upstream_unavailable"}}))).into_response()}
}
async fn chat(State(state): State<AppState>, Json(payload): Json<Value>) -> Response {
    let Some(model) = payload.get("model").and_then(Value::as_str) else {
        return bad_request("A model is required.");
    };
    if crate::types::validate_model(model).is_err() {
        return bad_request("Invalid model identifier.");
    }
    let Some(messages) = payload.get("messages").and_then(Value::as_array) else {
        return bad_request("Messages must be an array.");
    };
    if messages.is_empty() || messages.len() > 500 {
        return bad_request("Messages must contain 1–500 entries.");
    }
    // Preserve OpenAI tool-call payloads for coding agents; only the upstream URL is fixed.
    if messages.iter().any(|m| {
        !m.is_object()
            || !matches!(
                m.get("role").and_then(Value::as_str),
                Some("system" | "developer" | "user" | "assistant" | "tool")
            )
    }) {
        return bad_request("Unsupported message role.");
    }
    let permit=match state.bridge_requests.clone().try_acquire_owned(){Ok(permit)=>permit,Err(_)=>return (StatusCode::TOO_MANY_REQUESTS,Json(json!({"error":{"message":"LocalDesk is handling too many requests. Try again shortly."}}))).into_response()};
    let engine = *state.bridge.inner.engine.read().await;
    let response = match state
        .client
        .post(format!("{}/v1/chat/completions", engine.endpoint()))
        .json(&payload)
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error":{"message":"The local AI server is not reachable."}})),
            )
                .into_response()
        }
    };
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| header::HeaderValue::from_static("application/json"));
    let stream = async_stream::stream! {let _permit=permit;let mut bytes=response.bytes_stream();use futures_util::StreamExt;while let Some(chunk)=bytes.next().await{match chunk{Ok(chunk)=>yield Ok::<_,std::io::Error>(chunk),Err(_)=>{yield Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset,"The local AI connection ended."));break;}}}};
    let mut result = Response::new(Body::from_stream(stream));
    *result.status_mut() = status;
    result
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    result
}
fn bad_request(error: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":{"message":error,"type":"invalid_request_error"}})),
    )
        .into_response()
}
fn rpc_error(id: Value, code: i64, message: &str) -> Response {
    Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})).into_response()
}
async fn mcp(State(state): State<AppState>, Json(request): Json<Value>) -> Response {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return rpc_error(id, -32600, "Invalid JSON-RPC request.");
    };
    if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return rpc_error(id, -32600, "JSON-RPC version 2.0 is required.");
    }
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let result: Result<Value, String> = match method {
        "initialize" => Ok(
            json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"LocalDesk AI","version":"0.2.0"},"instructions":"Use local models through list_models and chat. Requests stay on this computer unless configured upstream tools contact a remote service."}),
        ),
        "notifications/initialized" => return StatusCode::ACCEPTED.into_response(),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools":[
         {"name":"list_models","description":"List installed models on the selected local engine.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
         {"name":"system_status","description":"Read available RAM, disk, and detected graphics memory on this computer.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
         {"name":"chat","description":"Ask an installed local AI model for a response. This tool does not modify files or execute commands.","inputSchema":{"type":"object","properties":{"model":{"type":"string"},"prompt":{"type":"string"},"messages":{"type":"array","items":{"type":"object","properties":{"role":{"type":"string","enum":["system","user","assistant"]},"content":{"type":"string"}},"required":["role","content"]}},"maxTokens":{"type":"integer","minimum":1,"maximum":32768}},"required":["model"],"additionalProperties":false}}
        ]})),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let value = match name {
                "list_models" => {
                    let engine = *state.bridge.inner.engine.read().await;
                    native::models(&state, engine)
                        .await
                        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
                }
                "system_status" => {
                    crate::system::snapshot(state.data_dir.clone(), state.resource_dir.clone())
                        .await
                        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
                }
                "chat" => mcp_chat(&state, args).await,
                _ => return rpc_error(id, -32602, "Unknown tool."),
            };
            match value {
                Ok(value) => Ok(
                    json!({"content":[{"type":"text","text":serde_json::to_string_pretty(&value).unwrap_or_default()}],"isError":false}),
                ),
                Err(error) => Ok(json!({"content":[{"type":"text","text":error}],"isError":true})),
            }
        }
        _ => return rpc_error(id, -32601, "Method not found."),
    };
    match result {
        Ok(result) => Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response(),
        Err(error) => rpc_error(id, -32603, &error),
    }
}
async fn mcp_chat(state: &AppState, args: Value) -> Result<Value, String> {
    let _permit = state
        .bridge_requests
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Too many requests. Try again shortly.")?;
    let model = args
        .get("model")
        .and_then(Value::as_str)
        .ok_or("A model is required.")?;
    let messages: Vec<ChatMessage> = if let Some(messages) = args.get("messages") {
        serde_json::from_value(messages.clone()).map_err(|_| "Invalid messages.")?
    } else {
        vec![ChatMessage {
            role: "user".into(),
            content: args
                .get("prompt")
                .and_then(Value::as_str)
                .ok_or("A prompt or messages array is required.")?
                .into(),
            extra: Default::default(),
        }]
    };
    let max_tokens = args
        .get("maxTokens")
        .and_then(Value::as_u64)
        .map(|v| v.min(u32::MAX as u64) as u32);
    let payload = native::completion_payload(model, &messages, None, max_tokens, false)?;
    let engine = *state.bridge.inner.engine.read().await;
    let response = native::completion(state, engine, payload).await?;
    Ok(
        json!({"model":model,"content":response.pointer("/choices/0/message/content").and_then(Value::as_str).unwrap_or_default()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;
    #[test]
    fn authentication_is_exact() {
        assert!(token_matches(Some("Bearer abc"), "abc"));
        assert!(!token_matches(Some("Bearer abcX"), "abc"));
        assert!(!token_matches(Some("abc"), "abc"));
    }
    #[tokio::test]
    async fn browser_and_anonymous_requests_are_blocked() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().to_path_buf(), None).unwrap();
        state.bridge.inner.enabled.store(true, Ordering::SeqCst);
        let token = state.bridge.inner.token.clone();
        let response = router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .header("host", "127.0.0.1:11435")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = router(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .header("host", "127.0.0.1:11435")
                    .header("authorization", format!("Bearer {token}"))
                    .header("origin", "https://evil.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = router(state)
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .header("host", "127.0.0.1:11435")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
