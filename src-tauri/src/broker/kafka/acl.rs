//! 读 ACL：`DescribeAcls` 走 librdkafka 的 FFI。
//!
//! ## 为什么这次是「包一层」而不是「做不了」
//!
//! 配额那屏读不到，是因为 librdkafka 压根没导出 `DescribeClientQuotas`。
//! ACL 不一样：`rd_kafka_DescribeAcls` 从 0.11.0 就在头文件里，签名也稳定。
//! 缺的只是 `rdkafka` crate 没把它包出来（它只包了 topic 与 group 两组 admin API）。
//!
//! ## 只读的原因
//!
//! 读：一次请求、一个事件、无状态，失败什么都不留下，包一层风险可控。
//! 写：`CreateAcls` / `DeleteAcls` 一旦写错就是授权事故 —— 多一条是「谁能进来」，
//! 少一条是「谁掉线」。面板要做写入，得先有「与现有规则比对」的那一步，
//! 不属于这一轮。

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::time::Duration;

use rdkafka::bindings::{self, rd_kafka_resp_err_t};

use crate::domain::{
    AclEntry, AclFilter, AclOperation, AclPattern, AclPermission, AclResourceType,
};
use crate::error::{AppError, AppResult};

use super::KafkaClient;

/// 等待 ACL 结果的超时。
const ACL_TIMEOUT: Duration = Duration::from_secs(15);

/// 读取匹配过滤器的全部 ACL。
///
/// broker 不支持 ACL（2.0 以下，或没配 `authorizer.class.name`）时返回
/// `AppError::Unsupported`：那是「问不了」，界面上要显示成一句解释，
/// 不是一张空表 —— 空表会被读成「这台集群允许所有人做任何事」。
pub async fn describe(client: &KafkaClient, filter: AclFilter) -> AppResult<Vec<AclEntry>> {
    let worker = client.clone_handle()?;
    tokio::task::spawn_blocking(move || read(&worker, &filter))
        .await
        .map_err(|error| AppError::Internal(format!("ACL 读取任务失败: {error}")))?
}

fn read(client: &KafkaClient, filter: &AclFilter) -> AppResult<Vec<AclEntry>> {
    let admin = client.admin()?;
    let rk = admin.inner().native_ptr();

    let queue = unsafe { bindings::rd_kafka_queue_new(rk) };
    if queue.is_null() {
        return Err(AppError::Internal("创建 Kafka 结果队列失败".to_owned()));
    }
    let queue = QueueGuard(queue);

    let mut filter = FilterGuard::new(filter)?;
    let options = OptionsGuard::new(
        rk,
        bindings::rd_kafka_admin_op_t::RD_KAFKA_ADMIN_OP_DESCRIBEACLS,
    )?;

    unsafe {
        bindings::rd_kafka_DescribeAcls(rk, filter.0, options.0, queue.0);
    }
    // 请求发出去之后所有权归 librdkafka（它内部会 copy 过滤器）。
    filter.release();

    // 事件一拿到就进守卫：后面的每个 `return Err` 都不该把它漏在堆上。
    let event = poll(&queue, "ACL 列表")?;

    let error = unsafe { bindings::rd_kafka_event_error(event.0) };
    if error != rd_kafka_resp_err_t::RD_KAFKA_RESP_ERR_NO_ERROR {
        let message = unsafe { c_string(bindings::rd_kafka_event_error_string(event.0)) }
            .unwrap_or_else(|| format!("{error:?}"));
        return if is_unsupported(&message) {
            Err(AppError::Unsupported(format!(
                "这台 broker 不支持 ACL（需要 2.0 以上且配置授权器）：{message}"
            )))
        } else if is_forbidden(&message) {
            Err(AppError::Broker(format!(
                "没有读 ACL 的权限：需要集群级的 DESCRIBE 授权。{message}"
            )))
        } else {
            Err(AppError::Broker(format!("读取 ACL 失败: {message}")))
        };
    }

    Ok(unsafe { collect(event.0) })
}

/// 新建一批 ACL 规则。
///
/// 逐条返回结果：服务端对每条规则单独回执，某一条主体写法不合法不会让整批失败。
/// 所以这里返回「哪几条建成了、哪几条没建成、为什么」，而不是一个 `Result<()>` ——
/// 合成一个 `Err` 会让人以为一条都没建成，然后重试一遍，把成功的那几条再发一次。
pub async fn create(
    client: &KafkaClient,
    entries: Vec<AclEntry>,
) -> AppResult<Vec<AclWriteOutcome>> {
    if entries.is_empty() {
        return Err(AppError::Invalid("没有要提交的规则".to_owned()));
    }
    let worker = client.clone_handle()?;
    tokio::task::spawn_blocking(move || write_create(&worker, &entries))
        .await
        .map_err(|error| AppError::Internal(format!("ACL 写入任务失败: {error}")))?
}

/// 删除一批 ACL 规则。
///
/// 管理 API 收的是**过滤器**，所以最危险的情况是「以为删了一条，其实删了一类」：
/// 一个空名字的过滤器会把同类资源上的规则一次删光。这里的过滤器严格由规则本身
/// 逐字段构造，并且把「实际命中并删除的条数」回报出去 —— 命中数大于 1 时，
/// 界面必须告诉用户这次删除的范围比想象中大。
pub async fn delete(
    client: &KafkaClient,
    entries: Vec<AclEntry>,
) -> AppResult<Vec<AclWriteOutcome>> {
    if entries.is_empty() {
        return Err(AppError::Invalid("没有要删除的规则".to_owned()));
    }
    let worker = client.clone_handle()?;
    tokio::task::spawn_blocking(move || write_delete(&worker, &entries))
        .await
        .map_err(|error| AppError::Internal(format!("ACL 删除任务失败: {error}")))?
}

