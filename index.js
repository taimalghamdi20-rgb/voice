// ===== استيراد المكتبات =====
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  AttachmentBuilder,
} = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const ffmpeg = require('ffmpeg-static');

// ===== المتغيرات البيئية =====
const {
  BOT_TOKEN,
  GUILD_ID,
  RECORDING_CHANNEL,
  TRANSCRIPT_CHANNEL_ID,
} = process.env;

if (!BOT_TOKEN || !GUILD_ID || !RECORDING_CHANNEL || !TRANSCRIPT_CHANNEL_ID) {
  console.error('❌ تأكد من تعبئة جميع المتغيرات:');
  console.error('   BOT_TOKEN, GUILD_ID, RECORDING_CHANNEL, TRANSCRIPT_CHANNEL_ID');
  process.exit(1);
}

// ===== إعدادات البوت =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// ===== مجلد الملفات المؤقتة =====
const TEMP_DIR = path.join(__dirname, 'temp_audio');
if (!fsSync.existsSync(TEMP_DIR)) {
  fsSync.mkdirSync(TEMP_DIR, { recursive: true });
}

// ===== حالة البوت =====
let isRecording = false;
let connectingAttempt = false;
let recordingData = null;

// ===== تنظيف الملفات المؤقتة =====
async function cleanTempFiles() {
  try {
    const files = await fs.readdir(TEMP_DIR);
    for (const file of files) {
      await fs.unlink(path.join(TEMP_DIR, file)).catch(() => {});
    }
  } catch (e) {}
}

// ===== دالة انتظار جاهزية الاتصال مع إعادة المحاولة =====
async function waitForVoiceConnection(connection, timeout = 60000) {
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, timeout);
    return true;
  } catch (err) {
    console.error(`⚠️ فشل انتظار الجاهزية: ${err.message}`);
    return false;
  }
}

// ===== دالة الاشتراك في صوت المستخدمين مع إعادة المحاولة =====
async function subscribeToUsers(receiver, userIds, pcmStream, retries = 2) {
  const subscriptions = [];
  for (const userId of userIds) {
    if (userId === client.user.id) continue;
    let success = false;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const audioStream = receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence },
        });
        if (audioStream) {
          const decoder = new prism.opus.Decoder({
            rate: 48000,
            channels: 2,
            frameSize: 960,
          });
          const pipeline = audioStream.pipe(decoder).pipe(pcmStream);
          subscriptions.push({ userId, audioStream, decoder, pipeline });
          console.log(`✅ تم الاشتراك في المستخدم ${userId} (محاولة ${attempt})`);
          success = true;
          break;
        }
      } catch (err) {
        console.warn(`⚠️ فشل الاشتراك في ${userId} (محاولة ${attempt}): ${err.message}`);
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    if (!success) {
      console.warn(`❌ تعذر الاشتراك في المستخدم ${userId} بعد ${retries} محاولات.`);
    }
  }
  return subscriptions;
}

