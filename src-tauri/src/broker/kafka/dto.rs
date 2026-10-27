//! Kafka 领域模型与 librdkafka 配置之间的映射。

use std::collections::BTreeMap;

use rdkafka::ClientConfig;

use crate::domain::{KafkaConfig, SaslMechanism, TlsMode};

/// 把领域层的连接配置翻译成 librdkafka 配置。
///
/// 单独抽出便于单元测试：配置拼装是最容易出错、也最难在线排查的部分。
pub fn client_config(config: &KafkaConfig) -> ClientConfig {
    let mut client = ClientConfig::new();

    client.set("bootstrap.servers", config.brokers.join(","));
    // 面板场景更关注“快速失败”和“可观测”，而不是极致吞吐。
    client
        .set("socket.timeout.ms", "10000")
        .set("api.version.request", "true")
        .set("client.id", "mqtui");

    match config.tls {
        TlsMode::Disabled | TlsMode::Optional => {
            client.set("security.protocol", "plaintext");
        }
        TlsMode::Required => {
            client.set("security.protocol", "ssl");
        }
    }

    if let Some(mechanism) = config.auth.mechanism.as_kafka_str() {
        // SASL 需要与 TLS 组合，否则协议不匹配。
        let protocol = if config.tls == TlsMode::Required {
            "sasl_ssl"
        } else {
            "sasl_plaintext"
        };
        client
            .set("security.protocol", protocol)
            .set("sasl.mechanism", mechanism);

        if config.auth.mechanism != SaslMechanism::None {
            client
                .set("sasl.username", &config.auth.username)
                .set("sasl.password", &config.auth.password);
        }
    }

    for (key, value) in extra_options(config) {
        client.set(key, value);
    }

    client
}

fn extra_options(config: &KafkaConfig) -> BTreeMap<String, String> {
    config
        .options
        .iter()
        .filter(|(key, _)| !key.trim().is_empty())
        .map(|(key, value)| (key.trim().to_owned(), value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::KafkaAuth;

    fn sample(tls: TlsMode, mechanism: SaslMechanism) -> KafkaConfig {
        KafkaConfig {
            brokers: vec!["127.0.0.1:9092".to_owned()],
            tls,
            auth: KafkaAuth {
                mechanism,
                username: "user".to_owned(),
                password: "pwd".to_owned(),
            },
            options: BTreeMap::from([("fetch.wait.max.ms".to_owned(), "500".to_owned())]),
        }
    }

    #[test]
    fn plaintext_by_default() {
        let config = client_config(&sample(TlsMode::Disabled, SaslMechanism::None));
        assert_eq!(config.get("security.protocol"), Some("plaintext"));
        assert_eq!(config.get("bootstrap.servers"), Some("127.0.0.1:9092"));
        assert_eq!(config.get("fetch.wait.max.ms"), Some("500"));
    }

    #[test]
    fn sasl_over_tls_uses_sasl_ssl() {
        let config = client_config(&sample(TlsMode::Required, SaslMechanism::ScramSha512));
        assert_eq!(config.get("security.protocol"), Some("sasl_ssl"));
        assert_eq!(config.get("sasl.mechanism"), Some("SCRAM-SHA-512"));
        assert_eq!(config.get("sasl.username"), Some("user"));
    }

    #[test]
    fn sasl_without_tls_uses_sasl_plaintext() {
        let config = client_config(&sample(TlsMode::Disabled, SaslMechanism::Plain));
        assert_eq!(config.get("security.protocol"), Some("sasl_plaintext"));
    }
}