fn write_create(client: &KafkaClient, entries: &[AclEntry]) -> AppResult<Vec<AclWriteOutcome>> {
    let admin = client.admin()?;
    let rk = admin.inner().native_ptr();

    let mut bindings: Vec<*mut bindings::rd_kafka_AclBinding_t> = Vec::with_capacity(entries.len());
    for entry in entries {
        bindings.push(binding_of(entry)?);
    }
    // 所有权在 `rd_kafka_CreateAcls` 调用之后归 librdkafka，失败路径要自己释放。
    let owned = BindingList(bindings.into_iter().map(|ptr| ptr as *mut _).collect());

    let queue = unsafe { bindings::rd_kafka_queue_new(rk) };
    if queue.is_null() {
        return Err(AppError::Internal("创建 Kafka 结果队列失败".to_owned()));
    }
    let queue = QueueGuard(queue);

    let options = OptionsGuard::new(
        rk,
        bindings::rd_kafka_admin_op_t::RD_KAFKA_ADMIN_OP_CREATEACLS,
    )?;

    unsafe {
        bindings::rd_kafka_CreateAcls(
            rk,
            owned.0.as_ptr() as *mut *mut bindings::rd_kafka_AclBinding_t,
            owned.0.len(),
            options.0,
            queue.0,
        );
    }
    // 请求已经发出，librdkafka 接管了数组里每个 binding 的所有权。
    std::mem::forget(owned);

    let event = poll(&queue, "新建 ACL")?;
    let result = unsafe { bindings::rd_kafka_event_CreateAcls_result(event.0) };
    if result.is_null() {
        return Err(AppError::Broker("新建 ACL 没有返回结果".to_owned()));
    }
    // 回执顺序与请求顺序一致。缺一条就按「没建成」记 —— 少写一条是「谁掉线」。
    let mut count: usize = 0;
    let results = unsafe { bindings::rd_kafka_CreateAcls_result_acls(result, &mut count) };
    let mut each = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let error = if results.is_null() || index >= count {
            // 服务端没给这一条回执：不能说成功，也不能编一个错误。
            each.push(AclWriteOutcome {
                entry: entry.clone(),
                ok: false,
                message: "服务端没有返回这条规则的结果，请刷新确认".to_owned(),
                matched: 0,
            });
            continue;
        } else {
            let item = unsafe { *results.add(index) };
            if item.is_null() {
                None
            } else {
                let error = unsafe { bindings::rd_kafka_acl_result_error(item) };
                (!error.is_null()).then_some(error)
            }
        };
        each.push(outcome_of(entry, error, "新建"));
    }
    Ok(each)
}

fn write_delete(client: &KafkaClient, entries: &[AclEntry]) -> AppResult<Vec<AclWriteOutcome>> {
    let admin = client.admin()?;
    let rk = admin.inner().native_ptr();

    let mut filters: Vec<*mut bindings::rd_kafka_AclBindingFilter_t> =
        Vec::with_capacity(entries.len());
    for entry in entries {
        filters.push(filter_of(entry)?);
    }
    let owned = BindingList(filters.into_iter().map(|ptr| ptr as *mut _).collect());

    let queue = unsafe { bindings::rd_kafka_queue_new(rk) };
    if queue.is_null() {
        return Err(AppError::Internal("创建 Kafka 结果队列失败".to_owned()));
    }
    let queue = QueueGuard(queue);

    let options = OptionsGuard::new(
        rk,
        bindings::rd_kafka_admin_op_t::RD_KAFKA_ADMIN_OP_DELETEACLS,
    )?;

    unsafe {
        bindings::rd_kafka_DeleteAcls(
            rk,
            owned.0.as_ptr() as *mut *mut bindings::rd_kafka_AclBindingFilter_t,
            owned.0.len(),
            options.0,
            queue.0,
        );
    }
    std::mem::forget(owned);

    let event = poll(&queue, "删除 ACL")?;
    let result = unsafe { bindings::rd_kafka_event_DeleteAcls_result(event.0) };
    if result.is_null() {
        return Err(AppError::Broker("删除 ACL 没有返回结果".to_owned()));
    }

    let mut count: usize = 0;
    let responses = unsafe { bindings::rd_kafka_DeleteAcls_result_responses(result, &mut count) };
    let receipts = unsafe { delete_receipts(responses, count) };

    Ok(match_delete_receipts(entries, &receipts))
}

