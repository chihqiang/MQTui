//! 领域模型：全部与具体中间件实现无关，前端类型定义与此一一对应。

pub mod broker;
pub mod consumer;
pub mod health;
pub mod message;
pub mod orphan;
pub mod topology;

pub use broker::{
    BrokerCapability, BrokerKind, ConnectionConfig, ConnectionId, ConnectionSummary, KafkaAuth,
    KafkaConfig, KeyValue, Overview, QueueInfo, RabbitMqAuth, RabbitMqConfig, SaslMechanism,
    TlsMode, TopicInfo,
};
pub use consumer::{
    ConsumerGroupDetail, ConsumerGroupInfo, ConsumerGroupMember, ConsumerGroupOffset,
    ConsumerGroupQuery,
};
pub use health::{CheckStatus, HealthCheck, HealthReport, WRITE_ACCESS_KEY};
pub use message::{
    MessageDetail, MessageHeader, MessagePage, MessageQuery, MessageSummary, SendOutcome,
    SendRequest,
};
pub use orphan::{OrphanPartition, OrphanScanScope, OrphanTopic, OrphanTopicPage};
pub use topology::{
    BindingDestination, BindingInfo, BindingKey, BindingSpec, BindingTarget, ExchangeInfo,
    ExchangeKind, ExchangeRemoval, ExchangeSpec, QueueDetail, RabbitMqTopology,
};