// ===== بدء التسجيل =====
async function startRecording(guild, voiceChannel) {
  if (isRecording) return;
  if (connectingAttempt) {
    console.log('⏳ جاري الاتصال بالفعل، انتظر...');
    return;
  }

  connectingAttempt = true;

  // حذف اتصال سابق إن وجد
  const existingConnection = getVoiceConnection(guild.id);
  if (existingConnection) {
    console.log('⚠️ يوجد اتصال مسبق، سيتم تدميره.');
    try { existingConnection.destroy(); } catch (e) {}
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  connection.setMaxListeners(20);

  // مستمعي الأحداث
  const onError = (error) => {
    console.error('🔴 خطأ في الاتصال:', error);
  };
  const onDisconnected = async () => {
    console.log('🔌 انقطع الاتصال، جاري إعادة المحاولة...');
    try {
      await entersState(connection, VoiceConnectionStatus.Connecting, 5000);
    } catch {
      console.log('❌ فشل إعادة الاتصال، سيتم تدمير الاتصال.');
      try { connection.destroy(); } catch (e) {}
    }
  };

  connection.on('error', onError);
  connection.on(VoiceConnectionStatus.Disconnected, onDisconnected);

  // انتظار الجاهزية
  console.log('⏳ جاري الاتصال بالروم الصوتي...');
  const ready = await waitForVoiceConnection(connection, 60000);
  if (!ready) {
    console.error('❌ فشل الاتصال بسبب المهلة.');
    try {
      connection.off('error', onError);
      connection.off(VoiceConnectionStatus.Disconnected, onDisconnected);
      connection.destroy();
    } catch (e) {}
    connectingAttempt = false;
    return;
  }

  console.log(`✅ متصل بالروم: ${voiceChannel.name}`);

  // إنشاء ملفات التسجيل
  const timestamp = Date.now();
  const pcmPath = path.join(TEMP_DIR, `rec_${timestamp}.pcm`);
  const mp3Path = path.join(TEMP_DIR, `rec_${timestamp}.mp3`);
  const pcmStream = fsSync.createWriteStream(pcmPath);

  // الحصول على قائمة المستخدمين (غير البوت)
  const members = voiceChannel.members.filter(m => !m.user.bot);
  if (members.size === 0) {
    console.log('⚠️ لا يوجد أعضاء في الروم، سيتم إنهاء الاتصال.');
    try { connection.destroy(); } catch (e) {}
    connectingAttempt = false;
    return;
  }

  const userIds = members.map(m => m.id);
  console.log(`👤 عدد المستخدمين في الروم: ${userIds.length}`);

  // الاشتراك في الصوت
  const receiver = connection.receiver;
  // نعطي وقتاً للمستقبل ليكون جاهزاً
  await new Promise(resolve => setTimeout(resolve, 1500));

  const subscriptions = await subscribeToUsers(receiver, userIds, pcmStream, 3);

  if (subscriptions.length === 0) {
    console.error('❌ لم يتم الاشتراك في أي مستخدم. لن يتم التسجيل.');
    try { pcmStream.close(); } catch (e) {}
    try { connection.destroy(); } catch (e) {}
    connectingAttempt = false;
    // إرسال تنبيه في قناة النصوص
    const transcriptChannel = guild.channels.cache.get(TRANSCRIPT_CHANNEL_ID);
    if (transcriptChannel?.isTextBased()) {
      await transcriptChannel.send({
        content: `⚠️ فشل البدء في التسجيل في <#${RECORDING_CHANNEL}>، لم يتم العثور على تدفقات صوتية. تأكد من أن البوت لديه الصلاحيات اللازمة.`
      }).catch(() => {});
    }
    return;
  }

  // متابعة الأعضاء الجدد
  const voiceStateUpdateHandler = (oldState, newState) => {
    if (newState.channelId === voiceChannel.id && oldState.channelId !== voiceChannel.id) {
      const userId = newState.id;
      if (userId === client.user.id) return;
      if (subscriptions.some(s => s.userId === userId)) return;
      try {
        const audioStream = receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence },
        });
        if (!audioStream) return;
        const decoder = new prism.opus.Decoder({
          rate: 48000,
          channels: 2,
          frameSize: 960,
        });
        const pipeline = audioStream.pipe(decoder).pipe(pcmStream);
        subscriptions.push({ userId, audioStream, decoder, pipeline });
        console.log(`➕ تم إضافة المستخدم ${userId} للتسجيل.`);
      } catch (err) {
        console.error(`❌ فشل إضافة المستخدم ${userId}:`, err.message);
      }
    }
  };

  client.on(Events.VoiceStateUpdate, voiceStateUpdateHandler);

  // حفظ بيانات الجلسة
  recordingData = {
    pcmPath,
    mp3Path,
    pcmStream,
    subscriptions,
    connection,
    voiceStateUpdateHandler,
    startTime: Date.now(),
    listeners: { onError, onDisconnected },
  };

  isRecording = true;
  connectingAttempt = false;
  console.log(`🎙️ بدأ التسجيل (${subscriptions.length} مستخدمين).`);
}