/// 把删除回执按**过滤器语义**匹配回请求。
///
/// 三件事让「按下标对齐」和「按 binding 逐字比」都不成立：
///
/// 1. 协议只保证「每个过滤器一条回执」，不保证顺序；
/// 2. 回执里带的是 `matching_acls` —— **实际命中的 ACL 内容**，不是请求本身。
///    前缀规则 `payments-` 命中的是 `payments-orders`，两者名字不相等；
/// 3. 命中为空的成功回执（这条规则本来就不在集群上）没有内容可比，
///    按内容比会把它安给第一条还没配上的规则。
///
/// 所以先按内容认领（能证明的那几条先落位），剩下的空回执再按顺序补给
/// 仍无回执的请求。宁可按顺序猜，也不要让某条规则拿到别人的命中数。
fn match_delete_receipts(
    entries: &[AclEntry],
    receipts: &[DeleteReceipt<'_>],
) -> Vec<AclWriteOutcome> {
    let mut used = vec![false; receipts.len()];
    let mut owner: Vec<Option<usize>> = vec![None; entries.len()];

    // 第一轮：命中内容能证明归属的回执，按内容认领。
    for (receipt_index, receipt) in receipts.iter().enumerate() {
        if receipt.error.is_some() || receipt.matched.is_empty() {
            continue;
        }
        let candidate = entries
            .iter()
            .enumerate()
            .position(|(entry_index, entry)| owner[entry_index].is_none() && receipt.covers(entry));
        let Some(entry_index) = candidate else {
            continue;
        };
        owner[entry_index] = Some(receipt_index);
        used[receipt_index] = true;
    }

    // 第二轮：剩下的空回执没有内容可比，按顺序补给还没配上的请求。
    let mut next = 0usize;
    for slot in &mut owner {
        if slot.is_some() {
            continue;
        }
        while next < receipts.len() && used[next] {
            next += 1;
        }
        if next < receipts.len() && receipts[next].matched.is_empty() {
            *slot = Some(next);
            used[next] = true;
        }
    }

    entries
        .iter()
        .enumerate()
        .map(|(entry_index, entry)| match owner[entry_index] {
            Some(receipt_index) => {
                let receipt = &receipts[receipt_index];
                let mut item = outcome_of(entry, receipt.error, "删除");
                // 命中条数：0 说明这条规则本来就没了，>1 说明过滤器比想象中宽。
                item.matched = receipt.matched.len();
                if item.ok && item.matched == 0 {
                    // 服务端回的「没命中」是真的，但空回执本身证明不了它属于哪条请求。
                    item.message = "集群上找不到这条规则（可能刚被别人删过）".to_owned();
                }
                item
            }
            // 找不到能对上的回执：服务端没回，或回执条数与请求对不上。
            // 两种都说「刷新确认」，绝不编一个「已删除」。
            None => {
                let mut item = outcome_of(entry, None, "删除");
                item.ok = false;
                item.matched = 0;
                item.message =
                    "服务端没有返回这条规则的结果（回执条数与请求不一致），请刷新确认".to_owned();
                item
            }
        })
        .collect()
}

/// 一条删除回执：过滤器的错误、命中的 ACL、以及命中的条数。
struct DeleteReceipt<'a> {
    error: Option<*const bindings::rd_kafka_error_t>,
    matched: Vec<AclEntry>,
    _marker: std::marker::PhantomData<&'a ()>,
}

impl DeleteReceipt<'_> {
    /// 这条回执是不是由 `entry` 构造的那个过滤器产生的。
    ///
    /// 不能按 binding 逐字比：回执里装的是**命中的 ACL**，前缀规则命中的是
    /// 具体主题，名字天然不相等。判据必须是「过滤器覆盖了命中项」。
    fn covers(&self, entry: &AclEntry) -> bool {
        self.matched
            .iter()
            .all(|hit| crate::domain::acl::filter_matches(entry, hit))
    }
}

/// 读出全部删除回执。命中清单在事件销毁后就不在了，所以先把它们抄成自己的结构。
///
/// # Safety
///
/// `responses` 必须是 `rd_kafka_DeleteAcls_result_responses` 返回的数组，
/// 且长度不小于 `count`。
unsafe fn delete_receipts<'a>(
    responses: *mut *const bindings::rd_kafka_DeleteAcls_result_response_t,
    count: usize,
) -> Vec<DeleteReceipt<'a>> {
    if responses.is_null() {
        return Vec::new();
    }
    let mut receipts = Vec::with_capacity(count);
    for index in 0..count {
        let response = unsafe { *responses.add(index) };
        if response.is_null() {
            continue;
        }
        let error = unsafe { bindings::rd_kafka_DeleteAcls_result_response_error(response) };
        let mut matched_count: usize = 0;
        let list = unsafe {
            bindings::rd_kafka_DeleteAcls_result_response_matching_acls(
                response,
                &mut matched_count,
            )
        };
        let mut matched = Vec::with_capacity(matched_count);
        for hit in 0..matched_count {
            let binding = unsafe { *list.add(hit) };
            if binding.is_null() {
                continue;
            }
            if let Some(entry) = unsafe { to_entry(binding) } {
                matched.push(entry);
            }
        }
        receipts.push(DeleteReceipt {
            error: (!error.is_null()).then_some(error),
            matched,
            _marker: std::marker::PhantomData,
        });
    }
    receipts
}

