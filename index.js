// ... (نفس الإعدادات الأولى) ...

// ===== متغير لتتبع محاولة الاتصال =====
let connectingAttempt = false;

async function startRecording(guild, voiceChannel) {
  if (isRecording) return;
  if (connectingAttempt) {
    console.log('⏳ جاري الاتصال بالفعل، انتظر...');
    return;
  }

  connectingAttempt = true;

  // التأكد من عدم وجود اتصال مسبق في هذه القناة
  const existingConnection = getVoiceConnection(guild.id);
  if (existingConnection) {
    console.log('⚠️ يوجد اتصال صوتي مسبق، سيتم تدميره.');
    try {
      existingConnection.destroy();
    } catch (e) {
      console.log('⚠️ فشل تدمير الاتصال المسبق:', e.message);
    }
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true
  });

  // معالجة أحداث الاتصال
  connection.on('error', (error) => {
    console.error('🔴 خطأ في الاتصال الصوتي:', error);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    console.log('🔌 انقطع الاتصال، جاري إعادة المحاولة...');
    try {
      await entersState(connection, VoiceConnectionStatus.Connecting, 5000);
    } catch {
      console.log('❌ فشل إعادة الاتصال، سيتم تدمير الاتصال.');
      try { connection.destroy(); } catch (e) {}
    }
  });

  try {
    // زيادة المهلة إلى 30 ثانية
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    console.log(`✅ متصل بالروم: ${voiceChannel.name}`);
  } catch (err) {
    console.error('❌ فشل الاتصال:', err.message);
    // التدمير فقط إذا كان الاتصال لا يزال موجوداً ولم يتم تدميره
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        connection.destroy();
      } catch (e) {
        console.log('⚠️ فشل تدمير الاتصال (ربما دمر مسبقاً):', e.message);
      }
    }
    connectingAttempt = false;
    return;
  }

  // ... باقي الكود (إنشاء التدفقات، التسجيل، إلخ) ...
  // (نفس الكود السابق من هنا)

  // عند الانتهاء بنجاح، نعيد تعيين connectingAttempt
  connectingAttempt = false;
}

// ===== تعديل دالة stopAndSendRecording =====
// التأكد من تدمير الاتصال فقط إذا كان موجوداً ولم يدمّر
async function stopAndSendRecording(guild) {
  if (!isRecording || !recordingData) return;

  const {
    pcmPath, mp3Path, pcmStream, subscriptions,
    connection, voiceStateUpdateHandler, startTime
  } = recordingData;

  // إلغاء الاشتراك من الأحداث
  client.off(Events.VoiceStateUpdate, voiceStateUpdateHandler);

  // إغلاق التدفقات
  for (const sub of subscriptions) {
    try { sub.audioStream.destroy(); } catch (e) {}
    try { sub.decoder.destroy(); } catch (e) {}
    try { sub.pipeline.destroy(); } catch (e) {}
  }
  try { pcmStream.close(); } catch (e) {}

  // تدمير الاتصال إذا كان موجوداً ولم يدمّر
  if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
    try {
      connection.destroy();
    } catch (e) {
      console.log('⚠️ فشل تدمير الاتصال (ربما دمر مسبقاً):', e.message);
    }
  }

  isRecording = false;
  recordingData = null;
  connectingAttempt = false;

  // ... باقي الكود (تحويل الصوت وإرساله) ...
  // (نفس الكود السابق)
}

// ===== تعديل حدث VoiceStateUpdate لتجنب المحاولات المتكررة =====
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

// ===== في ClientReady =====
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
    if (members.size > 0 && !isRecording && !connectingAttempt) {
      await startRecording(guild, voiceChannel);
    } else {
      console.log('⏳ الروم فارغ أو جاري الاتصال، بانتظار دخول أحد.');
    }
  } else {
    console.error('❌ الروم الصوتي المحدد غير موجود أو ليس صوتياً.');
  }
});