// ===== إيقاف التسجيل وتحويل الصوت وإرساله =====
async function stopAndSendRecording(guild) {
  if (!isRecording || !recordingData) {
    console.log('⚠️ لا يوجد تسجيل نشط أو بيانات مفقودة.');
    return;
  }

  const {
    pcmPath,
    mp3Path,
    pcmStream,
    subscriptions,
    connection,
    voiceStateUpdateHandler,
    startTime,
    listeners,
  } = recordingData;

  // إلغاء الاشتراك من الحدث
  client.off(Events.VoiceStateUpdate, voiceStateUpdateHandler);

  // إغلاق التدفقات
  for (const sub of subscriptions) {
    try { sub.audioStream.destroy(); } catch (e) {}
    try { sub.decoder.destroy(); } catch (e) {}
    try { sub.pipeline.destroy(); } catch (e) {}
  }
  try { pcmStream.close(); } catch (e) {}

  // إزالة المستمعين وتدمير الاتصال
  if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
    try {
      if (listeners) {
        connection.off('error', listeners.onError);
        connection.off(VoiceConnectionStatus.Disconnected, listeners.onDisconnected);
      }
      connection.destroy();
    } catch (e) {
      console.log('⚠️ فشل تدمير الاتصال:', e.message);
    }
  }

  isRecording = false;
  const data = recordingData;
  recordingData = null;
  connectingAttempt = false;

  // التحقق من وجود ملف PCM
  try {
    await fs.access(pcmPath);
  } catch {
    console.log('⚠️ لا يوجد ملف PCM للتسجيل.');
    await cleanTempFiles();
    return;
  }

  // تحويل PCM → MP3
  console.log('🔄 جاري تحويل الصوت إلى MP3...');
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
        mp3Path,
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

  await fs.unlink(pcmPath).catch(() => {});

  // حساب المدة
  const duration = Math.floor((Date.now() - startTime) / 1000);
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;
  const durationText = mins > 0 ? `${mins} دقيقة و ${secs} ثانية` : `${secs} ثانية`;

  // إرسال الملف إلى قناة النصوص
  const transcriptChannel = guild.channels.cache.get(TRANSCRIPT_CHANNEL_ID);
  if (transcriptChannel?.isTextBased()) {
    const embed = new EmbedBuilder()
      .setColor(0x00ff88)
      .setTitle('🎙️ تسجيل مكالمة صوتية')
      .addFields(
        { name: 'المدة', value: durationText, inline: true },
        { name: 'الروم', value: `<#${RECORDING_CHANNEL}>`, inline: true },
        { name: 'عدد المستخدمين', value: `${data.subscriptions.length}`, inline: true }
      )
      .setTimestamp();

    const attachment = new AttachmentBuilder(mp3Path, { name: `recording_${Date.now()}.mp3` });
    await transcriptChannel.send({
      embeds: [embed],
      files: [attachment],
    });
    console.log('✅ تم إرسال الملف الصوتي إلى قناة النصوص.');
  } else {
    console.error('❌ قناة النصوص غير موجودة أو غير صالحة.');
  }

  await fs.unlink(mp3Path).catch(() => {});
  await cleanTempFiles();
}

// ===== مراقبة دخول/خروج الأعضاء =====
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;

  const voiceChannel = guild.channels.cache.get(RECORDING_CHANNEL);
  if (!voiceChannel || voiceChannel.type !== 2) return;

  const members = voiceChannel.members.filter(m => !m.user.bot);
  const hasHumans = members.size > 0;

  if (hasHumans && !isRecording && !connectingAttempt) {
    await startRecording(guild, voiceChannel);
  } else if (!hasHumans && isRecording) {
    await stopAndSendRecording(guild);
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

  await cleanTempFiles();

  const voiceChannel = guild.channels.cache.get(RECORDING_CHANNEL);
  if (voiceChannel?.type === 2) {
    const members = voiceChannel.members.filter(m => !m.user.bot);
    if (members.size > 0 && !isRecording && !connectingAttempt) {
      await startRecording(guild, voiceChannel);
    } else {
      console.log('⏳ الروم فارغ أو جاري الاتصال، بانتظار دخول أحد.');
    }
  } else {
    console.error('❌ الروم الصوتي المحدد غير موجود أو ليس صوتياً.');
  }
});

// ===== معالجة الأخطاء غير المتوقعة =====
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err);
});

// ===== تشغيل البوت =====
client.login(BOT_TOKEN);
