//! 命令层：Tauri 与前端之间的唯一入口。
//!
//! 每个命令只做三件事：解析参数、调用下层、转换错误。业务逻辑不写在这里。

pub mod acl;
pub mod admin;
pub mod broker;
pub mod cluster;
pub mod consumer;
pub mod message;
pub mod parameter;
pub mod policy;
pub mod quota;
pub mod reset;
pub mod topic;