/// 组装一条规则的 binding。写路径必须带真实名字（通配写 `*`），不能像过滤器那样留空。
fn binding_of(entry: &AclEntry) -> AppResult<*mut bindings::rd_kafka_AclBinding_t> {
    let name = CString::new(resource_name_for_write(entry))
        .map_err(|_| AppError::Invalid("资源名里不能包含 NUL 字符".to_owned()))?;
    let principal = CString::new(entry.principal.clone())
        .map_err(|_| AppError::Invalid("主体里不能包含 NUL 字符".to_owned()))?;
    let host = CString::new(entry.host.clone())
        .map_err(|_| AppError::Invalid("来源主机里不能包含 NUL 字符".to_owned()))?;
    let mut errbuf = [0i8; 256];
    let ptr = unsafe {
        bindings::rd_kafka_AclBinding_new(
            to_restype(entry.resource_type),
            name.as_ptr(),
            to_pattern(entry.pattern),
            principal.as_ptr(),
            host.as_ptr(),
            to_operation(entry.operation),
            to_permission(entry.permission),
            errbuf.as_mut_ptr(),
            errbuf.len(),
        )
    };
    if ptr.is_null() {
        return Err(AppError::Invalid(format!(
            "规则参数不合法：{}",
            unsafe { c_string(errbuf.as_ptr()) }.unwrap_or_default()
        )));
    }
    Ok(ptr)
}

/// 组装一条精确匹配的过滤器。每一位都必须由规则本身给定 —— 留空就是「这一类都要删」。
fn filter_of(entry: &AclEntry) -> AppResult<*mut bindings::rd_kafka_AclBindingFilter_t> {
    let name = CString::new(resource_name_for_write(entry))
        .map_err(|_| AppError::Invalid("资源名里不能包含 NUL 字符".to_owned()))?;
    let principal = CString::new(entry.principal.clone())
        .map_err(|_| AppError::Invalid("主体里不能包含 NUL 字符".to_owned()))?;
    let host = CString::new(entry.host.clone())
        .map_err(|_| AppError::Invalid("来源主机里不能包含 NUL 字符".to_owned()))?;
    let mut errbuf = [0i8; 256];
    let ptr = unsafe {
        bindings::rd_kafka_AclBindingFilter_new(
            to_restype(entry.resource_type),
            name.as_ptr(),
            to_pattern(entry.pattern),
            principal.as_ptr(),
            host.as_ptr(),
            to_operation(entry.operation),
            to_permission(entry.permission),
            errbuf.as_mut_ptr(),
            errbuf.len(),
        )
    };
    if ptr.is_null() {
        return Err(AppError::Invalid(format!(
            "过滤条件不合法：{}",
            unsafe { c_string(errbuf.as_ptr()) }.unwrap_or_default()
        )));
    }
    Ok(ptr)
}

/// 写路径里的资源名：通配在 Kafka 里就是字面量 `*`。
fn resource_name_for_write(entry: &AclEntry) -> String {
    if entry.pattern == AclPattern::Wildcard {
        "*".to_owned()
    } else {
        entry.resource_name.clone()
    }
}

fn to_pattern(pattern: AclPattern) -> bindings::rd_kafka_ResourcePatternType_t {
    match pattern {
        // 通配在 Kafka 里是「精确匹配 + 名字 `*`」，不是 `MATCH`/`ANY` 这类过滤值。
        AclPattern::Literal | AclPattern::Wildcard => {
            bindings::rd_kafka_ResourcePatternType_t::RD_KAFKA_RESOURCE_PATTERN_LITERAL
        }
        AclPattern::Prefixed => {
            bindings::rd_kafka_ResourcePatternType_t::RD_KAFKA_RESOURCE_PATTERN_PREFIXED
        }
    }
}

fn to_permission(permission: AclPermission) -> bindings::rd_kafka_AclPermissionType_t {
    match permission {
        AclPermission::Allow => {
            bindings::rd_kafka_AclPermissionType_t::RD_KAFKA_ACL_PERMISSION_TYPE_ALLOW
        }
        AclPermission::Deny => {
            bindings::rd_kafka_AclPermissionType_t::RD_KAFKA_ACL_PERMISSION_TYPE_DENY
        }
    }
}

/// 轮询结果事件。超时不说「成功」，也不说「失败」—— 它只说明「不知道」。
///
/// 返回值**已经**是守卫：调用方拿到它的那一刻起，任何一条退出路径都会销毁事件。
/// 早先这里是「返回裸指针、由调用方包守卫」，而调用方习惯先判错再造守卫 ——
/// 权限不足、broker 不支持这两条最常见路径上，事件就这样漏了。
fn poll(queue: &QueueGuard, action: &str) -> AppResult<EventGuard> {
    let event = unsafe { bindings::rd_kafka_queue_poll(queue.0, ACL_TIMEOUT.as_millis() as c_int) };
    if event.is_null() {
        return Err(AppError::Broker(format!(
            "等待「{action}」结果超时（{} 秒）：请求可能已经发出，刷新一次再决定要不要重试",
            ACL_TIMEOUT.as_secs()
        )));
    }
    Ok(EventGuard(event))
}

/// 把单条回执翻成一句人能读懂的话。
fn outcome_of(
    entry: &AclEntry,
    error: Option<*const bindings::rd_kafka_error_t>,
    action: &str,
) -> AclWriteOutcome {
    let message = error.map(|error| unsafe {
        let code = bindings::rd_kafka_error_code(error);
        let text = c_string(bindings::rd_kafka_error_string(error)).unwrap_or_default();
        if text.is_empty() {
            format!("{code:?}")
        } else {
            text
        }
    });
    match message {
        None => AclWriteOutcome {
            entry: entry.clone(),
            ok: true,
            message: format!("已{action}"),
            matched: 1,
        },
        Some(message) => {
            // 权限不足的下一步动作是「给自己加一条 ALTER」，不是「换个版本」。
            let message = if is_forbidden(&message) {
                format!("没有{action} ACL 的权限：需要集群级的 ALTER 授权。{message}")
            } else if is_unsupported(&message) {
                format!("这台 broker 不支持{action} ACL（需要 2.0 以上且配置授权器）：{message}")
            } else {
                message
            };
            AclWriteOutcome {
                entry: entry.clone(),
                ok: false,
                message,
                matched: 0,
            }
        }
    }
}

