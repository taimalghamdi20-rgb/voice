// لا حاجة لـ require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  AttachmentBuilder,
} = require('discord.js');
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType
} = require('@discordjs/voice');
const prism = require('prism-media');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const ffmpeg = require('ffmpeg-static');

// ===== قراءة المتغيرات مباشرة من process.env =====
const {
  BOT_TOKEN,
  GUILD_ID,
  RECORDING_CHANNEL,        // <- المطابق للصورة
  TRANSCRIPT_CHANNEL_ID,    // <- مطابق للصورة
} = process.env;

// التحقق من وجودها
if (!BOT_TOKEN || !GUILD_ID || !RECORDING_CHANNEL || !TRANSCRIPT_CHANNEL_ID) {
  console.error('❌ تأكد من تعبئة جميع المتغيرات في بيئة Render:');
  console.error('   BOT_TOKEN, GUILD_ID, RECORDING_CHANNEL, TRANSCRIPT_CHANNEL_ID');
  process.exit(1);
}

// ===== باقي الكود كما هو، مع استخدام RECORDING_CHANNEL بدلاً من RECORDING_CHANNEL_ID =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ]
});

const TEMP_DIR = path.join(__dirname, 'temp_audio');
if (!fsSync.existsSync(TEMP_DIR)) {
  fsSync.mkdirSync(TEMP_DIR, { recursive: true });
}

let isRecording = false;
let recordingData = null;

async function cleanTempFiles() {
  try {
    const files = await fs.readdir(TEMP_DIR);
    for (const file of files) {
      await fs.unlink(path.join(TEMP_DIR, file)).catch(() => {});
    }
  } catch (e) {}
}

async function startRecording(guild, voiceChannel) {
  if (isRecording) return;

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log(`✅ متصل بالروم: ${voiceChannel.name}`);
  } catch (err) {
    console.error('❌ فشل الاتصال:', err);
    connection.destroy();
    return;
  }

  const timestamp = Date.now();
  const pcmPath = path.join(TEMP_DIR, `rec_${timestamp}.pcm`);
  const mp3Path = path.join(TEMP_DIR, `rec_${timestamp}.mp3`);
  const pcmStream = fsSync.createWriteStream(pcmPath);

  const receiver = connection.receiver;
  const userIds = voiceChannel.members.map(m => m.id);
  const subscriptions = [];

  for (const userId of userIds) {
    if (userId === client.user.id) continue;
    const audioStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence },
    });
    if (!audioStream) continue;
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const pipeline = audioStream.pipe(decoder).pipe(pcmStream);
    subscriptions.push({ userId, audioStream, decoder, pipeline });
  }

  const voiceStateUpdateHandler = (oldState, newState) => {
    if (newState.channelId === voiceChannel.id && oldState.channelId !== voiceChannel.id) {
      const userId = newState.id;
      if (userId === client.user.id) return;
      if (subscriptions.some(s => s.userId === userId)) return;
      const audioStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence },
      });
      if (!audioStream) return;
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      const pipeline = audioStream.pipe(decoder).pipe(pcmStream);
      subscriptions.push({ userId, audioStream, decoder, pipeline });
      console.log(`➕ تم إضافة المستخدم ${userId} للتسجيل.`);
    }
  };

  client.on(Events.VoiceStateUpdate, voiceStateUpdateHandler);

  recordingData = {
    pcmPath,
    mp3Path,
    pcmStream,
    subscriptions,
    connection,
    voiceStateUpdateHandler,
    startTime: Date.now()
  };

  isRecording = true;
  console.log('🎙️ بدأ التسجيل.');
}

async function stopAndSendRecording(guild) {
  if (!isRecording || !recordingData) return;

  const {
    pcmPath, mp3Path, pcmStream, subscriptions,
    connection, voiceStateUpdateHandler, startTime
  } = recordingData;

  client.off(Events.VoiceStateUpdate, voiceStateUpdateHandler);

  for (const sub of subscriptions) {
    try { sub.audioStream.destroy(); } catch (e) {}
    try { sub.decoder.destroy(); } catch (e) {}
    try { sub.pipeline.destroy(); } catch (e) {}
  }
  try { pcmStream.close(); } catch (e) {}

  connection.destroy();
  isRecording = false;
  recordingData = null;

  try { await fs.access(pcmPath); } catch {
    console.log('⚠️ لا يوجد ملف PCM.');
    await cleanTempFiles();
    return;
  }

  console.log('🔄 جاري تحويل الصوت إلى MP3...');
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpeg, [
        '-f', 's16le', '-ar', '48000', '-ac', '2',
        '-i', pcmPath,
        '-acodec', 'libmp3lame', '-ab', '64k', '-y', mp3Path
      ]);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg خرج بـ ${code}`)));
      proc.on('error', reject);
    });
  } catch (err) {
    console.error('❌ فشل تحويل الصوت:', err);
    await cleanTempFiles();
    return;
  }

  await fs.unlink(pcmPath).catch(() => {});

  const duration = Math.floor((Date.now() - startTime) / 1000);
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;
  const durationText = mins > 0 ? `${mins} دقيقة و ${secs} ثانية` : `${secs} ثانية`;

  const transcriptChannel = guild.channels.cache.get(TRANSCRIPT_CHANNEL_ID);
  if (transcriptChannel && transcriptChannel.isTextBased()) {
    const embed = new EmbedBuilder()
      .setColor(0x00ff88)
      .setTitle('🎙️ تسجيل مكالمة صوتية')
      .addFields(
        { name: 'المدة', value: durationText, inline: true },
        { name: 'الروم', value: `<#${RECORDING_CHANNEL}>`, inline: true }
      )
      .setTimestamp();

    const attachment = new AttachmentBuilder(mp3Path, { name: `recording_${Date.now()}.mp3` });
    await transcriptChannel.send({ embeds: [embed], files: [attachment] });
    console.log('✅ تم إرسال الملف الصوتي.');
  } else {
    console.error('❌ قناة النصوص غير موجودة.');
  }

  await fs.unlink(mp3Path).catch(() => {});
  await cleanTempFiles();
}

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;

  const voiceChannel = guild.channels.cache.get(RECORDING_CHANNEL);
  if (!voiceChannel || voiceChannel.type !== 2) return;

  const members = voiceChannel.members.filter(m => !m.user.bot);
  const hasHumans = members.size > 0;

  if (hasHumans && !isRecording) {
    await startRecording(guild, voiceChannel);
  } else if (!hasHumans && isRecording) {
    await stopAndSendRecording(guild);
  }
});

client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 البوت شغال باسم ${c.user.tag}`);
  const guild = c.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.error('❌ السيرفر المحدد غير موجود.');
    return;
  }

  await cleanTempFiles();
  const voiceChannel = guild.channels.cache.get(RECORDING_CHANNEL);
  if (voiceChannel && voiceChannel.type === 2) {
    const members = voiceChannel.members.filter(m => !m.user.bot);
    if (members.size > 0) {
      await startRecording(guild, voiceChannel);
    } else {
      console.log('⏳ الروم فارغ، بانتظار دخول أحد.');
    }
  } else {
    console.error('❌ الروم الصوتي المحدد غير موجود أو ليس صوتياً.');
  }
});

process.on('unhandledRejection', (reason) => console.error('⚠️ Unhandled Rejection:', reason));
process.on('uncaughtException', (err) => console.error('⚠️ Uncaught Exception:', err));

client.login(BOT_TOKEN);
