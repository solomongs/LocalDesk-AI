mod bridge;
mod mcp;
mod native;
mod state;
mod store;
mod system;
mod types;

use serde_json::Value;
use state::AppState;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use types::{ChatMessage, Completion, Conversation, Engine, NativeModel, NativeStatus};

struct TauriEvents(AppHandle);
impl native::EventSink for TauriEvents {
    fn chat_event(&self, event: types::ChatChunk) {
        let _ = self.0.emit("native-chat-chunk", event);
    }
    fn download_event(&self, event: types::DownloadProgress) {
        let _ = self.0.emit("model-download-progress", event);
    }
}

#[tauri::command]
async fn get_system_status(state: State<'_, AppState>) -> Result<system::SystemStatus, String> {
    system::snapshot(state.data_dir.clone(), state.resource_dir.clone()).await
}
#[tauri::command]
async fn get_native_status(
    state: State<'_, AppState>,
    engine: Engine,
) -> Result<NativeStatus, String> {
    Ok(native::status(&state, engine).await)
}
#[tauri::command]
async fn native_list_models(
    state: State<'_, AppState>,
    engine: Engine,
) -> Result<Vec<NativeModel>, String> {
    native::models(&state, engine).await
}
#[tauri::command]
async fn native_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    engine: Engine,
    model: String,
    messages: Vec<ChatMessage>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> Result<Completion, String> {
    native::chat(
        Arc::new(TauriEvents(app)),
        state.inner().clone(),
        request_id,
        engine,
        model,
        messages,
        temperature,
        max_tokens,
    )
    .await
}
#[tauri::command]
fn native_cancel(state: State<'_, AppState>, request_id: String) -> Result<bool, String> {
    let map = state
        .cancellations
        .lock()
        .map_err(|_| "Request queue unavailable.")?;
    if let Some(token) = map.get(&request_id) {
        token.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}
#[tauri::command]
async fn pull_ollama_model(
    app: AppHandle,
    state: State<'_, AppState>,
    model: String,
) -> Result<(), String> {
    native::pull(Arc::new(TauriEvents(app)), state.inner().clone(), model).await
}
#[tauri::command]
fn cancel_ollama_pull(state: State<'_, AppState>, model: String) -> Result<bool, String> {
    native_cancel(state, format!("pull:{model}"))
}
#[tauri::command]
async fn delete_ollama_model(state: State<'_, AppState>, model: String) -> Result<(), String> {
    native::delete_model(&state, model).await
}
#[tauri::command]
async fn start_ollama(state: State<'_, AppState>) -> Result<String, String> {
    if native::status(&state, Engine::Ollama).await.connected {
        return Ok("Ollama is already running.".into());
    }
    system::start_ollama(state.resource_dir.as_deref()).await
}
#[tauri::command]
fn llmfit_status(state: State<'_, AppState>) -> system::ToolStatus {
    let path = system::locate_program("llmfit", state.resource_dir.as_deref());
    system::ToolStatus {
        installed: path.is_some(),
        path: path.map(|p| p.to_string_lossy().into_owned()),
        install_url: "https://github.com/AlexsJones/llmfit/releases",
    }
}
#[tauri::command]
async fn get_fit_recommendations(
    state: State<'_, AppState>,
    use_case: Option<String>,
) -> Result<Value, String> {
    system::fit_recommendations(state.resource_dir.as_deref(), use_case).await
}
#[tauri::command]
async fn get_bridge_status(state: State<'_, AppState>) -> Result<bridge::BridgeStatus, String> {
    Ok(state.bridge.status().await)
}
#[tauri::command]
async fn set_bridge_enabled(
    state: State<'_, AppState>,
    enabled: bool,
    engine: Engine,
) -> Result<bridge::BridgeStatus, String> {
    bridge::set_enabled(state.inner().clone(), enabled, engine).await
}
#[tauri::command]
fn list_conversations(state: State<'_, AppState>) -> Result<Vec<Conversation>, String> {
    state.store.conversations()
}
#[tauri::command]
fn save_conversation(state: State<'_, AppState>, conversation: Conversation) -> Result<(), String> {
    state.store.save(&conversation)
}
#[tauri::command]
fn delete_conversation(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.store.delete(&id)
}
#[tauri::command]
fn get_setting(state: State<'_, AppState>, key: String) -> Result<Option<Value>, String> {
    if key.starts_with("internal.") {
        return Err("This setting is managed by LocalDesk.".into());
    }
    state.store.get(&key)
}
#[tauri::command]
fn set_setting(state: State<'_, AppState>, key: String, value: Value) -> Result<(), String> {
    if key.starts_with("internal.") {
        return Err("This setting is managed by LocalDesk.".into());
    }
    state.store.set(&key, &value)
}
#[tauri::command]
async fn mcp_list_tools(
    state: State<'_, AppState>,
    server: mcp::McpServer,
    confirmed: bool,
) -> Result<Value, String> {
    mcp::list_tools(state.inner().clone(), server, confirmed).await
}
#[tauri::command]
async fn mcp_call_tool(
    state: State<'_, AppState>,
    server: mcp::McpServer,
    name: String,
    arguments: Value,
    confirmed: bool,
) -> Result<Value, String> {
    mcp::call_tool(state.inner().clone(), server, name, arguments, confirmed).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let resources = app.path().resource_dir().ok();
            let state = AppState::new(data_dir, resources).map_err(std::io::Error::other)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_system_status,
            get_native_status,
            native_list_models,
            native_chat,
            native_cancel,
            pull_ollama_model,
            cancel_ollama_pull,
            delete_ollama_model,
            start_ollama,
            llmfit_status,
            get_fit_recommendations,
            get_bridge_status,
            set_bridge_enabled,
            list_conversations,
            save_conversation,
            delete_conversation,
            get_setting,
            set_setting,
            mcp_list_tools,
            mcp_call_tool
        ])
        .run(tauri::generate_context!())
        .expect("LocalDesk AI could not start");
}
