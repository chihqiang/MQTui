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
        // `Optional` 在 Kafka 里没有对应物：协议没有「先试明文再升级」这一步，
        // 只有 plaintext / ssl / sasl_*。映射成 plaintext 会让用户在表单里
        // 选着「可选 TLS」、实际拿到「永不加密」。所以这里按最接近他意图的
        // 一档处理：`ssl`，但关掉证书校验（“尽最大努力加密，不因此连不上”）。
        TlsMode::Optional => {
            client
                .set("security.protocol", "ssl")
                .set("enable.ssl.certificate.verification", "false");
        }
        TlsMode::Disabled => {
            client.set("security.protocol", "plaintext");
        }
        TlsMode::Required => {
            client.set("security.protocol", "ssl");
        }
    }

    if let Some(mechanism) = config.auth.mechanism.as_kafka_str() {
        // SASL 需要与 TLS 组合，否则协议不匹配。
        let protocol = match config.tls {
            TlsMode::Required | TlsMode::Optional => "sasl_ssl",
            TlsMode::Disabled => "sasl_plaintext",
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
    fn optional_tls_means_encrypted_without_verification() {
        // Kafka 没有「可选 TLS」这一档。映射成 plaintext 会让用户以为加密了
        // 其实没有；映射成 ssl 但关掉校验，才是他要的那个「尽力加密、别连不上」。
        let config = client_config(&sample(TlsMode::Optional, SaslMechanism::None));
        assert_eq!(config.get("security.protocol"), Some("ssl"));
        assert_eq!(
            config.get("enable.ssl.certificate.verification"),
            Some("false")
        );
    }

    #[test]
    fn required_tls_keeps_certificate_verification() {
        let config = client_config(&sample(TlsMode::Required, SaslMechanism::None));
        assert_eq!(config.get("security.protocol"), Some("ssl"));
        assert_eq!(config.get("enable.ssl.certificate.verification"), None);
    }

    #[test]
    fn sasl_without_tls_uses_sasl_plaintext() {
        let config = client_config(&sample(TlsMode::Disabled, SaslMechanism::Plain));
        assert_eq!(config.get("security.protocol"), Some("sasl_plaintext"));
    }
}