/// 一条规则的执行结果。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AclWriteOutcome {
    pub entry: AclEntry,
    pub ok: bool,
    pub message: String,
    /// 删除时实际命中的条数。`0` 说明这条规则本来就不在集群上。
    #[serde(default)]
    pub matched: usize,
}

/// binding 数组的所有权守卫：请求发出去之前失败要自己释放，发出去之后交给 librdkafka。
///
/// `AclBindingFilter` 在 C 侧就是 `AclBinding` 的别名，释放接口也是同一个 ——
/// 所以两种指针都收进同一个守卫，不写两遍。
struct BindingList(Vec<*mut bindings::rd_kafka_AclBinding_t>);

impl Drop for BindingList {
    fn drop(&mut self) {
        if self.0.is_empty() {
            return;
        }
        unsafe {
            bindings::rd_kafka_AclBinding_destroy_array(self.0.as_mut_ptr(), self.0.len());
        }
    }
}

/// 结果队列的销毁守卫。
struct QueueGuard(*mut bindings::rd_kafka_queue_t);

impl Drop for QueueGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { bindings::rd_kafka_queue_destroy(self.0) };
        }
    }
}

/// 事件归调用方所有，解析完必须销毁。
struct EventGuard(*mut bindings::rd_kafka_event_t);

impl Drop for EventGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { bindings::rd_kafka_event_destroy(self.0) };
        }
    }
}

/// 过滤器对象；`DescribeAcls` 会拿走它的所有权，但失败路径上仍要释放，
/// 所以这里只在「请求没发出去」时负责销毁 —— 发出去之后由 librdkafka 接管。
struct FilterGuard(*mut bindings::rd_kafka_AclBindingFilter_t);

impl FilterGuard {
    fn new(filter: &AclFilter) -> AppResult<Self> {
        let restype = match filter.resource_type {
            Some(kind) => to_restype(kind),
            // `ANY` 是「这一类不过滤」。与「没有实体」是两件事：
            // 传 UNKNOWN 会让服务端回一个错误码，看起来像集群坏了。
            None => bindings::rd_kafka_ResourceType_t::RD_KAFKA_RESOURCE_ANY,
        };
        let name = optional_cstring(filter.resource_name.as_deref())?;
        let principal = optional_cstring(filter.principal.as_deref())?;
        let operation = match filter.operation {
            Some(operation) => to_operation(operation),
            None => bindings::rd_kafka_AclOperation_t::RD_KAFKA_ACL_OPERATION_ANY,
        };
        let permission = match filter.permission {
            Some(AclPermission::Allow) => {
                bindings::rd_kafka_AclPermissionType_t::RD_KAFKA_ACL_PERMISSION_TYPE_ALLOW
            }
            Some(AclPermission::Deny) => {
                bindings::rd_kafka_AclPermissionType_t::RD_KAFKA_ACL_PERMISSION_TYPE_DENY
            }
            None => bindings::rd_kafka_AclPermissionType_t::RD_KAFKA_ACL_PERMISSION_TYPE_ANY,
        };

        let ptr = unsafe {
            bindings::rd_kafka_AclBindingFilter_new(
                restype,
                name.as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                bindings::rd_kafka_ResourcePatternType_t::RD_KAFKA_RESOURCE_PATTERN_ANY,
                principal
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                // host 不筛：界面上没人按 IP 搜索，筛它只会让人困惑「为什么搜不到」。
                std::ptr::null(),
                operation,
                permission,
                std::ptr::null_mut(),
                0,
            )
        };
        if ptr.is_null() {
            return Err(AppError::Invalid("ACL 过滤器参数不合法".to_owned()));
        }
        Ok(Self(ptr))
    }
}

impl FilterGuard {
    /// 标记「请求已发出，对象不再归我」。不置空就会二次释放 ——
    /// `rd_kafka_DescribeAcls` 内部会 copy 过滤器，原对象仍归调用方。
    fn release(&mut self) {
        self.0 = std::ptr::null_mut();
    }
}

impl Drop for FilterGuard {
    fn drop(&mut self) {
        // 只有「请求没发出去」时这个指针还归我。
        if !self.0.is_null() {
            unsafe { bindings::rd_kafka_AclBinding_destroy(self.0) };
        }
    }
}

/// 管理选项：默认即可，但必须显式创建一个再销毁，不能传 NULL 假装「默认」——
/// NULL 在部分版本上等于「用 client 的默认 socket.timeout」，行为随配置漂移。
struct OptionsGuard(*mut bindings::rd_kafka_AdminOptions_t);

impl OptionsGuard {
    fn new(rk: *mut bindings::rd_kafka_t, op: bindings::rd_kafka_admin_op_t) -> AppResult<Self> {
        let ptr = unsafe { bindings::rd_kafka_AdminOptions_new(rk, op) };
        if ptr.is_null() {
            return Err(AppError::Internal("创建 Kafka 管理选项失败".to_owned()));
        }
        Ok(Self(ptr))
    }
}

impl Drop for OptionsGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { bindings::rd_kafka_AdminOptions_destroy(self.0) };
        }
    }
}

