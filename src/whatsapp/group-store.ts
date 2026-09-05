import { sql } from '@/db/client';
import { logger } from '@/logger';

type GroupMeta = {
  id: string;
  subject?: string;
  creation?: number;
  owner?: string | null;
  desc?: string | null;
  descId?: string | null;
  restrict?: boolean;
  announce?: boolean;
  ephemeralDuration?: number | null;
  isCommunity?: boolean;
  isParentGroup?: boolean;
  parentGroupId?: string | null;
  participants?: { id?: string; admin?: string | null }[];
  inviteCode?: string | null;
  memberAddMode?: boolean;
  joinApprovalMode?: boolean;
  descOwner?: string | null;
  subjectOwner?: string | null;
  subjectTime?: number | null;
};

export async function saveGroup(meta: GroupMeta): Promise<void> {
  if (!meta.id) return;
  await sql`
    INSERT INTO whatsapp_groups (
      group_id, subject, creation, owner, description, description_id,
      is_restricted, announce, ephemeral_duration, is_community, is_parent_group,
      parent_group_id, participant_count, invite_code, member_add_mode,
      join_approval_mode, desc_owner, subject_owner, subject_time
    ) VALUES (
      ${meta.id}, ${meta.subject ?? null}, ${meta.creation ?? null},
      ${meta.owner ?? null}, ${meta.desc ?? null}, ${meta.descId ?? null},
      ${!!meta.restrict}, ${!!meta.announce}, ${meta.ephemeralDuration ?? null},
      ${!!meta.isCommunity}, ${!!meta.isParentGroup}, ${meta.parentGroupId ?? null},
      ${meta.participants?.length ?? 0}, ${meta.inviteCode ?? null},
      ${!!meta.memberAddMode}, ${!!meta.joinApprovalMode},
      ${meta.descOwner ?? null}, ${meta.subjectOwner ?? null}, ${meta.subjectTime ?? null}
    )
    ON CONFLICT (group_id) DO UPDATE SET
      subject = COALESCE(excluded.subject, whatsapp_groups.subject),
      owner = COALESCE(excluded.owner, whatsapp_groups.owner),
      description = COALESCE(excluded.description, whatsapp_groups.description),
      is_restricted = excluded.is_restricted,
      announce = excluded.announce,
      ephemeral_duration = COALESCE(excluded.ephemeral_duration, whatsapp_groups.ephemeral_duration),
      is_community = COALESCE(excluded.is_community, whatsapp_groups.is_community),
      parent_group_id = COALESCE(excluded.parent_group_id, whatsapp_groups.parent_group_id),
      participant_count = excluded.participant_count,
      invite_code = COALESCE(excluded.invite_code, whatsapp_groups.invite_code),
      member_add_mode = COALESCE(excluded.member_add_mode, whatsapp_groups.member_add_mode),
      join_approval_mode = COALESCE(excluded.join_approval_mode, whatsapp_groups.join_approval_mode),
      desc_owner = COALESCE(excluded.desc_owner, whatsapp_groups.desc_owner),
      subject_owner = COALESCE(excluded.subject_owner, whatsapp_groups.subject_owner),
      subject_time = COALESCE(excluded.subject_time, whatsapp_groups.subject_time),
      last_updated = now()
  `;
  await saveGroupParticipants(meta);
}

export async function saveGroupParticipants(meta: GroupMeta): Promise<void> {
  const parts = meta.participants ?? [];
  await sql.begin(async (tx) => {
    await tx`DELETE FROM group_participants WHERE group_id = ${meta.id}`;
    for (const p of parts) {
      if (!p.id) continue;
      await tx`
        INSERT INTO group_participants (group_id, participant_id, admin_level)
        VALUES (${meta.id}, ${p.id}, ${p.admin ?? null})
        ON CONFLICT (group_id, participant_id) DO UPDATE
          SET admin_level = excluded.admin_level
      `;
    }
  });
}

export async function listGroups(): Promise<Record<string, unknown>[]> {
  return sql<Record<string, unknown>[]>`
    SELECT * FROM whatsapp_groups ORDER BY subject ASC NULLS LAST
  `;
}

export async function getGroup(
  id: string,
): Promise<Record<string, unknown> | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM whatsapp_groups WHERE group_id = ${id} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listGroupParticipants(
  id: string,
): Promise<Record<string, unknown>[]> {
  return sql<Record<string, unknown>[]>`
    SELECT gp.participant_id AS jid, gp.admin_level, c.name, c.avatar_url
    FROM group_participants gp
    LEFT JOIN contacts c ON c.jid = gp.participant_id
    WHERE gp.group_id = ${id}
    ORDER BY gp.joined_at ASC
  `;
}

export const saveGroupSafe = (meta: GroupMeta) =>
  saveGroup(meta).catch((err) =>
    logger.debug({ err, id: meta.id }, '[groups] save failed'),
  );
