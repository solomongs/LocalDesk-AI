use crate::{bridge::BridgeManager, store::Store};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub client: reqwest::Client,
    pub cancellations: Arc<Mutex<HashMap<String, CancellationToken>>>,
    pub bridge: BridgeManager,
    pub bridge_requests: Arc<Semaphore>,
    pub data_dir: PathBuf,
    pub resource_dir: Option<PathBuf>,
}
impl AppState {
    pub fn new(data_dir: PathBuf, resource_dir: Option<PathBuf>) -> Result<Self, String> {
        let store = Store::open(&data_dir.join("localdesk.sqlite3"))?;
        let token = store.token()?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(5))
            .user_agent("LocalDesk-AI/0.2.0")
            .build()
            .map_err(|_| "Could not initialize local networking.".to_string())?;
        Ok(Self {
            store,
            client,
            cancellations: Arc::new(Mutex::new(HashMap::new())),
            bridge: BridgeManager::new(token),
            bridge_requests: Arc::new(Semaphore::new(4)),
            data_dir,
            resource_dir,
        })
    }
}