/// # Safety
///
/// `event` 必须是 `DescribeAcls` 产生且仍然有效的事件。
unsafe fn collect(event: *mut bindings::rd_kafka_event_t) -> Vec<AclEntry> {
    let result = unsafe { bindings::rd_kafka_event_DescribeAcls_result(event) };
    if result.is_null() {
        return Vec::new();
    }
    let mut count: usize = 0;
    let array = unsafe { bindings::rd_kafka_DescribeAcls_result_acls(result, &mut count) };
    if array.is_null() {
        return Vec::new();
    }

    let mut entries = Vec::with_capacity(count);
    for index in 0..count {
        let binding = unsafe { *array.add(index) };
        if binding.is_null() {
            continue;
        }
        // 单条带错误时跳过：服务端把「这条读不出来」和「这条不存在」分开表达，
        // 混进表格会让一条坏规则显示成一条好规则。整表作废则太狠。
        let error = unsafe { bindings::rd_kafka_AclBinding_error(binding) };
        if !error.is_null()
            && unsafe { bindings::rd_kafka_error_code(error) }
                != rd_kafka_resp_err_t::RD_KAFKA_RESP_ERR_NO_ERROR
        {
            continue;
        }
        if let Some(entry) = unsafe { to_entry(binding) } {
            entries.push(entry);
        }
    }
    entries
}

/// # Safety
///
/// `binding` 必须是有效的 `rd_kafka_AclBinding_t`。
unsafe fn to_entry(binding: *const bindings::rd_kafka_AclBinding_t) -> Option<AclEntry> {
    let resource_type = from_restype(unsafe { bindings::rd_kafka_AclBinding_restype(binding) })?;
    let raw_name =
        unsafe { c_string(bindings::rd_kafka_AclBinding_name(binding)) }.unwrap_or_default();
    let principal =
        unsafe { c_string(bindings::rd_kafka_AclBinding_principal(binding)) }.unwrap_or_default();
    let host = unsafe { c_string(bindings::rd_kafka_AclBinding_host(binding)) }
        .unwrap_or_else(|| "*".to_owned());
    let operation = from_operation(unsafe { bindings::rd_kafka_AclBinding_operation(binding) })?;
    let permission = match unsafe { bindings::rd_kafka_AclBinding_permission_type(binding) } {
        bindings::rd_kafka_AclPermissionType_t::RD_KAFKA_ACL_PERMISSION_TYPE_ALLOW => {
            AclPermission::Allow
        }
        bindings::rd_kafka_AclPermissionType_t::RD_KAFKA_ACL_PERMISSION_TYPE_DENY => {
            AclPermission::Deny
        }
        // `ANY` / `UNKNOWN` 出现在结果里说明服务端或客户端有 bug。
        // 猜成「允许」会让一条看不出权限的规则看起来是放行的，直接跳过。
        _ => return None,
    };
    let pattern = match unsafe { bindings::rd_kafka_AclBinding_resource_pattern_type(binding) } {
        bindings::rd_kafka_ResourcePatternType_t::RD_KAFKA_RESOURCE_PATTERN_PREFIXED => {
            AclPattern::Prefixed
        }
        _ => AclPattern::Literal,
    };

    // Kafka 用「精确匹配 + 名字 `*`」表示通配。拆开后「全部资源」与
    // 「一个叫 * 的主题」才不会混成一个 —— 后者是合法主题名。
    let (resource_name, pattern) = if pattern == AclPattern::Literal && raw_name == "*" {
        (String::new(), AclPattern::Wildcard)
    } else {
        (raw_name, pattern)
    };

    Some(AclEntry {
        resource_type,
        resource_name,
        pattern,
        principal,
        host,
        operation,
        permission,
    })
}

fn to_restype(kind: AclResourceType) -> bindings::rd_kafka_ResourceType_t {
    match kind {
        AclResourceType::Topic => bindings::rd_kafka_ResourceType_t::RD_KAFKA_RESOURCE_TOPIC,
        AclResourceType::Group => bindings::rd_kafka_ResourceType_t::RD_KAFKA_RESOURCE_GROUP,
        AclResourceType::Cluster => bindings::rd_kafka_ResourceType_t::RD_KAFKA_RESOURCE_BROKER,
        // `BROKER` 在 Kafka 协议里就是集群级资源的载体；librdkafka 的枚举没有单独的
        // `CLUSTER`，`DESCRIBE` 一条 `BROKER / kafka-cluster` 才是集群规则。
        AclResourceType::Broker => bindings::rd_kafka_ResourceType_t::RD_KAFKA_RESOURCE_BROKER,
    }
}

fn from_restype(kind: bindings::rd_kafka_ResourceType_t) -> Option<AclResourceType> {
    match kind {
        bindings::rd_kafka_ResourceType_t::RD_KAFKA_RESOURCE_TOPIC => Some(AclResourceType::Topic),
        bindings::rd_kafka_ResourceType_t::RD_KAFKA_RESOURCE_GROUP => Some(AclResourceType::Group),
        bindings::rd_kafka_ResourceType_t::RD_KAFKA_RESOURCE_BROKER => {
            Some(AclResourceType::Broker)
        }
        // 事务 ID 等少见类型不在这块面板的范围里，跳过比显示成「Broker」诚实。
        _ => None,
    }
}

