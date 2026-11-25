use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEventRow {
    pub message_id: u64,
    pub client_id: Option<String>,
    #[serde(rename = "type")]
    pub command_type: String,
    pub date: String,
    pub delta_time: f64,
    pub important: bool,
    pub payload_json: String,
}

pub struct PayloadStore {
    conn: Mutex<Connection>,
    db_path: PathBuf,
}

impl PayloadStore {
    pub fn new_temp() -> Result<Self, String> {
        let filename = format!(
            "reactotron-payloads-{}-{}.db",
            std::process::id(),
            uuid::Uuid::new_v4()
        );
        let db_path = std::env::temp_dir().join(filename);
        Self::open_at(db_path)
    }

    pub fn open_at(db_path: PathBuf) -> Result<Self, String> {
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open payload SQLite DB: {e}"))?;

        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;
             CREATE TABLE IF NOT EXISTS command_payloads (
               message_id INTEGER PRIMARY KEY,
               client_id TEXT,
               command_type TEXT NOT NULL,
               date TEXT NOT NULL DEFAULT '',
               delta_time REAL NOT NULL DEFAULT 0.0,
               important INTEGER NOT NULL DEFAULT 0,
               payload_json TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_payloads_client_id
               ON command_payloads(client_id);",
        )
        .map_err(|e| format!("Failed to initialize payload SQLite schema: {e}"))?;

        Ok(Self {
            conn: Mutex::new(conn),
            db_path,
        })
    }

    pub fn insert(
        &self,
        message_id: u64,
        client_id: Option<&str>,
        command_type: &str,
        payload_json: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("DB lock poisoned: {e}"))?;
        conn.execute(
            "INSERT OR REPLACE INTO command_payloads (message_id, client_id, command_type, payload_json)
             VALUES (?1, ?2, ?3, ?4)",
            params![message_id as i64, client_id, command_type, payload_json],
        )
        .map_err(|e| format!("Failed to insert payload: {e}"))?;
        Ok(())
    }

    pub fn get_payload(&self, message_id: u64) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| format!("DB lock poisoned: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT payload_json FROM command_payloads WHERE message_id = ?1")
            .map_err(|e| format!("Failed to prepare get_payload: {e}"))?;

        let mut rows = stmt
            .query(params![message_id as i64])
            .map_err(|e| format!("Failed to query payload: {e}"))?;

        if let Some(row) = rows
            .next()
            .map_err(|e| format!("Failed to read payload row: {e}"))?
        {
            let json: String = row
                .get(0)
                .map_err(|e| format!("Failed to decode payload column: {e}"))?;
            Ok(Some(json))
        } else {
            Ok(None)
        }
    }

    pub fn clear(&self, client_id: Option<&str>) -> Result<usize, String> {
        let conn = self.conn.lock().map_err(|e| format!("DB lock poisoned: {e}"))?;
        let deleted = match client_id {
            Some(cid) => conn
                .execute(
                    "DELETE FROM command_payloads WHERE client_id = ?1",
                    params![cid],
                )
                .map_err(|e| format!("Failed to clear client payloads: {e}"))?,
            None => conn
                .execute("DELETE FROM command_payloads", [])
                .map_err(|e| format!("Failed to clear all payloads: {e}"))?,
        };
        Ok(deleted)
    }

    pub fn search_message_ids(
        &self,
        query: &str,
        client_id: Option<&str>,
    ) -> Result<Vec<u64>, String> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let pattern = format!("%{}%", trimmed.to_lowercase());
        let conn = self.conn.lock().map_err(|e| format!("DB lock poisoned: {e}"))?;
        let mut ids = Vec::new();

        if let Some(cid) = client_id {
            let mut stmt = conn
                .prepare(
                    "SELECT message_id FROM command_payloads
                     WHERE client_id = ?1 AND LOWER(payload_json) LIKE ?2",
                )
                .map_err(|e| format!("Failed to prepare search: {e}"))?;
            let rows = stmt
                .query_map(params![cid, pattern], |row| row.get::<_, i64>(0))
                .map_err(|e| format!("Failed to query search: {e}"))?;
            for r in rows {
                if let Ok(id) = r {
                    ids.push(id as u64);
                }
            }
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT message_id FROM command_payloads
                     WHERE LOWER(payload_json) LIKE ?1",
                )
                .map_err(|e| format!("Failed to prepare search: {e}"))?;
            let rows = stmt
                .query_map(params![pattern], |row| row.get::<_, i64>(0))
                .map_err(|e| format!("Failed to query search: {e}"))?;
            for r in rows {
                if let Ok(id) = r {
                    ids.push(id as u64);
                }
            }
        }

        Ok(ids)
    }

    pub fn insert_event(
        &self,
        message_id: u64,
        client_id: Option<&str>,
        command_type: &str,
        date: &str,
        delta_time: f64,
        important: bool,
        payload_json: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| format!("DB lock poisoned: {e}"))?;
        conn.execute(
            "INSERT OR REPLACE INTO command_payloads
               (message_id, client_id, command_type, date, delta_time, important, payload_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                message_id as i64,
                client_id,
                command_type,
                date,
                delta_time,
                if important { 1i64 } else { 0i64 },
                payload_json
            ],
        )
        .map_err(|e| format!("Failed to insert event: {e}"))?;
        Ok(())
    }

    pub fn list_events(&self, command_type: Option<&str>) -> Result<Vec<StoredEventRow>, String> {
        let conn = self.conn.lock().map_err(|e| format!("DB lock poisoned: {e}"))?;
        let mut out = Vec::new();
        let map_row = |row: &rusqlite::Row<'_>| {
            Ok(StoredEventRow {
                message_id: row.get::<_, i64>(0)? as u64,
                client_id: row.get(1)?,
                command_type: row.get(2)?,
                date: row.get(3)?,
                delta_time: row.get(4)?,
                important: row.get::<_, i64>(5)? != 0,
                payload_json: row.get(6)?,
            })
        };

        if let Some(ct) = command_type {
            let mut stmt = conn
                .prepare(
                    "SELECT message_id, client_id, command_type, date, delta_time, important, payload_json
                     FROM command_payloads WHERE command_type = ?1 ORDER BY message_id ASC",
                )
                .map_err(|e| format!("Failed to prepare list_events: {e}"))?;
            let rows = stmt
                .query_map(params![ct], map_row)
                .map_err(|e| format!("Failed to query list_events: {e}"))?;
            for r in rows {
                if let Ok(item) = r {
                    out.push(item);
                }
            }
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT message_id, client_id, command_type, date, delta_time, important, payload_json
                     FROM command_payloads ORDER BY message_id ASC",
                )
                .map_err(|e| format!("Failed to prepare list_events: {e}"))?;
            let rows = stmt
                .query_map([], map_row)
                .map_err(|e| format!("Failed to query list_events: {e}"))?;
            for r in rows {
                if let Ok(item) = r {
                    out.push(item);
                }
            }
        }
        Ok(out)
    }

    pub fn get_all_payloads(&self) -> Result<std::collections::HashMap<u64, String>, String> {
        let conn = self.conn.lock().map_err(|e| format!("DB lock poisoned: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT message_id, payload_json FROM command_payloads")
            .map_err(|e| format!("Failed to prepare get_all_payloads: {e}"))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| format!("Failed to query get_all_payloads: {e}"))?;
        let mut map = std::collections::HashMap::new();
        for r in rows {
            if let Ok((id, json)) = r {
                map.insert(id as u64, json);
            }
        }
        Ok(map)
    }
}

