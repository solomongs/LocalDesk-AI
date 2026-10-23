use crate::types::{validate_messages, Conversation};
use rand::RngCore;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub struct Store(pub Arc<Mutex<Connection>>);
impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;\nCREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, messages TEXT NOT NULL, updated_at INTEGER NOT NULL);\nCREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);").map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(Self(Arc::new(Mutex::new(conn))))
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.0
            .lock()
            .map_err(|_| "Database is busy; restart the app.".to_string())
    }
    pub fn conversations(&self) -> Result<Vec<Conversation>, String> {
        let conn = self.lock()?;
        let mut statement = conn.prepare("SELECT id,title,messages,updated_at FROM conversations ORDER BY updated_at DESC LIMIT 500").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            let (id, title, messages, updated_at) = row.map_err(|e| e.to_string())?;
            Ok(Conversation {
                id,
                title,
                messages: serde_json::from_str(&messages)
                    .map_err(|_| "A saved conversation could not be read.".to_string())?,
                updated_at,
            })
        })
        .collect()
    }
    pub fn save(&self, conversation: &Conversation) -> Result<(), String> {
        if conversation.id.is_empty()
            || conversation.id.len() > 120
            || conversation.title.len() > 500
        {
            return Err("Conversation ID or title is invalid.".into());
        }
        if !conversation.messages.is_empty() {
            validate_messages(&conversation.messages)?;
        }
        let messages = serde_json::to_string(&conversation.messages).map_err(|e| e.to_string())?;
        if messages.len() > 4 * 1024 * 1024 {
            return Err("Conversation is too large to save.".into());
        }
        self.lock()?.execute("INSERT INTO conversations(id,title,messages,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET title=excluded.title,messages=excluded.messages,updated_at=excluded.updated_at",params![conversation.id,conversation.title,messages,conversation.updated_at]).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.lock()?
            .execute("DELETE FROM conversations WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn get(&self, key: &str) -> Result<Option<Value>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare("SELECT value FROM settings WHERE key=?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([key]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(row) => {
                let raw: String = row.get(0).map_err(|e| e.to_string())?;
                Ok(Some(
                    serde_json::from_str(&raw)
                        .map_err(|_| "Saved setting is invalid.".to_string())?,
                ))
            }
            None => Ok(None),
        }
    }
    pub fn set(&self, key: &str, value: &Value) -> Result<(), String> {
        if key.is_empty() || key.len() > 120 {
            return Err("Setting key is invalid.".into());
        }
        let raw = serde_json::to_string(value).map_err(|e| e.to_string())?;
        if raw.len() > 256 * 1024 {
            return Err("Setting is too large.".into());
        }
        self.lock()?.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,raw]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn token(&self) -> Result<String, String> {
        if let Some(Value::String(token)) = self.get("internal.bridge_token")? {
            if token.len() == 64 {
                return Ok(token);
            }
        }
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let token = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        self.set("internal.bridge_token", &Value::String(token.clone()))?;
        Ok(token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn database_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        let token;
        {
            let db = Store::open(&path).unwrap();
            db.set("theme", &serde_json::json!("dark")).unwrap();
            token = db.token().unwrap();
            db.save(&Conversation {
                id: "chat-1".into(),
                title: "Hello".into(),
                messages: vec![],
                updated_at: 123,
            })
            .unwrap();
        }
        let db = Store::open(&path).unwrap();
        assert_eq!(db.get("theme").unwrap(), Some(serde_json::json!("dark")));
        assert_eq!(db.token().unwrap(), token);
        assert_eq!(db.conversations().unwrap()[0].id, "chat-1");
        db.delete("chat-1").unwrap();
        assert!(db.conversations().unwrap().is_empty());
    }
    #[test]
    fn sql_input_is_data_not_code() {
        let dir = tempfile::tempdir().unwrap();
        let db = Store::open(&dir.path().join("x.db")).unwrap();
        db.set("x';DROP TABLE settings;--", &Value::Bool(true))
            .unwrap();
        assert_eq!(
            db.get("x';DROP TABLE settings;--").unwrap(),
            Some(Value::Bool(true))
        );
    }
}
