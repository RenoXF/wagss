import { sql } from '@/db/client';
import { migrate } from '@/db/migrate';
import {
  addContactLabel,
  getContact,
  removeContactLabel,
  resolveDisplayName,
  saveLidMappings,
  upsertContact,
  upsertContactMinimal,
} from '@/whatsapp/contact-store';
import { listGroupParticipants, saveGroup } from '@/whatsapp/group-store';
import {
  detectDevice,
  extractMediaMeta,
  extractMessageMeta,
  extractText,
  getMessage,
  markMessageDeleted,
  searchMessages,
  starMessage,
  updateMessageEdited,
  upsertMessage,
} from '@/whatsapp/message-store';
import { listReactions, saveReaction } from '@/whatsapp/reaction-store';
import { listMessageStatus, saveStatus } from '@/whatsapp/status-store';

let failed = 0;
const check = (name: string, cond: boolean) => {
  if (!cond) {
    failed++;
    console.error(`FAIL: ${name}`);
  } else {
    console.log(`ok: ${name}`);
  }
};

await migrate();

// extract helpers
const meta = extractMessageMeta({
  key: {
    id: '3EB0DEE4FAAAAAAAAAAAAAAAAAAAAAAAAA',
    remoteJid: 'x@s.whatsapp.net',
  },
  messageTimestamp: 1700000000,
  message: {
    extendedTextMessage: {
      text: 'halo',
      contextInfo: { stanzaId: 'q1', isForwarded: true },
    },
  },
});
check('message_type=extendedText', meta.message_type === 'extendedText');
check('text extracted', meta.message_text === 'halo');
check('forwarded', meta.forwarded === true);
check('quoted id', meta.quoted_message_id === 'q1');
check('device Android-ish', typeof meta.device === 'string');

const mediaMeta = extractMediaMeta({
  message: {
    imageMessage: {
      mimetype: 'image/jpeg',
      fileLength: 12345,
      width: 100,
      height: 200,
      viewOnce: true,
    },
  },
});
check('media type image', mediaMeta.media_type === 'image');
check('media mime', mediaMeta.media_mime_type === 'image/jpeg');
check('media size', mediaMeta.media_size === 12345);
check('view_once', mediaMeta.view_once === true);

const dev = (id: string) => detectDevice(id);
check('device ios', dev('3A' + 'A'.repeat(18)) === 'ios');
check('device web', dev('3E' + 'A'.repeat(20)) === 'web');
check('device android-21', dev('A'.repeat(21)) === 'android');
check('device android-32', dev('A'.repeat(32)) === 'android');
check('device desktop-3f', dev('3F' + 'A'.repeat(5)) === 'desktop');
check('device desktop-18', dev('A'.repeat(18)) === 'desktop');
check('device unknown', dev('') === 'unknown');

// reactions
const rid = `chat1-${Date.now()}`;
await saveReaction({
  key: { id: rid, remoteJid: 'chat1@s.whatsapp.net' },
  reaction: { text: '👍', timestamp: Date.now() },
} as never);
const reacts = await listReactions('chat1@s.whatsapp.net', rid);
check(
  'reaction saved',
  reacts.length === 1 && reacts[0]!.reaction_text === '👍',
);
await saveReaction({
  key: { id: rid, remoteJid: 'chat1@s.whatsapp.net' },
  reaction: { text: '👍', timestamp: Date.now() },
} as never);
await saveReaction({
  key: { id: rid, remoteJid: 'chat1@s.whatsapp.net' },
  reaction: { text: null },
} as never);
const after = await listReactions('chat1@s.whatsapp.net', rid);
check('reaction removed on null text', after.length === 0);

// status timeline
const sid = `st-${Date.now()}`;
await saveStatus({
  key: { id: sid, remoteJid: 'c2@s.whatsapp.net' },
  update: { status: 2 },
} as never);
await saveStatus({
  key: { id: sid, remoteJid: 'c2@s.whatsapp.net' },
  update: { status: 4 },
} as never);
const statuses = await listMessageStatus('c2@s.whatsapp.net', sid);
check(
  'status sent',
  statuses.some((s) => s.status === 'sent'),
);
check(
  'status read',
  statuses.some((s) => s.status === 'read'),
);

// groups
const gid = `g-${Date.now()}@g.us`;
await saveGroup({
  id: gid,
  subject: 'Tim Test',
  participants: [
    { id: 'a@s.whatsapp.net', admin: 'admin' },
    { id: 'b@s.whatsapp.net' },
  ],
});
const parts = await listGroupParticipants(gid);
check('group participants saved', parts.length === 2);

