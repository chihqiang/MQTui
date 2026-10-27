//! Kafka 连接实现。基于 `rdkafka`。

pub mod admin;
pub mod client;
pub mod dto;

pub use client::KafkaClient;