impl Drop for PayloadStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.db_path);
        let wal = PathBuf::from(format!("{}-wal", self.db_path.display()));
        let shm = PathBuf::from(format!("{}-shm", self.db_path.display()));
        let _ = std::fs::remove_file(wal);
        let _ = std::fs::remove_file(shm);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_get_clear_and_drop_cleanup() {
        let store = PayloadStore::new_temp().expect("create temp store");
        let db_path = store.db_path.clone();
        assert!(db_path.exists());

        store
            .insert(1, Some("client-a"), "log", r#"{"message":"hello"}"#)
            .unwrap();
        store
            .insert(2, Some("client-b"), "log", r#"{"message":"world"}"#)
            .unwrap();

        assert_eq!(
            store.get_payload(1).unwrap().as_deref(),
            Some(r#"{"message":"hello"}"#)
        );
        assert_eq!(store.get_payload(999).unwrap(), None);

        let hits = store.search_message_ids("HELLO", Some("client-a")).unwrap();
        assert_eq!(hits, vec![1]);
        let all_hits = store.search_message_ids("world", None).unwrap();
        assert_eq!(all_hits, vec![2]);
        assert_eq!(store.get_all_payloads().unwrap().len(), 2);

        assert_eq!(store.clear(Some("client-a")).unwrap(), 1);
        assert_eq!(store.get_payload(1).unwrap(), None);
        assert!(store.get_payload(2).unwrap().is_some());

        assert_eq!(store.clear(None).unwrap(), 1);
        assert_eq!(store.get_payload(2).unwrap(), None);

        drop(store);
        assert!(!db_path.exists());
    }
}
