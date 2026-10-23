#![allow(dead_code)]
//! GUI-independent tests of the actual native backend implementation.
//! Only the event-delivery adapter lives in the Tauri executable; all logic here
//! is compiled from the production source files, without mocked implementations.
#[path = "../../src/types.rs"] mod types;
#[path = "../../src/store.rs"] mod store;
#[path = "../../src/state.rs"] mod state;
#[path = "../../src/system.rs"] mod system;
#[path = "../../src/native.rs"] mod native;
#[path = "../../src/bridge.rs"] mod bridge;
#[path = "../../src/mcp.rs"] mod mcp;
