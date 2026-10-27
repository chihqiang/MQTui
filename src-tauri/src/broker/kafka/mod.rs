//! Kafka 连接实现。基于 `rdkafka`。

pub mod acl;
pub mod admin;
pub mod client;
pub mod cluster;
pub mod dto;
pub mod purge;
pub mod quota;
pub mod reset;
pub mod topics;

pub use client::KafkaClient;