fn to_operation(operation: AclOperation) -> bindings::rd_kafka_AclOperation_t {
    use bindings::rd_kafka_AclOperation_t as Op;
    match operation {
        AclOperation::All => Op::RD_KAFKA_ACL_OPERATION_ALL,
        AclOperation::Read => Op::RD_KAFKA_ACL_OPERATION_READ,
        AclOperation::Write => Op::RD_KAFKA_ACL_OPERATION_WRITE,
        AclOperation::Create => Op::RD_KAFKA_ACL_OPERATION_CREATE,
        AclOperation::Delete => Op::RD_KAFKA_ACL_OPERATION_DELETE,
        AclOperation::Alter => Op::RD_KAFKA_ACL_OPERATION_ALTER,
        AclOperation::Describe => Op::RD_KAFKA_ACL_OPERATION_DESCRIBE,
        AclOperation::DescribeConfigs => Op::RD_KAFKA_ACL_OPERATION_DESCRIBE_CONFIGS,
        AclOperation::AlterConfigs => Op::RD_KAFKA_ACL_OPERATION_ALTER_CONFIGS,
        AclOperation::ClusterAction => Op::RD_KAFKA_ACL_OPERATION_CLUSTER_ACTION,
        AclOperation::IdempotentWrite => Op::RD_KAFKA_ACL_OPERATION_IDEMPOTENT_WRITE,
    }
}

fn from_operation(operation: bindings::rd_kafka_AclOperation_t) -> Option<AclOperation> {
    use bindings::rd_kafka_AclOperation_t as Op;
    match operation {
        Op::RD_KAFKA_ACL_OPERATION_ALL => Some(AclOperation::All),
        Op::RD_KAFKA_ACL_OPERATION_READ => Some(AclOperation::Read),
        Op::RD_KAFKA_ACL_OPERATION_WRITE => Some(AclOperation::Write),
        Op::RD_KAFKA_ACL_OPERATION_CREATE => Some(AclOperation::Create),
        Op::RD_KAFKA_ACL_OPERATION_DELETE => Some(AclOperation::Delete),
        Op::RD_KAFKA_ACL_OPERATION_ALTER => Some(AclOperation::Alter),
        Op::RD_KAFKA_ACL_OPERATION_DESCRIBE => Some(AclOperation::Describe),
        Op::RD_KAFKA_ACL_OPERATION_DESCRIBE_CONFIGS => Some(AclOperation::DescribeConfigs),
        Op::RD_KAFKA_ACL_OPERATION_ALTER_CONFIGS => Some(AclOperation::AlterConfigs),
        Op::RD_KAFKA_ACL_OPERATION_CLUSTER_ACTION => Some(AclOperation::ClusterAction),
        Op::RD_KAFKA_ACL_OPERATION_IDEMPOTENT_WRITE => Some(AclOperation::IdempotentWrite),
        _ => None,
    }
}

/// 可选字符串：`None` 传空指针（不过滤），`Some("")` 才是「名字为空」。
fn optional_cstring(value: Option<&str>) -> AppResult<Option<CString>> {
    let Some(value) = value else {
        return Ok(None);
    };
    CString::new(value)
        .map(Some)
        .map_err(|_| AppError::Invalid("ACL 过滤条件里不能包含 NUL 字符".to_owned()))
}

/// # Safety
///
/// `raw` 要么为空，要么是有效的 NUL 结尾字符串。
unsafe fn c_string(raw: *const c_char) -> Option<String> {
    if raw.is_null() {
        return None;
    }
    Some(
        unsafe { CStr::from_ptr(raw) }
            .to_string_lossy()
            .into_owned(),
    )
}

/// 判断错误串是不是「broker 不认识这个 API / 没开授权」。
///
/// 按关键词而不是错误码：拿到这里时已经是字符串，码在翻译过程中丢了。
fn is_unsupported(message: &str) -> bool {
    let lowered = message.to_lowercase();
    lowered.contains("unsupported")
        || lowered.contains("not supported")
        || lowered.contains("security disabled")
}

