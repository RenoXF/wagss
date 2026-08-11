import { sql } from '@/db/client';

export interface ContactRow {
  jid: string;
  name: string | null;
  phone: string | null;
  is_group: boolean;
  avatar_url: string | null;
  last_seen: Date | null;
  updated_at: Date;
  notify: string | null;
  verified_name: string | null;
  img_url: string | null;
  status: string | null;
  is_business: boolean;
  is_enterprise: boolean;
  verified: boolean;
  in_phone_book: boolean;
  known: boolean;
  about: string | null;
  push_name: string | null;
  formatted_name: string | null;
}

/** Full Baileys Contact (id, name, notify, imgUrl, status, ...) upsert. */
export async function upsertContact(c: {
  id: string;
  name?: string | null;
  notify?: string | null;
  imgUrl?: string | null;
  status?: string | null;
  isBusiness?: boolean;
  isEnterprise?: boolean;
  verifiedName?: string | null;
  verified?: boolean;
  inPhoneBook?: boolean;
  known?: boolean;
  pushName?: string | null;
  lid?: string | null;
}): Promise<void> {
  const jid = c.id;
  if (!jid) return;
  await sql`
    INSERT INTO contacts (
      jid, name, notify, avatar_url, img_url, status,
      is_business, is_enterprise, verified_name, verified, in_phone_book, known, push_name, lid
    ) VALUES (
      ${jid}, ${c.name ?? null}, ${c.notify ?? null}, ${c.imgUrl ?? null}, ${c.imgUrl ?? null},
      ${c.status ?? null}, ${!!c.isBusiness}, ${!!c.isEnterprise}, ${c.verifiedName ?? null},
      ${!!c.verified}, ${!!c.inPhoneBook}, ${!!c.known}, ${c.pushName ?? null}, ${c.lid ?? null}
    )
    ON CONFLICT (jid) DO UPDATE SET
      name = COALESCE(excluded.name, contacts.name),
      notify = COALESCE(excluded.notify, contacts.notify),
      avatar_url = COALESCE(excluded.avatar_url, contacts.avatar_url),
      img_url = COALESCE(excluded.img_url, contacts.img_url),
      status = COALESCE(excluded.status, contacts.status),
      is_business = excluded.is_business,
      is_enterprise = excluded.is_enterprise,
      verified_name = COALESCE(excluded.verified_name, contacts.verified_name),
      verified = excluded.verified,
      in_phone_book = excluded.in_phone_book,
      known = excluded.known,
      push_name = COALESCE(excluded.push_name, contacts.push_name),
      lid = COALESCE(excluded.lid, contacts.lid),
      updated_at = now()
  `;
}

/** Attach a label name to a contact's labels JSONB. */
export async function addContactLabel(
  jid: string,
  labelId: string,
  labelName: string,
): Promise<void> {
  await sql`
    INSERT INTO contacts (jid, labels)
    VALUES (${jid}, (jsonb_build_array(jsonb_build_object('id', ${labelId}::text, 'name', ${labelName}::text)))::jsonb)
    ON CONFLICT (jid) DO UPDATE SET
      labels = (
        SELECT jsonb_agg(x)
        FROM (
          SELECT e.value AS x
          FROM jsonb_array_elements(COALESCE(contacts.labels, '[]'::jsonb)) e
          WHERE e->>'id' <> ${labelId}::text
          UNION ALL
          SELECT jsonb_build_object('id', ${labelId}::text, 'name', ${labelName}::text)
        ) t
      ),
      updated_at = now()
  `;
}

/** Remove a label from a contact's labels JSONB. */
export async function removeContactLabel(
  jid: string,
  labelId: string,
): Promise<void> {
  await sql`
    UPDATE contacts SET
      labels = (
        SELECT COALESCE(jsonb_agg(e.value), '[]'::jsonb)
        FROM jsonb_array_elements(COALESCE(labels, '[]'::jsonb)) e
        WHERE e->>'id' <> ${labelId}
      ),
      updated_at = now()
    WHERE jid = ${jid}
  `;
}
export async function upsertContactMinimal(
  jid: string,
  name?: string | null,
  photoUrl?: string | null,
): Promise<void> {
  await sql`
    INSERT INTO contacts (jid, name, avatar_url)
    VALUES (${jid}, ${name ?? null}, ${photoUrl ?? null})
    ON CONFLICT (jid) DO UPDATE SET
      name = COALESCE(excluded.name, contacts.name),
      avatar_url = COALESCE(excluded.avatar_url, contacts.avatar_url),
      updated_at = now()
  `;
}

export async function getContact(jid: string): Promise<ContactRow | null> {
  const rows = await sql<ContactRow[]>`
    SELECT * FROM contacts WHERE jid = ${jid} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listContacts(): Promise<ContactRow[]> {
  return sql<ContactRow[]>`SELECT * FROM contacts ORDER BY name ASC NULLS LAST`;
}
