//! RabbitMQ 连接实现。基于 `lapin`（纯 Rust 的 AMQP 0-9-1 客户端，无需链接 C 库）。

pub mod client;
pub mod dto;
pub mod management;
pub mod runtime;

pub use client::RabbitMqClient;
