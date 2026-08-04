require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  AttachmentBuilder,
  TextChannel,
  VoiceChannel
} = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType
} = require('@discordjs/voice');
const prism = require('prism-media');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('ffmpeg-static');

// ===== متغيرات البيئة =====
const {
  BOT_TOKEN,
  GUILD_ID,
  RECORDING_CHANNEL_ID,
  TRANSCRIPT_CHANNEL_ID,
  OPENAI_API_KEY
} = process.env;

if (!BOT_TOKEN || !GUILD_ID || !RECORDING_CHANNEL_ID || !TRANSCRIPT_CHANNEL_ID || !OPENAI_API_KEY) {
  console.error('❌ تأكد من تعبئة جميع المتغيرات في ملف .env');
  process.exit(1);
}

// ===== إعدادات البوت =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ]
});

// ===== مجلد الملفات المؤقتة =====
const TEMP_DIR = path.join(__dirname, 'temp_audio');
if (!fsSync.existsSync(TEMP_DIR)) {
  fsSync.mkdirSync(TEMP_DIR, { recursive: true });
}

// ===== حالة البوت =====
let isRecording = false;
let recordingData = null; // { pcmPath, mp3Path, pcmStream, decoder, startTime }

// ===== دالة تنظيف الملفات المؤقتة =====
async function cleanTempFiles() {
  try {
    const files = await fs.readdir(TEMP_DIR);
    for (const file of files) {
      await fs.unlink(path.join(TEMP_DIR, file)).catch(() => {});
    }
  } catch (e) {}
}

// ===== بدء التسجيل =====
async function startRecording(guild, voiceChannel) {
  if (isRecording) {
    console.log('⚠️ التسجيل نشط بالفعل.');
    return;
  }

  // الاتصال بالروم الصوتي
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log(`✅ البوت متصل بالروم: ${voiceChannel.name}`);
  } catch (err) {
    console.error('❌ فشل الاتصال بالروم:', err);
    connection.destroy();
    return;
  }

  // إنشاء مسار الملفات المؤقتة
  const timestamp = Date.now();
  const pcmPath = path.join(TEMP_DIR, `rec_${timestamp}.pcm`);
  const mp3Path = path.join(TEMP_DIR, `rec_${timestamp}.mp3`);

  // كتابة PCM
  const pcmStream = fsSync.createWriteStream(pcmPath);

  // استخدام الـ receiver لجلب الصوت من جميع المستخدمين في القناة
  const receiver = connection.receiver;

  // نشترك في كل المستخدمين المتصلين حالياً
  const userIds = voiceChannel.members.map(m => m.id);
  const subscriptions = [];

  for (const userId of userIds) {
    const audioStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence },
    });
    if (!audioStream) continue;

    // فك تشفير Opus → PCM
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960
    });

    const pipeline = audioStream.pipe(decoder).pipe(pcmStream);
    subscriptions.push({ userId, audioStream, decoder, pipeline });
  }

  // استقبال الأعضاء الجدد الذين يدخلون أثناء التسجيل
  const voiceStateUpdateHandler = (oldState, newState) => {
    if (newState.channelId === voiceChannel.id && oldState.channelId !== voiceChannel.id) {
      const userId = newState.id;
      // تجنب الاشتراك المكرر
      if (subscriptions.some(s => s.userId === userId)) return;

      const audioStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence },
      });
      if (!audioStream) return;

      const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
      });
      const pipeline = audioStream.pipe(decoder).pipe(pcmStream);
      subscriptions.push({ userId, audioStream, decoder, pipeline });
      console.log(`➕ تم إضافة المستخدم ${userId} للتسجيل.`);
    }
  };

  client.on(Events.VoiceStateUpdate, voiceStateUpdateHandler);

  // حفظ البيانات
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
  console.log('🎙️ بدأ التسجيل في الروم.');
}

