/**
 * 成员分区归属的排版：纯函数，不发请求。
 *
 * 这一段要回答的是「滞后压在谁身上」，所以每个数字都必须指得清是哪个分区：
 * 只说「4 个分区」等于把刚看懂的那张滞后表又推回原点。
 *
 * 三种「没有分区」必须分开说 —— 合并成一句「暂无」就是在把「读不懂」
 * 和「真的没有」讲成同一件事。
 */

import type {
  AssignedPartition,
  GroupAssignment,
  MemberAssignment,
} from "../types/group-assignment.ts";
import type { ConsumerGroupOffset } from "../types/consumer.ts";
import type { Tone } from "../types/tone.ts";

/** 分区标识，`topic-P3`。与后端 `AssignedPartition::label` 同一口径。 */
export function partitionLabel(item: AssignedPartition): string {
  return `${item.topic}-P${item.partition}`;
}

/** 一个成员的分区列表；超过 `limit` 个只列前几个。 */
export function partitionsText(
  partitions: AssignedPartition[],
  limit = 6,
): string {
  if (!partitions.length) return "";
  const shown = partitions.slice(0, limit).map(partitionLabel).join("、");
  const rest = partitions.length - limit;
  return rest > 0 ? `${shown} 等 ${partitions.length} 个` : shown;
}

/** 成员一栏的措辞：三种「没有分区」分开说。 */
export function memberAssignmentText(entry: MemberAssignment): string {
  if (entry.state === "broken") return "归属未知（分配读不懂）";
  if (entry.state === "empty") return "暂未分到分区";
  return partitionsText(entry.partitions);
}

/** 成员一栏的语气：读不懂要看得见，暂未分到是常态。 */
export function memberAssignmentTone(entry: MemberAssignment): Tone {
  if (entry.state === "broken") return "warning";
  if (entry.state === "empty") return "neutral";
  return "success";
}

/** 一个分区归谁。 */
export interface PartitionOwner {
  topic: string;
  partition: number;
  /** 负责它的成员；无人认领时为 `null`。 */
  owners: string[];
}

/** 把「成员 → 分区」翻成「分区 → 成员」，并按 `(topic, partition)` 排序。 */
export function ownersByPartition(
  assignment: GroupAssignment | undefined,
): PartitionOwner[] {
  const map = new Map<string, PartitionOwner>();
  for (const entry of assignment?.byMember ?? []) {
    for (const partition of entry.partitions) {
      const key = partitionLabel(partition);
      const found = map.get(key);
      if (found) {
        if (!found.owners.includes(entry.memberId))
          found.owners.push(entry.memberId);
      } else {
        map.set(key, {
          topic: partition.topic,
          partition: partition.partition,
          owners: [entry.memberId],
        });
      }
    }
  }
  return [...map.values()].sort(
    (a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition,
  );
}

/**
 * 没有任何成员负责的分区。
 *
 * 只拿「组当前提交过位点的分区」去比对：组没提交过位点的分区可能是它从没订阅的
 * 主题，那不算无主 —— 报出来只会制造一批假警报。
 */
export function unownedPartitions(
  assignment: GroupAssignment | undefined,
  offsets: ConsumerGroupOffset[],
): ConsumerGroupOffset[] {
  if (!assignment) return [];
  const owned = new Set(
    (assignment.byMember ?? []).flatMap((entry) =>
      entry.partitions.map(partitionLabel),
    ),
  );
  return offsets.filter(
    (offset) => !owned.has(`${offset.topic}-P${offset.partition}`),
  );
}

/**
 * 归属的总体结论。
 *
 * 一句话，而且必须带上「为什么」：只说「6 个分区无主」会让人去改分区分配，
 * 而真实原因往往只是一个成员正在再均衡。
 */
export function assignmentVerdict(
  assignment: GroupAssignment | undefined,
  offsets: ConsumerGroupOffset[],
): { text: string; tone: Tone } | undefined {
  if (!assignment) return undefined;

  const notes = assignment.notes ?? [];
  const members = assignment.byMember ?? [];
  // 协议不适用（Connect / 事务协调器）时没有成员记录，只有一条说明。
  if (!members.length && notes.length) {
    return { text: notes[0], tone: "neutral" };
  }

  const broken = members.filter((entry) => entry.state === "broken");
  if (broken.length) {
    return {
      text: `${broken.length} 个成员的分配读不懂，这些成员的分区归属未知 —— 不是「没有分区」`,
      tone: "warning",
    };
  }

  const unowned = unownedPartitions(assignment, offsets);
  if (!unowned.length) {
    return { text: "每个已提交位点的分区都有成员负责", tone: "success" };
  }
  return {
    text: `${unowned.length} 个分区没有成员负责：可能是正在再均衡，也可能消费者少到覆盖不了所有分区`,
    tone: "warning",
  };
}

/** 无主分区的标识，给提示条下面那行用。 */
export function unownedText(offsets: ConsumerGroupOffset[], limit = 5): string {
  const labels = offsets
    .slice(0, limit)
    .map((offset) => `${offset.topic}-P${offset.partition}`);
  const rest = offsets.length - limit;
  return rest > 0
    ? `${labels.join("、")} 等 ${offsets.length} 个`
    : labels.join("、");
}
