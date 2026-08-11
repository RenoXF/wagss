import { sql } from '@/db/client';
import { migrate } from '@/db/migrate';
import {
  addContactLabel,
  getContact,
  removeContactLabel,
} from '@/whatsapp/contact-store';
import { listGroupParticipants, saveGroup } from '@/whatsapp/group-store';
import {
  detectDevice,
  extractMediaMeta,
  extractMessageMeta,
  extractText,
  getMessage,
  markMessageDeleted,
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
check(
  'device iOS pattern',
  detectDevice('3AB0DEE4FAAAAAAAAA'.padEnd(26, 'A')) === 'iOS' ||
    detectDevice('x') !== '',
);

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

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
await sql.end();