// ===== إيقاف التسجيل وتحويل الصوت =====
async function stopAndTranscribe(guild) {
  if (!isRecording || !recordingData) {
    console.log('⚠️ لا يوجد تسجيل نشط.');
    return;
  }

  const {
    pcmPath,
    mp3Path,
    pcmStream,
    subscriptions,
    connection,
    voiceStateUpdateHandler,
    startTime
  } = recordingData;

  // إلغاء الاشتراك من الاستماع للأحداث
  client.off(Events.VoiceStateUpdate, voiceStateUpdateHandler);

  // إغلاق التدفقات
  for (const sub of subscriptions) {
    try { sub.audioStream.destroy(); } catch (e) {}
    try { sub.decoder.destroy(); } catch (e) {}
    try { sub.pipeline.destroy(); } catch (e) {}
  }
  try { pcmStream.close(); } catch (e) {}

  // قطع الاتصال بالروم
  connection.destroy();

  isRecording = false;
  recordingData = null;

  // التحقق من وجود ملف PCM
  try {
    await fs.access(pcmPath);
  } catch {
    console.log('⚠️ لا يوجد ملف PCM للتسجيل.');
    await cleanTempFiles();
    return;
  }

  // تحويل PCM إلى MP3 باستخدام ffmpeg
  console.log('🔄 جاري تحويل الملف الصوتي إلى MP3...');
  try {
    await new Promise((resolve, reject) => {
      const ffmpegProcess = spawn(ffmpeg, [
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        '-i', pcmPath,
        '-acodec', 'libmp3lame',
        '-ab', '64k',
        '-y',
        mp3Path
      ]);
      ffmpegProcess.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg خرج بـ ${code}`));
      });
      ffmpegProcess.on('error', reject);
    });
  } catch (err) {
    console.error('❌ فشل تحويل الصوت:', err);
    await cleanTempFiles();
    return;
  }

  // حذف ملف PCM
  await fs.unlink(pcmPath).catch(() => {});

  // قراءة ملف MP3 وتحويله إلى نص عبر Whisper
  console.log('🔄 جاري تحويل الصوت إلى نص عبر Whisper...');
  let transcript = '';
  try {
    const mp3Buffer = await fs.readFile(mp3Path);
    const formData = new FormData();
    formData.append('file', mp3Buffer, { filename: 'audio.mp3' });
    formData.append('model', 'whisper-1');
    formData.append('language', 'ar');

    const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
      headers: {
        ...formData.getHeaders(),
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      timeout: 60000
    });
    transcript = response.data.text || '⚠️ لم يتم استخراج نص.';
  } catch (err) {
    console.error('❌ فشل تحويل الصوت لنص:', err.message);
    transcript = '⚠️ تعذر تحويل الصوت إلى نص (خطأ في API).';
  }

  // إرسال النص والملف إلى الروم النصي
  const transcriptChannel = guild.channels.cache.get(TRANSCRIPT_CHANNEL_ID);
  if (transcriptChannel && transcriptChannel.isTextBased()) {
    const duration = Math.floor((Date.now() - startTime) / 1000);
    const embed = new EmbedBuilder()
      .setColor(0x00ff88)
      .setTitle('📝 نص المكالمة المسجلة')
      .addFields(
        { name: 'المدة', value: `${duration} ثانية`, inline: true },
        { name: 'النص المستخلص', value: `\`\`\`\n${transcript.substring(0, 1900)}\n\`\`\`` }
      )
      .setTimestamp();

    const attachment = new AttachmentBuilder(mp3Path, { name: `recording_${Date.now()}.mp3` });
    await transcriptChannel.send({
      embeds: [embed],
      files: [attachment]
    });
    console.log('✅ تم إرسال النص والملف إلى قناة النصوص.');
  } else {
    console.error('❌ قناة النصوص غير موجودة أو غير صالحة.');
  }

  // تنظيف الملفات المؤقتة (نحتفظ بالـ MP3 إذا أردت، لكن سنحذفه بعد الإرسال)
  await fs.unlink(mp3Path).catch(() => {});
  await cleanTempFiles();
}

// ===== مراقبة دخول/خروج الأعضاء للبدء/الإيقاف =====
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;

  const voiceChannelId = RECORDING_CHANNEL_ID;
  const targetChannel = guild.channels.cache.get(voiceChannelId);
  if (!targetChannel) return;

  // التحقق مما إذا كان هناك أي عضو (غير البوت) في الروم
  const members = targetChannel.members.filter(m => !m.user.bot);
  const hasHumans = members.size > 0;

  if (hasHumans && !isRecording) {
    // بدء التسجيل إذا كان هناك بشر
    await startRecording(guild, targetChannel);
  } else if (!hasHumans && isRecording) {
    // إيقاف التسجيل إذا أصبح الروم فارغاً
    await stopAndTranscribe(guild);
  }
});

// ===== عند تشغيل البوت =====
client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 البوت شغال باسم ${c.user.tag}`);

  const guild = c.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.error('❌ السيرفر المحدد غير موجود.');
    return;
  }

  // تنظيف الملفات المؤقتة القديمة
  await cleanTempFiles();

  // التحقق من وجود بشر في الروم عند بدء التشغيل
  const voiceChannel = guild.channels.cache.get(RECORDING_CHANNEL_ID);
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

// ===== معالجة الأخطاء =====
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err);
});

client.login(BOT_TOKEN);
