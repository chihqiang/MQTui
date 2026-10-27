//! 统一错误类型：内部错误在 `error` 模块收敛，序列化给前端时只暴露稳定结构。

use serde::Serialize;

/// 应用内部错误。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// 参数不合法（连接 ID 不存在、缺少必填字段等）。
    #[error("{0}")]
    Invalid(String),

    /// 连接中间件失败。
    #[error("连接失败: {0}")]
    Connect(String),

    /// 中间件返回的错误。
    #[error("{0}")]
    Broker(String),

    /// 资源不存在。
    #[error("资源不存在: {0}")]
    NotFound(String),

    /// 尚未实现或当前中间件不支持该能力。
    #[error("不支持的操作: {0}")]
    Unsupported(String),

    /// 其他未归类错误。
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    /// 用于前端区分错误种类的稳定标识。
    fn kind(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "invalid",
            Self::Connect(_) => "connect",
            Self::Broker(_) => "broker",
            Self::NotFound(_) => "not_found",
            Self::Unsupported(_) => "unsupported",
            Self::Internal(_) => "internal",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;

        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<rdkafka::error::KafkaError> for AppError {
    fn from(error: rdkafka::error::KafkaError) -> Self {
        Self::Broker(format!("Kafka: {error}"))
    }
}

impl From<lapin::Error> for AppError {
    fn from(error: lapin::Error) -> Self {
        Self::Broker(format!("RabbitMQ: {error}"))
    }
}

#[cfg(feature = "desktop")]
impl From<tauri::Error> for AppError {
    fn from(error: tauri::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

/// 命令层统一返回类型。
pub type AppResult<T> = Result<T, AppError>;