/// 授权失败单独说：它的下一步动作是「给自己加 DESCRIBE」，不是「换版本」。
fn is_forbidden(message: &str) -> bool {
    let lowered = message.to_lowercase();
    lowered.contains("authorization failed")
        || lowered.contains("cluster authorization")
        || lowered.contains("topic authorization")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_messages_are_recognised() {
        assert!(is_unsupported("Unsupported version of API DescribeAcls"));
        assert!(is_unsupported("Broker: Security disabled"));
        assert!(!is_forbidden("Broker: Security disabled"));
    }

    #[test]
    fn authorization_failures_are_separated_from_version_issues() {
        assert!(is_forbidden(
            "Cluster authorization failed: not authorized to access cluster"
        ));
        assert!(!is_unsupported("Cluster authorization failed"));
    }

    #[test]
    fn optional_cstring_distinguishes_none_from_empty() {
        assert!(optional_cstring(None).unwrap().is_none());
        // Some("") 是「名字为空」的过滤条件，不能被当成「不过滤」。
        assert_eq!(
            optional_cstring(Some(""))
                .unwrap()
                .unwrap()
                .to_str()
                .unwrap(),
            ""
        );
    }

    #[test]
    fn nul_byte_in_filter_is_rejected() {
        assert!(optional_cstring(Some("a\0b")).is_err());
    }

    #[test]
    fn operation_round_trips() {
        for operation in [
            AclOperation::All,
            AclOperation::Read,
            AclOperation::Write,
            AclOperation::Create,
            AclOperation::Delete,
            AclOperation::Alter,
            AclOperation::Describe,
            AclOperation::DescribeConfigs,
            AclOperation::AlterConfigs,
            AclOperation::ClusterAction,
            AclOperation::IdempotentWrite,
        ] {
            assert_eq!(from_operation(to_operation(operation)), Some(operation));
        }
    }

    fn entry(name: &str, pattern: AclPattern, operation: AclOperation) -> AclEntry {
        AclEntry {
            resource_type: AclResourceType::Topic,
            resource_name: name.to_owned(),
            pattern,
            principal: "User:alice".to_owned(),
            host: "*".to_owned(),
            operation,
            permission: AclPermission::Allow,
        }
    }

    fn receipt(matched: Vec<AclEntry>) -> DeleteReceipt<'static> {
        DeleteReceipt {
            error: None,
            matched,
            _marker: std::marker::PhantomData,
        }
    }

    #[test]
    fn wildcard_name_does_not_match_literal_star_topic() {
        // 通配在 Kafka 里存盘是「精确匹配 + 名字 `*`」，所以删通配时服务端回的
        // 命中项名字就是 `*` —— 这里必须认出来，否则每次删通配都报「回执不一致」。
        let wildcard = entry("", AclPattern::Wildcard, AclOperation::Read);
        let literal_star = entry("*", AclPattern::Literal, AclOperation::Read);
        assert!(crate::domain::acl::filter_matches(&wildcard, &literal_star));
        // 反过来不成立：删一条叫 `orders` 的规则，命中项绝不会是通配。
        let orders = entry("orders", AclPattern::Literal, AclOperation::Read);
        assert!(!crate::domain::acl::filter_matches(&orders, &wildcard));
        // 通配主体 / `All` 操作也是覆盖关系，不是相等关系。
        let everyone = AclEntry {
            principal: "User:*".to_owned(),
            operation: AclOperation::All,
            ..wildcard.clone()
        };
        assert!(crate::domain::acl::filter_matches(
            &everyone,
            &entry("orders", AclPattern::Literal, AclOperation::Read)
        ));
    }

    #[test]
    fn receipts_are_matched_by_content_not_by_position() {
        // 服务端回执顺序与请求顺序不一致时，按下标对齐会把 A 的命中数安到 B 头上。
        let a = entry("orders", AclPattern::Literal, AclOperation::Read);
        let b = entry("payments", AclPattern::Literal, AclOperation::Write);
        let receipts = [receipt(vec![b.clone()]), receipt(vec![a.clone()])];
        let outcomes = match_delete_receipts(&[a, b], &receipts);
        assert!(outcomes.iter().all(|item| item.ok));
        assert_eq!(outcomes[0].matched, 1);
        assert_eq!(outcomes[1].matched, 1);
    }

    #[test]
    fn prefixed_delete_receipt_matches_the_concrete_hits() {
        // 前缀规则的过滤器命中的是具体主题，名字与请求天然不相等 ——
        // 按 binding 逐字比会得出「回执不一致」，而这其实是一次成功的删除。
        let prefixed = entry("payments-", AclPattern::Prefixed, AclOperation::Read);
        let receipts = [receipt(vec![
            entry("payments-orders", AclPattern::Literal, AclOperation::Read),
            entry("payments-refunds", AclPattern::Literal, AclOperation::Read),
        ])];
        let outcomes = match_delete_receipts(&[prefixed], &receipts);
        assert!(outcomes[0].ok);
        assert_eq!(outcomes[0].matched, 2);
    }

    #[test]
    fn empty_success_receipts_are_not_claimed_by_content() {
        // 空回执「对得上任何请求」。按内容认领会把它安给第一条规则，
        // 后面那条真正命中的回执反而无处可去。
        let gone = entry("gone", AclPattern::Literal, AclOperation::Read);
        let live = entry("live", AclPattern::Literal, AclOperation::Read);
        let receipts = [
            receipt(Vec::new()),
            receipt(vec![entry("live", AclPattern::Literal, AclOperation::Read)]),
        ];
        let outcomes = match_delete_receipts(&[gone, live], &receipts);
        assert!(outcomes.iter().all(|item| item.ok));
        // 命中为 0 的那条要说「本来就没了」，不能说「已删除」。
        assert_eq!(outcomes[0].matched, 0);
        assert!(outcomes[0].message.contains("找不到"));
        assert_eq!(outcomes[1].matched, 1);
        assert_eq!(outcomes[1].message, "已删除");
    }

    #[test]
    fn a_receipt_that_matches_nothing_leaves_the_request_unclaimed() {
        // 回执内容对不上任何请求：不能编一个「已删除」，只能说刷新确认。
        let wanted = entry("orders", AclPattern::Literal, AclOperation::Read);
        let receipts = [receipt(vec![entry(
            "somebody-elses",
            AclPattern::Literal,
            AclOperation::Read,
        )])];
        let outcomes = match_delete_receipts(&[wanted], &receipts);
        assert!(!outcomes[0].ok);
        assert!(outcomes[0].message.contains("刷新确认"));
    }

    #[test]
    fn any_operation_is_not_a_real_operation() {
        // `ANY` 只用于过滤，出现在结果里说明有问题 —— 不能猜成 `All`。
        assert_eq!(
            from_operation(bindings::rd_kafka_AclOperation_t::RD_KAFKA_ACL_OPERATION_ANY),
            None
        );
    }
}
