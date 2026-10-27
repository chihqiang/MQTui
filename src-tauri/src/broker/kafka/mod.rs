//! Kafka 连接实现。基于 `rdkafka`。

pub mod admin;
pub mod client;
pub mod cluster;
pub mod dto;
pub mod reset;
pub mod topics;

pub use client::KafkaClient;
