//! RabbitMQ 领域模型与 lapin 类型之间的转换。

use lapin::BasicProperties;
use lapin::types::{AMQPValue, FieldTable, ShortString};

use crate::domain::{MessageHeader, RabbitMqConfig};

/// 构造 amqp URI。
///
/// 用户名与密码需要做百分号编码，避免 `@`、`/` 等字符破坏 URI 结构。
pub fn amqp_uri(config: &RabbitMqConfig) -> String {
    let scheme = match config.tls {
        crate::domain::TlsMode::Disabled => "amqp",
        _ => "amqps",
    };
    format!(
        "{scheme}://{}:{}@{}:{}/{}",
        encode(&config.auth.username),
        encode(&config.auth.password),
        config.host,
        config.port,
        encode(&config.auth.vhost),
    )
}

/// RFC 3986 百分号编码，仅保留 unreserved 字符。
fn encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(char::from(byte));
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 把 BasicProperties 中的 headers 转换为字符串键值对。
pub fn headers_from_properties(properties: &BasicProperties) -> Vec<MessageHeader> {
    properties
        .headers()
        .as_ref()
        .map(|table| {
            table
                .into_iter()
                .map(|(key, value)| MessageHeader {
                    key: key.to_string(),
                    value: amqp_value_to_string(value),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// AMQP 值转字符串，仅用于展示。
pub fn amqp_value_to_string(value: &AMQPValue) -> String {
    match value {
        AMQPValue::LongString(value) => value.to_string(),
        AMQPValue::ShortString(value) => value.to_string(),
        AMQPValue::Boolean(value) => value.to_string(),
        AMQPValue::LongInt(value) => value.to_string(),
        AMQPValue::LongUInt(value) => value.to_string(),
        AMQPValue::LongLongInt(value) => value.to_string(),
        AMQPValue::Double(value) => value.to_string(),
        AMQPValue::FieldTable(table) => table_to_string(table),
        AMQPValue::FieldArray(array) => array
            .as_slice()
            .iter()
            .map(amqp_value_to_string)
            .collect::<Vec<_>>()
            .join(","),
        other => format!("{other:?}"),
    }
}

fn table_to_string(table: &FieldTable) -> String {
    table
        .into_iter()
        .map(|(key, value)| format!("{key}={}", amqp_value_to_string(value)))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 字符串键值对转换为 AMQP 头。
pub fn field_table_from_headers(headers: &[(String, String)]) -> FieldTable {
    let mut table = FieldTable::default();
    for (key, value) in headers {
        table.insert(
            ShortString::from(key.clone()),
            AMQPValue::LongString(value.clone().into()),
        );
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{RabbitMqAuth, TlsMode};

    #[test]
    fn uri_encodes_credentials_and_vhost() {
        let config = RabbitMqConfig {
            host: "mq.example.com".to_owned(),
            port: 5672,
            tls: TlsMode::Disabled,
            auth: RabbitMqAuth {
                username: "us er".to_owned(),
                password: "p@ss/word".to_owned(),
                vhost: "my vhost".to_owned(),
            },
            management_url: None,
        };
        assert_eq!(
            amqp_uri(&config),
            "amqp://us%20er:p%40ss%2Fword@mq.example.com:5672/my%20vhost"
        );
    }

    #[test]
    fn tls_switches_scheme() {
        let config = RabbitMqConfig {
            host: "localhost".to_owned(),
            port: 5671,
            tls: TlsMode::Required,
            auth: RabbitMqAuth::default(),
            management_url: None,
        };
        assert!(amqp_uri(&config).starts_with("amqps://"));
    }
}
