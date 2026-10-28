//! 领域模型：全部与具体中间件实现无关，前端类型定义与此一一对应。

pub mod acl;
pub mod admin;
pub mod broker;
pub mod cluster;
pub mod cluster_view;
pub mod config_compat;
pub mod consumer;
pub mod consumer_disconnect;
pub mod consumer_graph;
pub mod consumer_link;
pub mod consumer_ownership;
pub mod group_assignment;
pub mod group_block;
pub mod group_removal;
pub mod health;
pub mod lag_trend;
pub mod message;
pub mod message_route;
pub mod migration_runbook;
pub mod node_stats;
pub mod offset_reset;
pub mod orphan;
pub mod parameter;
pub mod partition_hotspot;
pub mod policy;
pub mod producer_guarantee;
pub mod quota;
pub mod reassignment;
pub mod redeliver;
pub mod resend;
pub mod runtime;
pub mod shovel;
pub mod topic;
pub mod topic_config;
pub mod topic_purge;
pub mod topic_throughput;
pub mod topology;
pub mod topology_graph;
pub mod topology_insight;

pub use acl::{
    AclChange, AclChangePlan, AclChangeVerdict, AclEntry, AclFilter, AclOperation, AclPattern,
    AclPermission, AclResourceType, AclSnapshot, AclWriteRequest, PrincipalAcl, assemble_acls,
    entry_fingerprint as acl_entry_fingerprint, plan_create as plan_acl_create,
    plan_delete as plan_acl_delete, validate_entry as validate_acl_entry,
};
pub use admin::{
    DEFAULT_VHOST, FULL_ACCESS, PasswordVerdict, PermissionInfo, RemovalBlock, SpecBlock, UserInfo,
    UserSpec, UserTag, VhostInfo, VhostRow, assemble_vhosts, check_password,
    check_user_removal as check_admin_user_removal, check_vhost_removal,
};
pub use broker::{
    BrokerCapability, BrokerKind, ConnectionConfig, ConnectionId, ConnectionSummary, KafkaAuth,
    KafkaConfig, KeyValue, Overview, QueueInfo, RabbitMqAuth, RabbitMqConfig, SaslMechanism,
    TlsMode, TopicInfo,
};
pub use cluster::{ClusterNode, NodeRole};
pub use cluster_view::{AlertSeverity, ClusterAlert, ClusterView, summarize as summarize_cluster};
pub use config_compat::{
    ConfigCompatReport, ConfigVersionCheck, VersionVerdict, check as check_config_version,
    parse_cluster_version, report as config_compat_report,
};
pub use consumer::{
    ConsumerGroupDetail, ConsumerGroupInfo, ConsumerGroupMember, ConsumerGroupOffset,
    ConsumerGroupQuery, group_has_committed, no_commit_detail,
};
pub use consumer_disconnect::{DisconnectRequest, DisconnectVerdict};
pub use consumer_graph::{
    ConsumerGraph, LinkEdge, LinkEdgeKind, LinkHealth, LinkNode, LinkNodeKind,
    MAX_CONNECTION_NODES, build as build_consumer_graph,
};
pub use consumer_link::{
    ConsumerHealth, ConsumerLinks, QueueConsumer, QueueConsumption,
    summarize as summarize_consumers,
};
pub use consumer_ownership::{
    ChannelFacts, ConnectionFacts, ConsumerOwner, OwnershipSnapshot, QueueOwnership, UserOwnership,
    assemble as assemble_ownership,
};
pub use group_assignment::{
    AssignedPartition, AssignmentState, GroupAssignment, MemberAssignment,
    assemble as assemble_group_assignment, decode as decode_group_assignment,
    not_consumer_protocol as group_assignment_unavailable, partition_query,
};
pub use group_block::{BlockReport, PartitionShift, StuckPartition, detect as detect_group_block};
pub use group_removal::{
    GroupRemovalCheck, GroupRemovalPreflight, assemble as assemble_group_removal,
    check as check_group_removal, normalize_names as normalize_group_names,
};
pub use health::{CheckStatus, HealthCheck, HealthReport, WRITE_ACCESS_KEY};
pub use lag_trend::{
    LagSample, LagTrend, LagTrendVerdict, LagVerdict, PartitionLagProgress,
    compute as compute_lag_trend, describe as describe_lag_trend, series as lag_trend_series,
};
pub use message::{
    MessageDetail, MessageHeader, MessageLocate, MessagePage, MessageQuery, MessageSearch,
    MessageSummary, RawMessageHeader, SendOutcome, SendRequest, content_type_problem,
    delivery_mode,
};
pub use message_route::{ReachableQueue, SendRoute, predict as predict_send_route};
pub use migration_runbook::{
    MigrationRunbook, Precondition, PreconditionState, RunbookRequest, VerifyLine, VerifyState,
    VerifySummary, build as build_runbook, parse_verify, reconcile as reconcile_migration,
    sample_plan as build_sample_plan, topics_file,
};
pub use node_stats::{NodeStat, NodeVerdict, verdicts as node_verdicts};
pub use offset_reset::{
    PartitionState, ResetPhase, ResetPlan, ResetRequest, ResetStep, ResetTarget,
    phases as reset_phases, preview as preview_reset,
};
pub use orphan::{OrphanPartition, OrphanScanScope, OrphanTopic, OrphanTopicPage};
pub use parameter::{
    ParameterComponent, ParameterError, ParameterInfo, ParameterRemoval, ParameterReview,
    ParameterSnapshot, ParameterSpec, VhostScope, redact_uri as redact_parameter_uri,
    review as review_parameter,
};
pub use partition_hotspot::{
    PartitionLoad, PartitionSpread, hotspots as pick_hotspots, summarize as summarize_partitions,
};
pub use policy::{
    DefinitionEntry, ImpactConfidence, ImpactEstimate, OperatorPolicyInfo, PolicyApplyTo,
    PolicyInfo, PolicyRemoval, PolicySnapshot, PolicySpec, PriorityConflict, effective_pattern,
    estimate_impact, overflow_hint, removal_caveats, suppressed_by,
};
pub use producer_guarantee::{
    MAX_IN_FLIGHT_FOR_IDEMPOTENCE, ProducerGuarantee, inspect as inspect_producer_options,
    success_footnote as producer_success_footnote,
};
pub use quota::{
    QuotaEntityKind, QuotaEntry, QuotaGroup, QuotaSnapshot, ScramCredential, ScramMechanism,
    ScramSnapshot, ScramUser, assemble_quota, assemble_scram, byte_rate_text,
    kind_of as quota_kind_of, normalize_entity as normalize_quota_entity,
};
pub use reassignment::{
    Layout as ReassignLayout, MigrationReport, PartitionMigration, PartitionProgress,
    PlanBlock as ReassignPlanBlock, PlannedPartition, ReassignmentPlan,
    parse_plan as parse_reassign_plan, plan_lines as reassign_plan_text,
    progress as reassign_progress,
};
pub use redeliver::{
    BatchDisposalItem, BatchDisposalOutcome, BatchDisposalRequest, BatchItemStatus,
    DISPOSAL_DEAD_LETTER, DISPOSAL_REDELIVER, DeadLetterBlock, DeadLetterPolicy, DeadLetterRequest,
    DeliveryInfo, DisposalCapabilities, DisposalOutcome, MAX_BATCH_SIZE, RedeliverRequest,
    normalize_batch,
};
pub use resend::{PartitionCheck, ResendBlock, ResendOutcome, ResendPlan, ResendRequest};
pub use runtime::{
    ChannelRow, ConnectionDetail, ConnectionRow, QueuePlacement, RuntimeSnapshot,
    assemble as assemble_connections, place_queues,
};
pub use shovel::{
    ShovelRow, ShovelRuntime, ShovelSnapshot, ShovelState, assemble as assemble_shovels,
    stop_hint as shovel_stop_hint,
};
pub use topic::{
    PartitionExpansion, TOPIC_NAME_MAX_LEN, TopicCapabilities, TopicDetail, TopicOutcome,
    TopicPartitionInfo, TopicRemoval, TopicSpec,
};
pub use topic_config::{
    ConfigBlock, ConfigChange, ConfigLock, ConfigOutcome, ConfigPlan, ConfigPlanItem, ConfigType,
    KNOWN_CONFIGS, lock_of as config_lock_of, plan as plan_config_changes,
};
pub use topic_purge::{
    Boundary as PurgeBoundary, PurgeKind, PurgeOutcome, PurgePartitionPlan, PurgePlan,
    PurgeRequest, plan as plan_topic_purge,
};
pub use topic_throughput::{
    MAX_WINDOW_MS, MIN_WINDOW_MS, PartitionRate, PartitionWatermark, SampleWindow, TopicSample,
    TopicThroughput, compute as compute_throughput,
};
pub use topology::{
    BindingDestination, BindingInfo, BindingKey, BindingSpec, BindingTarget, ExchangeInfo,
    ExchangeKind, ExchangeRemoval, ExchangeSpec, QueueDetail, RabbitMqTopology,
};
pub use topology_graph::{
    GraphEdge, GraphNode, GraphNodeKind, MAX_NODES as MAX_GRAPH_NODES, TopologyGraph,
    build as build_topology_graph,
};
pub use topology_insight::{
    ExchangeRoute, QueueMetrics, RouteConfidence, RouteHop, TopologyInsight,
    analyze_with_queues as analyze_topology,
};
