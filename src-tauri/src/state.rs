//! 应用级状态。

use crate::broker::ConnectionRegistry;

/// 由 Tauri 托管的全局状态。
pub struct AppState {
    pub connections: ConnectionRegistry,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            connections: ConnectionRegistry::default(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