// message edit + delete
const mid = `ed-${Date.now()}`;
const chatc = 'edchat@s.whatsapp.net';
await upsertMessage({
  key: { id: mid, remoteJid: chatc, fromMe: false },
  messageTimestamp: Math.floor(Date.now() / 1000),
  message: { conversation: 'original' },
});
await updateMessageEdited(chatc, mid, {
  key: { id: mid, remoteJid: chatc },
  messageTimestamp: Math.floor(Date.now() / 1000),
  message: { conversation: 'edited text' },
});
const edited = await getMessage(`${chatc}-${mid}`);
check(
  'message edited text',
  !!(
    (edited as unknown as { message?: any })?.message?.message?.conversation ===
    'edited text'
  ),
);
check(
  'message edited flag',
  !!(edited as unknown as { edited_at?: number | null }).edited_at,
);

await markMessageDeleted(chatc, mid);
const del = await getMessage(`${chatc}-${mid}`);
check(
  'message marked deleted',
  !!(del as unknown as { deleted?: boolean }).deleted,
);
// deleted message row still intact
check(
  'deleted row not removed',
  !!del && !!(del as unknown as { deleted?: boolean }).deleted,
);

// star + search
const searchChat = 'search@s.whatsapp.net';
const s1 = `s1-${Date.now()}`;
const s2 = `s2-${Date.now()}`;
await upsertMessage({
  key: { id: s1, remoteJid: searchChat, fromMe: true },
  messageTimestamp: Math.floor(Date.now() / 1000),
  message: { conversation: 'cari kata unik-xyz' },
});
await upsertMessage({
  key: { id: s2, remoteJid: searchChat, fromMe: false },
  messageTimestamp: Math.floor(Date.now() / 1000),
  message: { conversation: 'pesan lain biasa' },
});
const found = await searchMessages('unik-xyz');
check(
  'search finds message',
  found.length >= 1 && found[0]!.chat_jid === searchChat,
);
await starMessage(searchChat, s1, true);
const starred = await getMessage(`${searchChat}-${s1}`);
check('starred true', !!(starred as unknown as { starred?: boolean }).starred);
await starMessage(searchChat, s1, false);
const unstarred = await getMessage(`${searchChat}-${s1}`);
check('unstarred', !(unstarred as unknown as { starred?: boolean }).starred);

// contact labels
const cjid = 'label@s.whatsapp.net';
await addContactLabel(cjid, 'L1', 'Penting');
await addContactLabel(cjid, 'L2', 'Bisnis');
let c = await getContact(cjid);
check(
  'label attached',
  Array.isArray((c as any)?.labels) && (c as any).labels.length === 2,
);
await removeContactLabel(cjid, 'L1');
c = await getContact(cjid);
check(
  'label removed',
  Array.isArray((c as any)?.labels) && (c as any).labels.length === 1,
);

// LID mapping + display name resolve
await saveLidMappings([{ lid: '654321@lid', pn: '654321@s.whatsapp.net' }]);
await upsertContact({
  id: '654321@s.whatsapp.net',
  name: 'Si LID',
} as { id: string });
const lidName = await resolveDisplayName('654321@lid');
check('lid resolves to PN name', lidName === 'Si LID');
const pnName = await resolveDisplayName('654321@s.whatsapp.net');
check('pn resolves own name', pnName === 'Si LID');

// is_group fix
await upsertContactMinimal('120123456789@g.us', 'Grup Tes');
const g = await getContact('120123456789@g.us');
check('g.us is_group', !!(g as unknown as { is_group?: boolean }).is_group);
await upsertContactMinimal('62811111@s.whatsapp.net', 'Org');
const p = await getContact('62811111@s.whatsapp.net');
check('pn not group', !(p as unknown as { is_group?: boolean }).is_group);

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');

// Cleanup test rows so they never leak into the real chat list.
await sql`
  DELETE FROM messages
  WHERE chat_jid IN ('search@s.whatsapp.net','edchat@s.whatsapp.net','c2@s.whatsapp.net','chat1@s.whatsapp.net')
     OR id LIKE 's1-%' OR id LIKE 's2-%' OR id LIKE 'ed-%' OR id LIKE 'st-%'
     OR id LIKE 'chat1-%'
`;
await sql`DELETE FROM message_reactions WHERE message_id LIKE 'chat1-%'`;
await sql`DELETE FROM message_status WHERE message_id LIKE 'st-%'`;
await sql`DELETE FROM whatsapp_groups WHERE group_id LIKE 'g-%@g.us'`;
await sql`DELETE FROM group_participants WHERE group_id LIKE 'g-%@g.us'`;
await sql`
  DELETE FROM contacts
  WHERE jid IN ('label@s.whatsapp.net','a@s.whatsapp.net','b@s.whatsapp.net','654321@s.whatsapp.net','120123456789@g.us','62811111@s.whatsapp.net','search@s.whatsapp.net','edchat@s.whatsapp.net')
`;
await sql`DELETE FROM lid_pn_mapping WHERE lid = '654321@lid'`;
await sql.end();
